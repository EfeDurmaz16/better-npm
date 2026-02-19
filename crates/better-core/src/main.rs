use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Instant;

use better_core::*;

#[derive(Debug)]
enum Command {
    Analyze { root: PathBuf, graph: bool },
    Scan { root: PathBuf },
    Materialize {
        src: PathBuf,
        dest: PathBuf,
        link_strategy: LinkStrategy,
        jobs: usize,
        profile: MaterializeProfile,
    },
    Install {
        lockfile: PathBuf,
        project_root: PathBuf,
        cache_root: PathBuf,
        link_strategy: LinkStrategy,
        jobs: usize,
    },
    Version,
    Help { error: Option<String> },
}

fn default_cache_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    #[cfg(target_os = "macos")]
    {
        PathBuf::from(home).join("Library/Caches/better")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(home).join("AppData/Local"))
            .join("better/cache")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(home).join(".cache"))
            .join("better")
    }
}

fn parse_args() -> Command {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return Command::Help { error: None };
    }
    if args[0] == "version" || args[0] == "--version" || args[0] == "-V" {
        return Command::Version;
    }
    if args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
        return Command::Help { error: None };
    }

    let sub = args[0].as_str();
    let mut root: Option<PathBuf> = None;
    let mut graph = false;
    let mut src: Option<PathBuf> = None;
    let mut dest: Option<PathBuf> = None;
    let mut link_strategy = LinkStrategy::Auto;
    let mut jobs = std::thread::available_parallelism()
        .map(|n| n.get().saturating_mul(2))
        .unwrap_or(8);
    jobs = jobs.clamp(1, 64);
    let mut profile = MaterializeProfile::Auto;
    let mut lockfile: Option<PathBuf> = None;
    let mut project_root: Option<PathBuf> = None;
    let mut cache_root: Option<PathBuf> = None;
    let mut i = 1usize;
    while i < args.len() {
        match args[i].as_str() {
            "--root" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--root requires a value".to_string()),
                    };
                }
                root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--graph" => {
                graph = true;
                i += 1;
            }
            "--no-graph" => {
                graph = false;
                i += 1;
            }
            "--src" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--src requires a value".to_string()),
                    };
                }
                src = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--dest" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--dest requires a value".to_string()),
                    };
                }
                dest = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--link-strategy" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--link-strategy requires a value".to_string()),
                    };
                }
                let raw = args[i + 1].as_str();
                match LinkStrategy::from_arg(raw) {
                    Some(s) => link_strategy = s,
                    None => {
                        return Command::Help {
                            error: Some(format!(
                                "unknown --link-strategy '{raw}' (expected auto|hardlink|copy)"
                            )),
                        }
                    }
                }
                i += 2;
            }
            "--jobs" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--jobs requires a value".to_string()),
                    };
                }
                let raw = args[i + 1].as_str();
                match raw.parse::<usize>() {
                    Ok(parsed) if parsed > 0 => jobs = parsed.clamp(1, 256),
                    _ => {
                        return Command::Help {
                            error: Some(format!("invalid --jobs '{raw}' (expected positive integer)")),
                        }
                    }
                }
                i += 2;
            }
            "--profile" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--profile requires a value".to_string()),
                    };
                }
                let raw = args[i + 1].as_str();
                match MaterializeProfile::from_arg(raw) {
                    Some(p) => profile = p,
                    None => {
                        return Command::Help {
                            error: Some(format!(
                                "unknown --profile '{raw}' (expected auto|io-heavy|small-files)"
                            )),
                        }
                    }
                }
                i += 2;
            }
            "--lockfile" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--lockfile requires a value".to_string()),
                    };
                }
                lockfile = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--project-root" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--project-root requires a value".to_string()),
                    };
                }
                project_root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--cache-root" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--cache-root requires a value".to_string()),
                    };
                }
                cache_root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            other => {
                return Command::Help {
                    error: Some(format!("unknown flag: {other}")),
                };
            }
        }
    }

    match sub {
        "analyze" => match root {
            Some(r) => Command::Analyze { root: r, graph },
            None => Command::Help {
                error: Some("analyze requires --root".to_string()),
            },
        },
        "scan" => match root {
            Some(r) => Command::Scan { root: r },
            None => Command::Help {
                error: Some("scan requires --root".to_string()),
            },
        },
        "materialize" => match (src, dest) {
            (Some(src), Some(dest)) => Command::Materialize {
                src,
                dest,
                link_strategy,
                jobs,
                profile,
            },
            _ => Command::Help {
                error: Some("materialize requires --src <path> and --dest <path>".to_string()),
            },
        },
        "install" => {
            let lockfile = lockfile.unwrap_or_else(|| PathBuf::from("package-lock.json"));
            let project_root = project_root.unwrap_or_else(|| PathBuf::from("."));
            let cache_root = cache_root.unwrap_or_else(default_cache_root);
            Command::Install {
                lockfile,
                project_root,
                cache_root,
                link_strategy,
                jobs,
            }
        }
        _ => Command::Help {
            error: Some(format!("unknown command: {sub}")),
        },
    }
}

fn print_help(error: Option<String>) {
    if let Some(e) = error {
        eprintln!("error: {e}\n");
    }
    println!(
        "better-core {VERSION}

Usage:
  better-core analyze --root <path> [--graph]
  better-core scan --root <path>
  better-core materialize --src <path> --dest <path> [--link-strategy auto|hardlink|copy] [--jobs N] [--profile auto|io-heavy|small-files]
  better-core install [--lockfile <path>] [--project-root <path>] [--cache-root <path>] [--link-strategy auto|hardlink|copy] [--jobs N]
  better-core version
"
    );
}

fn main() {
    match parse_args() {
        Command::Version => {
            println!("{VERSION}");
        }
        Command::Help { error } => {
            print_help(error);
            std::process::exit(2);
        }
        Command::Scan { root } => {
            let mut seen: HashSet<(u64, u64)> = HashSet::new();
            match scan_tree(&root, &HashSet::new(), Some(&mut seen)) {
                Ok(agg) => {
                    print!("{}", write_scan_json(&root, &agg, true, None));
                }
                Err(e) => {
                    let agg = ScanAgg::default();
                    print!("{}", write_scan_json(&root, &agg, false, Some(e)));
                    std::process::exit(1);
                }
            }
        }
        Command::Materialize {
            src,
            dest,
            link_strategy,
            jobs,
            profile,
        } => {
            let started = Instant::now();
            match materialize_tree(&src, &dest, link_strategy, jobs, profile) {
                Ok(report) => {
                    let duration_ms = started.elapsed().as_millis() as u64;
                    let effective_jobs = match profile {
                        MaterializeProfile::Auto => jobs,
                        MaterializeProfile::IoHeavy => (jobs * 2).max(4),
                        MaterializeProfile::SmallFiles => (jobs * 3).max(8),
                    };
                    print!(
                        "{}",
                        write_materialize_json(
                            &src,
                            &dest,
                            link_strategy,
                            jobs,
                            profile,
                            effective_jobs,
                            true,
                            None,
                            duration_ms,
                            &report.stats,
                            &report.phases
                        )
                    );
                }
                Err(reason) => {
                    let duration_ms = started.elapsed().as_millis() as u64;
                    let effective_jobs = match profile {
                        MaterializeProfile::Auto => jobs,
                        MaterializeProfile::IoHeavy => (jobs * 2).max(4),
                        MaterializeProfile::SmallFiles => (jobs * 3).max(8),
                    };
                    print!(
                        "{}",
                        write_materialize_json(
                            &src,
                            &dest,
                            link_strategy,
                            jobs,
                            profile,
                            effective_jobs,
                            false,
                            Some(reason),
                            duration_ms,
                            &MaterializeStats::default(),
                            &PhaseDurations::default()
                        )
                    );
                    std::process::exit(1);
                }
            }
        }
        Command::Analyze { root, graph } => match analyze(&root, graph) {
            Ok(report) => {
                let json = write_analyze_json(
                    &root,
                    &report.totals,
                    &report.node_modules_dir,
                    &report.packages,
                    &report.duplicates,
                    &report.depth,
                    graph,
                );
                print!("{json}");
            }
            Err(reason) => {
                let mut w = JsonWriter::new();
                w.begin_object();
                w.key("ok");
                w.value_bool(false);
                w.key("kind");
                w.value_string("better.analyze.report");
                w.key("schemaVersion");
                w.value_u64(1);
                w.key("projectRoot");
                w.value_string(&root.to_string_lossy());
                w.key("reason");
                w.value_string(&reason);
                w.end_object();
                w.out.push('\n');
                print!("{}", w.finish());
                std::process::exit(1);
            }
        },
        Command::Install {
            lockfile,
            project_root,
            cache_root,
            link_strategy,
            jobs,
        } => {
            let started = Instant::now();

            // Step 1: Resolve packages from lockfile
            let resolve_result = match resolve_from_lockfile(&lockfile) {
                Ok(result) => result,
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok");
                    w.value_bool(false);
                    w.key("kind");
                    w.value_string("better.install.report");
                    w.key("reason");
                    w.value_string(&reason);
                    w.end_object();
                    w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            };

            // Step 2: Fetch packages to CAS
            let fetch_result = match fetch_packages(&resolve_result.packages, &cache_root) {
                Ok(result) => result,
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok");
                    w.value_bool(false);
                    w.key("kind");
                    w.value_string("better.install.report");
                    w.key("reason");
                    w.value_string(&reason);
                    w.end_object();
                    w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            };

            // Step 3: Materialize packages to node_modules
            let layout = CasLayout::new(&cache_root);
            let node_modules = project_root.join("node_modules");
            let mut total_files = 0u64;
            let mut total_dirs = 0u64;
            let mut total_symlinks = 0u64;

            for pkg in &resolve_result.packages {
                // Get unpacked path from CAS
                let (algo, hex) = match cas_key_from_integrity(&pkg.integrity) {
                    Some(key) => key,
                    None => continue,
                };

                let unpacked = unpacked_path(&layout, &algo, &hex);

                // Find package subdirectory (npm tarballs extract to "package/")
                let src_dir = unpacked.join("package");
                if !src_dir.exists() {
                    continue;
                }

                // Destination is node_modules + rel_path (strip "node_modules/" prefix)
                let dest_path = if pkg.rel_path.starts_with("node_modules/") {
                    node_modules.join(&pkg.rel_path[13..])
                } else {
                    node_modules.join(&pkg.rel_path)
                };

                // Materialize this package
                match materialize_tree(&src_dir, &dest_path, link_strategy, jobs, MaterializeProfile::Auto) {
                    Ok(report) => {
                        total_files += report.stats.files;
                        total_dirs += report.stats.directories;
                        total_symlinks += report.stats.symlinks;
                    }
                    Err(reason) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok");
                        w.value_bool(false);
                        w.key("kind");
                        w.value_string("better.install.report");
                        w.key("reason");
                        w.value_string(&format!("Failed to materialize {}: {}", pkg.name, reason));
                        w.end_object();
                        w.out.push('\n');
                        print!("{}", w.finish());
                        std::process::exit(1);
                    }
                }
            }

            let duration_ms = started.elapsed().as_millis() as u64;

            // Output JSON result
            let mut w = JsonWriter::new();
            w.begin_object();
            w.key("ok");
            w.value_bool(true);
            w.key("kind");
            w.value_string("better.install.report");
            w.key("schemaVersion");
            w.value_u64(1);
            w.key("lockfile");
            w.value_string(&lockfile.to_string_lossy());
            w.key("projectRoot");
            w.value_string(&project_root.to_string_lossy());
            w.key("cacheRoot");
            w.value_string(&cache_root.to_string_lossy());
            w.key("durationMs");
            w.value_u64(duration_ms);
            w.key("stats");
            w.begin_object();
            w.key("packagesResolved");
            w.value_u64(resolve_result.packages.len() as u64);
            w.key("packagesFetched");
            w.value_u64(fetch_result.packages_fetched);
            w.key("packagesCached");
            w.value_u64(fetch_result.packages_cached);
            w.key("bytesDownloaded");
            w.value_u64(fetch_result.bytes_downloaded);
            w.key("files");
            w.value_u64(total_files);
            w.key("directories");
            w.value_u64(total_dirs);
            w.key("symlinks");
            w.value_u64(total_symlinks);
            w.end_object();
            w.end_object();
            w.out.push('\n');
            print!("{}", w.finish());
        }
    }
}
