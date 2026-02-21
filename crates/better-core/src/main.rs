use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Instant;

use better_core::{
    analyze, cas_key_from_integrity, create_bin_links, detect_lifecycle_scripts, fetch_packages,
    ingest_to_file_cas, materialize_from_file_cas, materialize_tree, resolve_from_lockfile,
    run_lifecycle_scripts, scan_tree, try_clonefile_dir, unpacked_path, write_analyze_json,
    write_materialize_json, write_scan_json, CasLayout, JsonWriter, LifecycleRunResult,
    LinkStrategy, MaterializeProfile, MaterializeStats, PhaseDurations, ScanAgg, VERSION,
};

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
        store_root: Option<PathBuf>,
        link_strategy: LinkStrategy,
        jobs: usize,
        scripts: bool,
        dedup: bool,
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
    let mut store_root: Option<PathBuf> = None;
    let mut scripts = true;
    let mut dedup = false;
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
            "--store-root" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--store-root requires a value".to_string()),
                    };
                }
                store_root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--no-scripts" => {
                scripts = false;
                i += 1;
            }
            "--scripts" => {
                scripts = true;
                i += 1;
            }
            "--dedup" => {
                dedup = true;
                i += 1;
            }
            "--no-dedup" => {
                dedup = false;
                i += 1;
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
            let project_root = project_root.unwrap_or_else(|| PathBuf::from("."));
            let lockfile = lockfile.unwrap_or_else(|| project_root.join("package-lock.json"));
            let cache_root = cache_root.unwrap_or_else(default_cache_root);
            Command::Install {
                lockfile,
                project_root,
                cache_root,
                store_root,
                link_strategy,
                jobs,
                scripts,
                dedup,
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
  better-core install [--lockfile <path>] [--project-root <path>] [--cache-root <path>] [--store-root <path>] [--link-strategy auto|hardlink|copy] [--jobs N] [--no-scripts] [--dedup]
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
            store_root,
            link_strategy,
            jobs: _,
            scripts,
            dedup,
        } => {
            let started = Instant::now();
            let phase_resolve_ms;
            let phase_fetch_ms;
            let phase_materialize_ms;
            let phase_binlinks_ms;
            let phase_scripts_ms;

            // Step 1: Resolve packages from lockfile
            let t_resolve = Instant::now();
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
            phase_resolve_ms = t_resolve.elapsed().as_millis() as u64;

            // Step 2: Fetch packages to CAS
            let t_fetch = Instant::now();
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
            phase_fetch_ms = t_fetch.elapsed().as_millis() as u64;

            // Step 3: Materialize packages to node_modules
            let t_mat = Instant::now();
            let layout = CasLayout::new(&cache_root);
            let file_cas_root = store_root.unwrap_or_else(|| cache_root.join("file-store"));
            let node_modules = project_root.join("node_modules");
            let _ = std::fs::create_dir_all(&node_modules);

            let total_files = std::sync::atomic::AtomicU64::new(0);
            let total_dirs = std::sync::atomic::AtomicU64::new(0);
            let total_symlinks = std::sync::atomic::AtomicU64::new(0);
            let cloned = std::sync::atomic::AtomicU64::new(0);
            let cas_linked = std::sync::atomic::AtomicU64::new(0);
            let cas_copied = std::sync::atomic::AtomicU64::new(0);
            let fallback_materialized = std::sync::atomic::AtomicU64::new(0);

            // Pre-create all parent directories (must be sequential)
            for pkg in &resolve_result.packages {
                let dest_path = if pkg.rel_path.starts_with("node_modules/") {
                    node_modules.join(&pkg.rel_path[13..])
                } else {
                    node_modules.join(&pkg.rel_path)
                };
                if let Some(parent) = dest_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
            }

            // Parallel materialize all packages using rayon
            use rayon::prelude::*;
            let materialize_error: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

            resolve_result.packages.par_iter().for_each(|pkg| {
                // Check for prior error
                if materialize_error.lock().ok().and_then(|g| g.as_ref().cloned()).is_some() {
                    return;
                }

                let (algo, hex) = match cas_key_from_integrity(&pkg.integrity) {
                    Some(key) => key,
                    None => return,
                };

                let unpacked = unpacked_path(&layout, &algo, &hex);
                let src_dir = unpacked.join("package");
                if !src_dir.exists() {
                    return;
                }

                let dest_path = if pkg.rel_path.starts_with("node_modules/") {
                    node_modules.join(&pkg.rel_path[13..])
                } else {
                    node_modules.join(&pkg.rel_path)
                };

                if dedup {
                    // DEDUP MODE: CAS-first (cross-project hardlinks, saves disk)
                    // Ingest into file CAS, then hardlink from global store
                    let _ = ingest_to_file_cas(&file_cas_root, &algo, &hex, &src_dir);
                    if let Ok(result) = materialize_from_file_cas(
                        &file_cas_root, &algo, &hex, &dest_path, link_strategy,
                    ) {
                        if result.ok && result.files > 0 {
                            total_files.fetch_add(result.files, std::sync::atomic::Ordering::Relaxed);
                            cas_linked.fetch_add(result.linked, std::sync::atomic::Ordering::Relaxed);
                            cas_copied.fetch_add(result.copied, std::sync::atomic::Ordering::Relaxed);
                            total_symlinks.fetch_add(result.symlinks, std::sync::atomic::Ordering::Relaxed);
                            return;
                        }
                    }
                    // CAS failed, fall back to clonefile then materialize_tree
                    if try_clonefile_dir(&src_dir, &dest_path) {
                        cloned.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        return;
                    }
                } else {
                    // SPEED MODE (default): clonefile-first (fastest on macOS APFS)
                    // Also ingest to CAS in background for future --dedup use
                    if try_clonefile_dir(&src_dir, &dest_path) {
                        cloned.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        // Ingest to CAS opportunistically so --dedup works next time
                        let _ = ingest_to_file_cas(&file_cas_root, &algo, &hex, &src_dir);
                        return;
                    }
                    // clonefile failed (not APFS?), try CAS hardlinks
                    let _ = ingest_to_file_cas(&file_cas_root, &algo, &hex, &src_dir);
                    if let Ok(result) = materialize_from_file_cas(
                        &file_cas_root, &algo, &hex, &dest_path, link_strategy,
                    ) {
                        if result.ok && result.files > 0 {
                            total_files.fetch_add(result.files, std::sync::atomic::Ordering::Relaxed);
                            cas_linked.fetch_add(result.linked, std::sync::atomic::Ordering::Relaxed);
                            cas_copied.fetch_add(result.copied, std::sync::atomic::Ordering::Relaxed);
                            total_symlinks.fetch_add(result.symlinks, std::sync::atomic::Ordering::Relaxed);
                            return;
                        }
                    }
                }

                // Final fallback: materialize_tree (copy files)
                match materialize_tree(&src_dir, &dest_path, link_strategy, 4, MaterializeProfile::Auto) {
                    Ok(report) => {
                        total_files.fetch_add(report.stats.files, std::sync::atomic::Ordering::Relaxed);
                        total_dirs.fetch_add(report.stats.directories, std::sync::atomic::Ordering::Relaxed);
                        total_symlinks.fetch_add(report.stats.symlinks, std::sync::atomic::Ordering::Relaxed);
                        fallback_materialized.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    Err(reason) => {
                        if let Ok(mut guard) = materialize_error.lock() {
                            if guard.is_none() {
                                *guard = Some(format!("Failed to materialize {}: {}", pkg.name, reason));
                            }
                        }
                    }
                }
            });

            // Check for materialization errors
            if let Some(reason) = materialize_error.lock().ok().and_then(|g| g.clone()) {
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
            phase_materialize_ms = t_mat.elapsed().as_millis() as u64;

            // Step 4: Create bin links
            let t_bins = Instant::now();
            let bin_result =
                create_bin_links(&node_modules, &resolve_result.packages).unwrap_or_default();
            phase_binlinks_ms = t_bins.elapsed().as_millis() as u64;

            // Step 5: Lifecycle scripts
            let t_scripts = Instant::now();
            let scripts_result = if scripts {
                let detection =
                    detect_lifecycle_scripts(&node_modules, &resolve_result.packages);
                run_lifecycle_scripts(&project_root, &detection)
            } else {
                LifecycleRunResult {
                    skipped_reason: Some("disabled".to_string()),
                    ..Default::default()
                }
            };
            phase_scripts_ms = t_scripts.elapsed().as_millis() as u64;

            let duration_ms = started.elapsed().as_millis() as u64;

            // Output JSON result
            let mut w = JsonWriter::new();
            w.begin_object();
            w.key("ok");
            w.value_bool(true);
            w.key("kind");
            w.value_string("better.install.report");
            w.key("schemaVersion");
            w.value_u64(2);
            w.key("lockfile");
            w.value_string(&lockfile.to_string_lossy());
            w.key("projectRoot");
            w.value_string(&project_root.to_string_lossy());
            w.key("cacheRoot");
            w.value_string(&cache_root.to_string_lossy());
            w.key("durationMs");
            w.value_u64(duration_ms);

            // Load atomic counters
            let total_files = total_files.load(std::sync::atomic::Ordering::Relaxed);
            let total_dirs = total_dirs.load(std::sync::atomic::Ordering::Relaxed);
            let total_symlinks = total_symlinks.load(std::sync::atomic::Ordering::Relaxed);
            let cloned = cloned.load(std::sync::atomic::Ordering::Relaxed);
            let cas_linked = cas_linked.load(std::sync::atomic::Ordering::Relaxed);
            let cas_copied = cas_copied.load(std::sync::atomic::Ordering::Relaxed);
            let fallback_materialized = fallback_materialized.load(std::sync::atomic::Ordering::Relaxed);

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
            w.key("cloned");
            w.value_u64(cloned);
            w.key("casLinked");
            w.value_u64(cas_linked);
            w.key("casCopied");
            w.value_u64(cas_copied);
            w.key("fallbackMaterialized");
            w.value_u64(fallback_materialized);
            w.end_object();

            w.key("binLinks");
            w.begin_object();
            w.key("created");
            w.value_u64(bin_result.links_created);
            w.key("failed");
            w.value_u64(bin_result.links_failed);
            w.end_object();

            w.key("scripts");
            w.begin_object();
            w.key("run");
            w.value_u64(scripts_result.scripts_run);
            w.key("succeeded");
            w.value_u64(scripts_result.scripts_succeeded);
            w.key("failed");
            w.value_u64(scripts_result.scripts_failed);
            if let Some(reason) = &scripts_result.skipped_reason {
                w.key("skippedReason");
                w.value_string(reason);
            }
            if let Some(code) = scripts_result.rebuild_exit_code {
                w.key("rebuildExitCode");
                w.value_i64(code as i64);
            }
            w.end_object();

            w.key("timing");
            w.begin_object();
            w.key("resolveMs");
            w.value_u64(phase_resolve_ms);
            w.key("fetchMs");
            w.value_u64(phase_fetch_ms);
            w.key("materializeMs");
            w.value_u64(phase_materialize_ms);
            w.key("binLinksMs");
            w.value_u64(phase_binlinks_ms);
            w.key("scriptsMs");
            w.value_u64(phase_scripts_ms);
            w.key("totalMs");
            w.value_u64(duration_ms);
            w.end_object();

            w.end_object();
            w.out.push('\n');
            print!("{}", w.finish());
        }
    }
}
