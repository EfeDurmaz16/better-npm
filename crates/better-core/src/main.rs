use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Instant;

use better_core::{
    analyze, cas_key_from_integrity, create_bin_links, detect_lifecycle_scripts, fetch_packages,
    ingest_to_file_cas, materialize_from_file_cas, materialize_tree, resolve_from_lockfile,
    run_lifecycle_scripts, scan_tree, try_clonefile_dir, unpacked_path, write_analyze_json,
    write_materialize_json, write_scan_json, CasLayout, JsonWriter, LifecycleRunResult,
    LinkStrategy, MaterializeProfile, MaterializeStats, PhaseDurations, ScanAgg, VERSION,
    // Phase B
    run_script, run_scripts_parallel,
    scan_licenses, check_dedupe, trace_dependency, check_outdated,
    run_doctor, cache_stats, cache_gc, run_audit, run_benchmark,
    // Phase C
    hooks_install, exec_script, env_info, env_check, init_project, run_script_watch,
    // Phase D
    parse_npmrc, scan_scripts, scripts_allow, scripts_block,
    policy_check, policy_init,
    generate_lock_metadata, verify_lock_metadata,
    detect_workspaces, workspace_graph, workspace_changed, workspace_run,
    generate_sbom, write_cyclonedx_json, write_spdx_json,
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
    Run {
        project_root: PathBuf,
        script_names: Vec<String>,
        extra_args: Vec<String>,
        watch: bool,
    },
    License {
        root: PathBuf,
        allow: Vec<String>,
        deny: Vec<String>,
    },
    Dedupe { root: PathBuf },
    Why {
        project_root: PathBuf,
        lockfile: PathBuf,
        package: String,
    },
    Outdated {
        project_root: PathBuf,
        lockfile: PathBuf,
    },
    Doctor {
        project_root: PathBuf,
        threshold: i32,
    },
    CacheStats { cache_root: PathBuf },
    CacheGc {
        cache_root: PathBuf,
        max_age: u64,
        dry_run: bool,
    },
    Audit {
        project_root: PathBuf,
        lockfile: PathBuf,
        min_severity: String,
    },
    Benchmark {
        project_root: PathBuf,
        rounds: usize,
        pms: Vec<String>,
    },
    HooksInstall { project_root: PathBuf },
    Exec {
        project_root: PathBuf,
        script: String,
        extra_args: Vec<String>,
    },
    Env { project_root: PathBuf, check: bool },
    Init {
        project_root: PathBuf,
        name: Option<String>,
        template: Option<String>,
    },
    // Phase D
    Scripts {
        project_root: PathBuf,
        subcommand: String,
        package: Option<String>,
    },
    Policy {
        project_root: PathBuf,
        subcommand: String,
    },
    Lock {
        project_root: PathBuf,
        subcommand: String,
    },
    Workspace {
        project_root: PathBuf,
        subcommand: String,
        since: Option<String>,
        command_arg: Option<String>,
    },
    Sbom {
        project_root: PathBuf,
        lockfile: PathBuf,
        format: String,
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
    let mut scripts_flag = true;
    let mut dedup = false;
    let mut allow: Vec<String> = Vec::new();
    let mut deny: Vec<String> = Vec::new();
    let mut threshold = 70i32;
    let mut max_age = 30u64;
    let mut dry_run = false;
    let mut min_severity = "low".to_string();
    let mut rounds = 3usize;
    let mut pms: Vec<String> = Vec::new();
    let mut positional: Vec<String> = Vec::new();
    let mut extra_args: Vec<String> = Vec::new();
    let mut hit_dashdash = false;
    let mut name_opt: Option<String> = None;
    let mut template_opt: Option<String> = None;
    let mut watch = false;
    let mut format_opt = "cyclonedx".to_string();
    let mut since_opt: Option<String> = None;

    let mut i = 1usize;
    while i < args.len() {
        if hit_dashdash {
            extra_args.push(args[i].clone());
            i += 1;
            continue;
        }
        match args[i].as_str() {
            "--" => {
                hit_dashdash = true;
                i += 1;
            }
            "--root" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--root requires a value".into()) }; }
                root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--graph" => { graph = true; i += 1; }
            "--no-graph" => { graph = false; i += 1; }
            "--src" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--src requires a value".into()) }; }
                src = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--dest" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--dest requires a value".into()) }; }
                dest = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--link-strategy" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--link-strategy requires a value".into()) }; }
                match LinkStrategy::from_arg(&args[i + 1]) {
                    Some(s) => link_strategy = s,
                    None => return Command::Help { error: Some(format!("unknown --link-strategy '{}'", args[i + 1])) },
                }
                i += 2;
            }
            "--jobs" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--jobs requires a value".into()) }; }
                match args[i + 1].parse::<usize>() {
                    Ok(n) if n > 0 => jobs = n.clamp(1, 256),
                    _ => return Command::Help { error: Some(format!("invalid --jobs '{}'", args[i + 1])) },
                }
                i += 2;
            }
            "--profile" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--profile requires a value".into()) }; }
                match MaterializeProfile::from_arg(&args[i + 1]) {
                    Some(p) => profile = p,
                    None => return Command::Help { error: Some(format!("unknown --profile '{}'", args[i + 1])) },
                }
                i += 2;
            }
            "--lockfile" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--lockfile requires a value".into()) }; }
                lockfile = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--project-root" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--project-root requires a value".into()) }; }
                project_root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--cache-root" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--cache-root requires a value".into()) }; }
                cache_root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--store-root" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--store-root requires a value".into()) }; }
                store_root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--no-scripts" => { scripts_flag = false; i += 1; }
            "--scripts" => { scripts_flag = true; i += 1; }
            "--dedup" => { dedup = true; i += 1; }
            "--no-dedup" => { dedup = false; i += 1; }
            "--allow" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--allow requires a value".into()) }; }
                allow = args[i + 1].split(',').map(|s| s.trim().to_string()).collect();
                i += 2;
            }
            "--deny" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--deny requires a value".into()) }; }
                deny = args[i + 1].split(',').map(|s| s.trim().to_string()).collect();
                i += 2;
            }
            "--threshold" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--threshold requires a value".into()) }; }
                threshold = args[i + 1].parse().unwrap_or(70);
                i += 2;
            }
            "--max-age" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--max-age requires a value".into()) }; }
                max_age = args[i + 1].parse().unwrap_or(30);
                i += 2;
            }
            "--dry-run" => { dry_run = true; i += 1; }
            "--min-severity" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--min-severity requires a value".into()) }; }
                min_severity = args[i + 1].clone();
                i += 2;
            }
            "--rounds" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--rounds requires a value".into()) }; }
                rounds = args[i + 1].parse().unwrap_or(3);
                i += 2;
            }
            "--pm" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--pm requires a value".into()) }; }
                pms = args[i + 1].split(',').map(|s| s.trim().to_string()).collect();
                i += 2;
            }
            "--name" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--name requires a value".into()) }; }
                name_opt = Some(args[i + 1].clone());
                i += 2;
            }
            "--template" | "-t" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--template requires a value".into()) }; }
                template_opt = Some(args[i + 1].clone());
                i += 2;
            }
            "--watch" | "-w" => { watch = true; i += 1; }
            "--format" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--format requires a value".into()) }; }
                format_opt = args[i + 1].clone();
                i += 2;
            }
            "--since" => {
                if i + 1 >= args.len() { return Command::Help { error: Some("--since requires a value".into()) }; }
                since_opt = Some(args[i + 1].clone());
                i += 2;
            }
            other => {
                if other.starts_with('-') {
                    return Command::Help { error: Some(format!("unknown flag: {other}")) };
                }
                positional.push(other.to_string());
                i += 1;
            }
        }
    }

    match sub {
        "analyze" => match root {
            Some(r) => Command::Analyze { root: r, graph },
            None => Command::Help { error: Some("analyze requires --root".into()) },
        },
        "scan" => match root {
            Some(r) => Command::Scan { root: r },
            None => Command::Help { error: Some("scan requires --root".into()) },
        },
        "materialize" => match (src, dest) {
            (Some(s), Some(d)) => Command::Materialize { src: s, dest: d, link_strategy, jobs, profile },
            _ => Command::Help { error: Some("materialize requires --src and --dest".into()) },
        },
        "install" | "i" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let lf = lockfile.unwrap_or_else(|| pr.join("package-lock.json"));
            let cr = cache_root.unwrap_or_else(default_cache_root);
            Command::Install { lockfile: lf, project_root: pr, cache_root: cr, store_root, link_strategy, jobs, scripts: scripts_flag, dedup }
        },
        "run" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            if positional.is_empty() {
                return Command::Help { error: Some("run requires a script name".into()) };
            }
            Command::Run { project_root: pr, script_names: positional, extra_args, watch }
        },
        "test" | "t" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::Run { project_root: pr, script_names: vec!["test".into()], extra_args: positional.into_iter().chain(extra_args).collect(), watch }
        },
        "lint" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::Run { project_root: pr, script_names: vec!["lint".into()], extra_args: positional.into_iter().chain(extra_args).collect(), watch }
        },
        "dev" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::Run { project_root: pr, script_names: vec!["dev".into()], extra_args: positional.into_iter().chain(extra_args).collect(), watch: true }
        },
        "build" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::Run { project_root: pr, script_names: vec!["build".into()], extra_args: positional.into_iter().chain(extra_args).collect(), watch }
        },
        "start" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::Run { project_root: pr, script_names: vec!["start".into()], extra_args: positional.into_iter().chain(extra_args).collect(), watch }
        },
        "license" => {
            let r = root.unwrap_or_else(|| {
                let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
                pr.join("node_modules")
            });
            Command::License { root: r, allow, deny }
        },
        "dedupe" | "dedup" => {
            let r = root.unwrap_or_else(|| project_root.unwrap_or_else(|| PathBuf::from(".")));
            Command::Dedupe { root: r }
        },
        "why" => {
            if positional.is_empty() {
                return Command::Help { error: Some("why requires a package name".into()) };
            }
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let lf = lockfile.unwrap_or_else(|| pr.join("package-lock.json"));
            Command::Why { project_root: pr, lockfile: lf, package: positional[0].clone() }
        },
        "outdated" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let lf = lockfile.unwrap_or_else(|| pr.join("package-lock.json"));
            Command::Outdated { project_root: pr, lockfile: lf }
        },
        "doctor" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::Doctor { project_root: pr, threshold }
        },
        "cache" => {
            let cr = cache_root.unwrap_or_else(default_cache_root);
            if positional.first().map(|s| s.as_str()) == Some("gc") {
                Command::CacheGc { cache_root: cr, max_age, dry_run }
            } else {
                Command::CacheStats { cache_root: cr }
            }
        },
        "audit" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let lf = lockfile.unwrap_or_else(|| pr.join("package-lock.json"));
            Command::Audit { project_root: pr, lockfile: lf, min_severity }
        },
        "benchmark" | "bench" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            if pms.is_empty() { pms = vec!["npm".into(), "better".into()]; }
            Command::Benchmark { project_root: pr, rounds, pms }
        },
        "hooks" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::HooksInstall { project_root: pr }
        },
        "exec" | "x" => {
            if positional.is_empty() {
                return Command::Help { error: Some("exec requires a script path".into()) };
            }
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::Exec { project_root: pr, script: positional[0].clone(), extra_args }
        },
        "env" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let check = positional.first().map(|s| s.as_str()) == Some("check");
            Command::Env { project_root: pr, check }
        },
        "init" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::Init { project_root: pr, name: name_opt.or_else(|| positional.first().cloned()), template: template_opt }
        },
        "scripts" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let subcmd = positional.first().cloned().unwrap_or_else(|| "list".into());
            let pkg = positional.get(1).cloned();
            Command::Scripts { project_root: pr, subcommand: subcmd, package: pkg }
        },
        "policy" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let subcmd = positional.first().cloned().unwrap_or_else(|| "check".into());
            Command::Policy { project_root: pr, subcommand: subcmd }
        },
        "lock" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let subcmd = positional.first().cloned().unwrap_or_else(|| "generate".into());
            Command::Lock { project_root: pr, subcommand: subcmd }
        },
        "workspace" | "ws" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let subcmd = positional.first().cloned().unwrap_or_else(|| "list".into());
            let cmd_arg = if subcmd == "run" { positional.get(1).cloned() } else { None };
            Command::Workspace { project_root: pr, subcommand: subcmd, since: since_opt, command_arg: cmd_arg }
        },
        "sbom" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let lf = lockfile.unwrap_or_else(|| pr.join("package-lock.json"));
            Command::Sbom { project_root: pr, lockfile: lf, format: format_opt }
        },
        _ => Command::Help { error: Some(format!("unknown command: {sub}")) },
    }
}

fn print_help(error: Option<String>) {
    if let Some(e) = error {
        eprintln!("error: {e}\n");
    }
    println!(
        "better-core {VERSION}

Usage:
  better-core install [--lockfile <path>] [--project-root <path>] [--cache-root <path>] [--dedup]
  better-core run <script> [--watch] [-- extra args...]
  better-core test|lint|build|start [--watch] [args...]
  better-core dev [args...]  (watch mode by default)
  better-core license [--root <path>] [--allow MIT,ISC] [--deny GPL-3.0]
  better-core dedupe [--root <path>]
  better-core why <package> [--project-root <path>] [--lockfile <path>]
  better-core outdated [--project-root <path>] [--lockfile <path>]
  better-core doctor [--project-root <path>] [--threshold 70]
  better-core cache stats [--cache-root <path>]
  better-core cache gc [--cache-root <path>] [--max-age 30] [--dry-run]
  better-core audit [--project-root <path>] [--lockfile <path>] [--min-severity medium]
  better-core benchmark [--project-root <path>] [--rounds 3] [--pm npm,bun]
  better-core hooks install [--project-root <path>]
  better-core exec <script.ts> [-- args...]
  better-core env [check] [--project-root <path>]
  better-core init [--name <name>] [--template react|next|express]
  better-core scripts [list|scan|allow|block] [package] [--project-root <path>]
  better-core policy [check|init] [--project-root <path>]
  better-core lock [generate|verify] [--project-root <path>]
  better-core workspace [list|graph|changed|run] [--project-root <path>] [--since <ref>]
  better-core sbom [--project-root <path>] [--lockfile <path>] [--format cyclonedx|spdx]
  better-core analyze --root <path> [--graph]
  better-core scan --root <path>
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
        Command::Materialize { src, dest, link_strategy, jobs, profile } => {
            let started = Instant::now();
            match materialize_tree(&src, &dest, link_strategy, jobs, profile) {
                Ok(report) => {
                    let duration_ms = started.elapsed().as_millis() as u64;
                    let effective_jobs = match profile {
                        MaterializeProfile::Auto => jobs,
                        MaterializeProfile::IoHeavy => (jobs * 2).max(4),
                        MaterializeProfile::SmallFiles => (jobs * 3).max(8),
                    };
                    print!("{}", write_materialize_json(&src, &dest, link_strategy, jobs, profile, effective_jobs, true, None, duration_ms, &report.stats, &report.phases));
                }
                Err(reason) => {
                    let duration_ms = started.elapsed().as_millis() as u64;
                    let effective_jobs = match profile {
                        MaterializeProfile::Auto => jobs,
                        MaterializeProfile::IoHeavy => (jobs * 2).max(4),
                        MaterializeProfile::SmallFiles => (jobs * 3).max(8),
                    };
                    print!("{}", write_materialize_json(&src, &dest, link_strategy, jobs, profile, effective_jobs, false, Some(reason), duration_ms, &MaterializeStats::default(), &PhaseDurations::default()));
                    std::process::exit(1);
                }
            }
        }
        Command::Analyze { root, graph } => match analyze(&root, graph) {
            Ok(report) => {
                print!("{}", write_analyze_json(&root, &report.totals, &report.node_modules_dir, &report.packages, &report.duplicates, &report.depth, graph));
            }
            Err(reason) => {
                let mut w = JsonWriter::new();
                w.begin_object();
                w.key("ok"); w.value_bool(false);
                w.key("kind"); w.value_string("better.analyze.report");
                w.key("reason"); w.value_string(&reason);
                w.end_object();
                w.out.push('\n');
                print!("{}", w.finish());
                std::process::exit(1);
            }
        },
        Command::Install { lockfile, project_root, cache_root, store_root, link_strategy, jobs: _, scripts, dedup } => {
            let started = Instant::now();
            let npmrc = parse_npmrc(&project_root);

            // Step 1: Resolve
            let t_resolve = Instant::now();
            let resolve_result = match resolve_from_lockfile(&lockfile) {
                Ok(r) => r,
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.install.report");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            };
            let phase_resolve_ms = t_resolve.elapsed().as_millis() as u64;

            // Step 2: Fetch
            let t_fetch = Instant::now();
            let fetch_result = match fetch_packages(&resolve_result.packages, &cache_root, Some(&npmrc)) {
                Ok(r) => r,
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.install.report");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            };
            let phase_fetch_ms = t_fetch.elapsed().as_millis() as u64;

            // Step 3: Materialize
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

            use rayon::prelude::*;
            let materialize_error: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

            resolve_result.packages.par_iter().for_each(|pkg| {
                if materialize_error.lock().ok().and_then(|g| g.as_ref().cloned()).is_some() { return; }
                let (algo, hex) = match cas_key_from_integrity(&pkg.integrity) { Some(k) => k, None => return };
                let unpacked = unpacked_path(&layout, &algo, &hex);
                let src_dir = unpacked.join("package");
                if !src_dir.exists() { return; }
                let dest_path = if pkg.rel_path.starts_with("node_modules/") {
                    node_modules.join(&pkg.rel_path[13..])
                } else {
                    node_modules.join(&pkg.rel_path)
                };

                if dedup {
                    let _ = ingest_to_file_cas(&file_cas_root, &algo, &hex, &src_dir);
                    if let Ok(result) = materialize_from_file_cas(&file_cas_root, &algo, &hex, &dest_path, link_strategy) {
                        if result.ok && result.files > 0 {
                            total_files.fetch_add(result.files, std::sync::atomic::Ordering::Relaxed);
                            cas_linked.fetch_add(result.linked, std::sync::atomic::Ordering::Relaxed);
                            cas_copied.fetch_add(result.copied, std::sync::atomic::Ordering::Relaxed);
                            total_symlinks.fetch_add(result.symlinks, std::sync::atomic::Ordering::Relaxed);
                            return;
                        }
                    }
                    if try_clonefile_dir(&src_dir, &dest_path) {
                        cloned.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        return;
                    }
                } else {
                    if try_clonefile_dir(&src_dir, &dest_path) {
                        cloned.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let _ = ingest_to_file_cas(&file_cas_root, &algo, &hex, &src_dir);
                        return;
                    }
                    let _ = ingest_to_file_cas(&file_cas_root, &algo, &hex, &src_dir);
                    if let Ok(result) = materialize_from_file_cas(&file_cas_root, &algo, &hex, &dest_path, link_strategy) {
                        if result.ok && result.files > 0 {
                            total_files.fetch_add(result.files, std::sync::atomic::Ordering::Relaxed);
                            cas_linked.fetch_add(result.linked, std::sync::atomic::Ordering::Relaxed);
                            cas_copied.fetch_add(result.copied, std::sync::atomic::Ordering::Relaxed);
                            total_symlinks.fetch_add(result.symlinks, std::sync::atomic::Ordering::Relaxed);
                            return;
                        }
                    }
                }

                match materialize_tree(&src_dir, &dest_path, link_strategy, 4, MaterializeProfile::Auto) {
                    Ok(report) => {
                        total_files.fetch_add(report.stats.files, std::sync::atomic::Ordering::Relaxed);
                        total_dirs.fetch_add(report.stats.directories, std::sync::atomic::Ordering::Relaxed);
                        total_symlinks.fetch_add(report.stats.symlinks, std::sync::atomic::Ordering::Relaxed);
                        fallback_materialized.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    Err(reason) => {
                        if let Ok(mut guard) = materialize_error.lock() {
                            if guard.is_none() { *guard = Some(format!("Failed to materialize {}: {}", pkg.name, reason)); }
                        }
                    }
                }
            });

            if let Some(reason) = materialize_error.lock().ok().and_then(|g| g.clone()) {
                let mut w = JsonWriter::new();
                w.begin_object();
                w.key("ok"); w.value_bool(false);
                w.key("kind"); w.value_string("better.install.report");
                w.key("reason"); w.value_string(&reason);
                w.end_object(); w.out.push('\n');
                print!("{}", w.finish());
                std::process::exit(1);
            }
            let phase_materialize_ms = t_mat.elapsed().as_millis() as u64;

            // Step 4: Bin links
            let t_bins = Instant::now();
            let bin_result = create_bin_links(&node_modules, &resolve_result.packages).unwrap_or_default();
            let phase_binlinks_ms = t_bins.elapsed().as_millis() as u64;

            // Step 5: Lifecycle scripts
            let t_scripts = Instant::now();
            let scripts_result = if scripts {
                let detection = detect_lifecycle_scripts(&node_modules, &resolve_result.packages);
                run_lifecycle_scripts(&project_root, &detection)
            } else {
                LifecycleRunResult { skipped_reason: Some("disabled".into()), ..Default::default() }
            };
            let phase_scripts_ms = t_scripts.elapsed().as_millis() as u64;

            let duration_ms = started.elapsed().as_millis() as u64;
            let total_files = total_files.load(std::sync::atomic::Ordering::Relaxed);
            let total_dirs = total_dirs.load(std::sync::atomic::Ordering::Relaxed);
            let total_symlinks = total_symlinks.load(std::sync::atomic::Ordering::Relaxed);
            let cloned = cloned.load(std::sync::atomic::Ordering::Relaxed);
            let cas_linked = cas_linked.load(std::sync::atomic::Ordering::Relaxed);
            let cas_copied = cas_copied.load(std::sync::atomic::Ordering::Relaxed);
            let fallback_materialized = fallback_materialized.load(std::sync::atomic::Ordering::Relaxed);

            let mut w = JsonWriter::new();
            w.begin_object();
            w.key("ok"); w.value_bool(true);
            w.key("kind"); w.value_string("better.install.report");
            w.key("schemaVersion"); w.value_u64(2);
            w.key("lockfile"); w.value_string(&lockfile.to_string_lossy());
            w.key("projectRoot"); w.value_string(&project_root.to_string_lossy());
            w.key("cacheRoot"); w.value_string(&cache_root.to_string_lossy());
            w.key("durationMs"); w.value_u64(duration_ms);
            w.key("stats"); w.begin_object();
            w.key("packagesResolved"); w.value_u64(resolve_result.packages.len() as u64);
            w.key("packagesFetched"); w.value_u64(fetch_result.packages_fetched);
            w.key("packagesCached"); w.value_u64(fetch_result.packages_cached);
            w.key("bytesDownloaded"); w.value_u64(fetch_result.bytes_downloaded);
            w.key("files"); w.value_u64(total_files);
            w.key("directories"); w.value_u64(total_dirs);
            w.key("symlinks"); w.value_u64(total_symlinks);
            w.key("cloned"); w.value_u64(cloned);
            w.key("casLinked"); w.value_u64(cas_linked);
            w.key("casCopied"); w.value_u64(cas_copied);
            w.key("fallbackMaterialized"); w.value_u64(fallback_materialized);
            w.end_object();
            w.key("binLinks"); w.begin_object();
            w.key("created"); w.value_u64(bin_result.links_created);
            w.key("failed"); w.value_u64(bin_result.links_failed);
            w.end_object();
            w.key("scripts"); w.begin_object();
            w.key("run"); w.value_u64(scripts_result.scripts_run);
            w.key("succeeded"); w.value_u64(scripts_result.scripts_succeeded);
            w.key("failed"); w.value_u64(scripts_result.scripts_failed);
            if let Some(reason) = &scripts_result.skipped_reason { w.key("skippedReason"); w.value_string(reason); }
            if let Some(code) = scripts_result.rebuild_exit_code { w.key("rebuildExitCode"); w.value_i64(code as i64); }
            w.end_object();
            w.key("timing"); w.begin_object();
            w.key("resolveMs"); w.value_u64(phase_resolve_ms);
            w.key("fetchMs"); w.value_u64(phase_fetch_ms);
            w.key("materializeMs"); w.value_u64(phase_materialize_ms);
            w.key("binLinksMs"); w.value_u64(phase_binlinks_ms);
            w.key("scriptsMs"); w.value_u64(phase_scripts_ms);
            w.key("totalMs"); w.value_u64(duration_ms);
            w.end_object();
            w.end_object(); w.out.push('\n');
            print!("{}", w.finish());
        }

        // === Phase B Commands ===

        Command::Run { project_root, script_names, extra_args, watch } => {
            if watch && script_names.len() == 1 {
                match run_script_watch(&project_root, &script_names[0], &extra_args, 300) {
                    Ok(()) => {}
                    Err(reason) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(false);
                        w.key("kind"); w.value_string("better.run.report");
                        w.key("reason"); w.value_string(&reason);
                        w.end_object(); w.out.push('\n');
                        eprint!("{}", w.finish());
                        std::process::exit(1);
                    }
                }
            } else if script_names.len() == 1 {
                match run_script(&project_root, &script_names[0], &extra_args) {
                    Ok(result) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(result.exit_code == 0);
                        w.key("kind"); w.value_string("better.run.report");
                        w.key("script"); w.value_string(&result.script_name);
                        w.key("command"); w.value_string(&result.command);
                        w.key("exitCode"); w.value_i64(result.exit_code as i64);
                        w.key("durationMs"); w.value_u64(result.duration_ms);
                        w.end_object(); w.out.push('\n');
                        eprint!("{}", w.finish());
                        std::process::exit(result.exit_code);
                    }
                    Err(reason) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(false);
                        w.key("kind"); w.value_string("better.run.report");
                        w.key("reason"); w.value_string(&reason);
                        w.end_object(); w.out.push('\n');
                        eprint!("{}", w.finish());
                        std::process::exit(1);
                    }
                }
            } else {
                // Parallel execution
                let results = run_scripts_parallel(&project_root, &script_names);
                let mut w = JsonWriter::new();
                w.begin_object();
                w.key("ok"); w.value_bool(results.iter().all(|r| r.as_ref().map(|s| s.exit_code == 0).unwrap_or(false)));
                w.key("kind"); w.value_string("better.run.parallel");
                w.key("results"); w.begin_array();
                let mut any_failed = false;
                for result in &results {
                    w.begin_object();
                    match result {
                        Ok(r) => {
                            w.key("script"); w.value_string(&r.script_name);
                            w.key("exitCode"); w.value_i64(r.exit_code as i64);
                            w.key("durationMs"); w.value_u64(r.duration_ms);
                            if r.exit_code != 0 { any_failed = true; }
                        }
                        Err(reason) => {
                            w.key("error"); w.value_string(reason);
                            any_failed = true;
                        }
                    }
                    w.end_object();
                }
                w.end_array();
                w.end_object(); w.out.push('\n');
                eprint!("{}", w.finish());
                if any_failed { std::process::exit(1); }
            }
        }

        Command::License { root, allow, deny } => {
            match scan_licenses(&root, &allow, &deny) {
                Ok(report) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(report.violations.is_empty());
                    w.key("kind"); w.value_string("better.license");
                    w.key("packages"); w.begin_array();
                    for pkg in &report.packages {
                        w.begin_object();
                        w.key("name"); w.value_string(&pkg.name);
                        w.key("version"); w.value_string(&pkg.version);
                        w.key("license"); w.value_string(&pkg.license);
                        w.end_object();
                    }
                    w.end_array();
                    w.key("summary"); w.begin_object();
                    w.key("totalPackages"); w.value_u64(report.total_packages);
                    w.key("byLicense"); w.begin_object();
                    for (lic, count) in &report.by_license {
                        w.key(lic); w.value_u64(*count);
                    }
                    w.end_object();
                    w.key("violations"); w.value_u64(report.violations.len() as u64);
                    w.end_object();
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    if !report.violations.is_empty() { std::process::exit(1); }
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.license");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::Dedupe { root } => {
            match check_dedupe(&root) {
                Ok(report) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.dedupe");
                    w.key("duplicates"); w.begin_array();
                    for d in &report.duplicates {
                        w.begin_object();
                        w.key("name"); w.value_string(&d.name);
                        w.key("versions"); w.begin_array();
                        for v in &d.versions { w.value_string(v); }
                        w.end_array();
                        w.key("instances"); w.value_u64(d.instances);
                        w.key("canDedupe"); w.value_bool(d.can_dedupe);
                        w.key("savedInstances"); w.value_u64(d.saved_instances);
                        w.end_object();
                    }
                    w.end_array();
                    w.key("summary"); w.begin_object();
                    w.key("totalDuplicates"); w.value_u64(report.total_duplicates);
                    w.key("deduplicatable"); w.value_u64(report.deduplicatable);
                    w.key("estimatedSavedPackages"); w.value_u64(report.estimated_saved);
                    w.end_object();
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.dedupe");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::Why { project_root, lockfile, package } => {
            match trace_dependency(&project_root, &lockfile, &package) {
                Ok(report) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.why");
                    w.key("package"); w.value_string(&report.package);
                    w.key("version"); match &report.version { Some(v) => w.value_string(v), None => w.value_null() }
                    w.key("isDirect"); w.value_bool(report.is_direct);
                    w.key("dependencyPaths"); w.begin_array();
                    for path in &report.dependency_paths {
                        w.begin_array();
                        for p in path { w.value_string(p); }
                        w.end_array();
                    }
                    w.end_array();
                    w.key("dependedOnBy"); w.begin_array();
                    for (name, ver) in &report.depended_on_by {
                        w.begin_object();
                        w.key("name"); w.value_string(name);
                        w.key("version"); w.value_string(ver);
                        w.end_object();
                    }
                    w.end_array();
                    w.key("totalPaths"); w.value_u64(report.total_paths);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.why");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::Outdated { project_root, lockfile } => {
            match check_outdated(&project_root, &lockfile) {
                Ok(report) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.outdated");
                    w.key("packages"); w.begin_array();
                    for pkg in &report.packages {
                        w.begin_object();
                        w.key("name"); w.value_string(&pkg.name);
                        w.key("current"); w.value_string(&pkg.current);
                        w.key("latest"); w.value_string(&pkg.latest);
                        w.key("updateType"); w.value_string(&pkg.update_type);
                        w.end_object();
                    }
                    w.end_array();
                    w.key("summary"); w.begin_object();
                    w.key("totalChecked"); w.value_u64(report.total_checked);
                    w.key("outdated"); w.value_u64(report.outdated);
                    w.key("major"); w.value_u64(report.major);
                    w.key("minor"); w.value_u64(report.minor);
                    w.key("patch"); w.value_u64(report.patch);
                    w.end_object();
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.outdated");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::Doctor { project_root, threshold } => {
            match run_doctor(&project_root, threshold) {
                Ok(report) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(report.score >= report.threshold);
                    w.key("kind"); w.value_string("better.doctor");
                    w.key("healthScore"); w.begin_object();
                    w.key("score"); w.value_i64(report.score as i64);
                    w.key("threshold"); w.value_i64(report.threshold as i64);
                    w.end_object();
                    w.key("findings"); w.begin_array();
                    for f in &report.findings {
                        w.begin_object();
                        w.key("id"); w.value_string(&f.id);
                        w.key("title"); w.value_string(&f.title);
                        w.key("severity"); w.value_string(&f.severity);
                        w.key("impact"); w.value_i64(f.impact as i64);
                        w.key("recommendation"); w.value_string(&f.recommendation);
                        w.end_object();
                    }
                    w.end_array();
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    if report.score < report.threshold { std::process::exit(1); }
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.doctor");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::CacheStats { cache_root } => {
            match cache_stats(&cache_root) {
                Ok(report) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.cache.stats");
                    w.key("cacheRoot"); w.value_string(&report.cache_root.to_string_lossy());
                    w.key("totalBytes"); w.value_u64(report.total_bytes);
                    w.key("packageCount"); w.value_u64(report.package_count);
                    w.key("tarballs"); w.begin_object();
                    w.key("count"); w.value_u64(report.tarball_count);
                    w.key("bytes"); w.value_u64(report.tarball_bytes);
                    w.end_object();
                    w.key("unpacked"); w.begin_object();
                    w.key("count"); w.value_u64(report.unpacked_count);
                    w.key("bytes"); w.value_u64(report.unpacked_bytes);
                    w.end_object();
                    w.key("fileCas"); w.begin_object();
                    w.key("count"); w.value_u64(report.file_cas_count);
                    w.key("bytes"); w.value_u64(report.file_cas_bytes);
                    w.end_object();
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.cache.stats");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::CacheGc { cache_root, max_age, dry_run } => {
            match cache_gc(&cache_root, max_age, dry_run) {
                Ok(report) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.cache.gc");
                    w.key("removed"); w.value_u64(report.removed);
                    w.key("freedBytes"); w.value_u64(report.freed_bytes);
                    w.key("dryRun"); w.value_bool(report.dry_run);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.cache.gc");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::Audit { project_root, lockfile, min_severity } => {
            match run_audit(&lockfile, &project_root, &min_severity) {
                Ok(report) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(report.total == 0);
                    w.key("kind"); w.value_string("better.audit");
                    w.key("scannedPackages"); w.value_u64(report.scanned_packages);
                    w.key("vulnerabilities"); w.begin_array();
                    for v in &report.vulnerabilities {
                        w.begin_object();
                        w.key("id"); w.value_string(&v.id);
                        w.key("summary"); w.value_string(&v.summary);
                        w.key("severity"); w.value_string(&v.severity);
                        w.key("package"); w.value_string(&v.package);
                        w.key("version"); w.value_string(&v.version);
                        w.key("fixed"); w.value_string(&v.fixed);
                        w.end_object();
                    }
                    w.end_array();
                    w.key("summary"); w.begin_object();
                    w.key("total"); w.value_u64(report.total);
                    w.key("critical"); w.value_u64(report.critical);
                    w.key("high"); w.value_u64(report.high);
                    w.key("medium"); w.value_u64(report.medium);
                    w.key("low"); w.value_u64(report.low);
                    w.key("riskLevel"); w.value_string(&report.risk_level);
                    w.end_object();
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    if report.total > 0 { std::process::exit(1); }
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.audit");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::Benchmark { project_root, rounds, pms } => {
            match run_benchmark(&project_root, rounds, &pms) {
                Ok(report) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.benchmark");
                    w.key("env"); w.begin_object();
                    w.key("platform"); w.value_string(&report.platform);
                    w.key("arch"); w.value_string(&report.arch);
                    w.key("cpus"); w.value_u64(report.cpus);
                    w.end_object();
                    w.key("results"); w.begin_object();
                    for r in &report.results {
                        w.key(&r.name); w.begin_object();
                        w.key("cold"); w.begin_object();
                        w.key("medianMs"); w.value_u64(r.cold.median_ms);
                        w.key("minMs"); w.value_u64(r.cold.min_ms);
                        w.key("maxMs"); w.value_u64(r.cold.max_ms);
                        w.key("meanMs"); w.value_u64(r.cold.mean_ms);
                        w.end_object();
                        w.key("warm"); w.begin_object();
                        w.key("medianMs"); w.value_u64(r.warm.median_ms);
                        w.key("minMs"); w.value_u64(r.warm.min_ms);
                        w.key("maxMs"); w.value_u64(r.warm.max_ms);
                        w.key("meanMs"); w.value_u64(r.warm.mean_ms);
                        w.end_object();
                        w.end_object();
                    }
                    w.end_object();
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.benchmark");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        // === Phase C Commands ===

        Command::HooksInstall { project_root } => {
            match hooks_install(&project_root) {
                Ok(result) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.hooks.install");
                    w.key("hooksInstalled"); w.value_u64(result.hooks_installed);
                    w.key("fromConfig"); w.value_bool(result.from_config);
                    w.key("hooks"); w.begin_array();
                    for (hook_type, action) in &result.hooks {
                        w.begin_object();
                        w.key("type"); w.value_string(hook_type);
                        w.key("action"); w.value_string(action);
                        w.end_object();
                    }
                    w.end_array();
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.hooks.install");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::Exec { project_root, script, extra_args } => {
            match exec_script(&project_root, &script, &extra_args) {
                Ok(result) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(result.exit_code == 0);
                    w.key("kind"); w.value_string("better.exec");
                    w.key("script"); w.value_string(&result.script_name);
                    w.key("command"); w.value_string(&result.command);
                    w.key("exitCode"); w.value_i64(result.exit_code as i64);
                    w.key("durationMs"); w.value_u64(result.duration_ms);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(result.exit_code);
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.exec");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::Env { project_root, check } => {
            if check {
                match env_check(&project_root) {
                    Ok(result) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(result.all_ok);
                        w.key("kind"); w.value_string("better.env.check");
                        w.key("checks"); w.begin_array();
                        for entry in &result.checks {
                            w.begin_object();
                            w.key("tool"); w.value_string(&entry.tool);
                            w.key("current"); w.value_string(&entry.current);
                            w.key("required"); w.value_string(&entry.required);
                            w.key("satisfied"); w.value_bool(entry.satisfied);
                            w.end_object();
                        }
                        w.end_array();
                        w.end_object(); w.out.push('\n');
                        print!("{}", w.finish());
                        if !result.all_ok { std::process::exit(1); }
                    }
                    Err(reason) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(false);
                        w.key("kind"); w.value_string("better.env.check");
                        w.key("reason"); w.value_string(&reason);
                        w.end_object(); w.out.push('\n');
                        print!("{}", w.finish());
                        std::process::exit(1);
                    }
                }
            } else {
                let info = env_info(&project_root);
                let mut w = JsonWriter::new();
                w.begin_object();
                w.key("ok"); w.value_bool(true);
                w.key("kind"); w.value_string("better.env");
                w.key("nodeVersion"); w.value_string(&info.node_version);
                w.key("npmVersion"); w.value_string(&info.npm_version);
                w.key("betterVersion"); w.value_string(&info.better_version);
                w.key("platform"); w.value_string(&info.platform);
                w.key("arch"); w.value_string(&info.arch);
                match &info.project_name { Some(n) => { w.key("projectName"); w.value_string(n); } None => {} }
                match &info.project_version { Some(v) => { w.key("projectVersion"); w.value_string(v); } None => {} }
                w.end_object(); w.out.push('\n');
                print!("{}", w.finish());
            }
        }

        Command::Init { project_root, name, template } => {
            match init_project(&project_root, name.as_deref(), template.as_deref()) {
                Ok(result) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.init");
                    w.key("projectRoot"); w.value_string(&project_root.to_string_lossy());
                    if let Some(tmpl) = &result.template { w.key("template"); w.value_string(tmpl); }
                    w.key("filesCreated"); w.begin_array();
                    for f in &result.files_created { w.value_string(f); }
                    w.end_array();
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.init");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        // === Phase D Commands ===

        Command::Scripts { project_root, subcommand, package } => {
            match subcommand.as_str() {
                "scan" | "list" => {
                    match scan_scripts(&project_root) {
                        Ok(result) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.scripts.scan");
                            w.key("packages"); w.begin_array();
                            for entry in &result.packages {
                                w.begin_object();
                                w.key("name"); w.value_string(&entry.name);
                                w.key("version"); w.value_string(&entry.version);
                                w.key("scripts"); w.begin_array();
                                for (st, cmd) in &entry.scripts {
                                    w.begin_object();
                                    w.key("type"); w.value_string(st);
                                    w.key("command"); w.value_string(cmd);
                                    w.end_object();
                                }
                                w.end_array();
                                w.key("policy"); w.value_string(&entry.policy);
                                w.key("reason"); w.value_string(&entry.reason);
                                w.end_object();
                            }
                            w.end_array();
                            w.key("summary"); w.begin_object();
                            w.key("totalWithScripts"); w.value_u64(result.total_with_scripts);
                            w.key("allowed"); w.value_u64(result.allowed);
                            w.key("blocked"); w.value_u64(result.blocked);
                            w.end_object();
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.scripts.scan");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "allow" => {
                    let pkg = package.unwrap_or_default();
                    if pkg.is_empty() {
                        eprintln!("error: scripts allow requires a package name");
                        std::process::exit(2);
                    }
                    match scripts_allow(&project_root, &pkg) {
                        Ok(policy) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.scripts.allow");
                            w.key("package"); w.value_string(&pkg);
                            w.key("allowedPackages"); w.begin_array();
                            for p in &policy.allowed_packages { w.value_string(p); }
                            w.end_array();
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.scripts.allow");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "block" => {
                    let pkg = package.unwrap_or_default();
                    if pkg.is_empty() {
                        eprintln!("error: scripts block requires a package name");
                        std::process::exit(2);
                    }
                    match scripts_block(&project_root, &pkg) {
                        Ok(policy) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.scripts.block");
                            w.key("package"); w.value_string(&pkg);
                            w.key("blockedPackages"); w.begin_array();
                            for p in &policy.blocked_packages { w.value_string(p); }
                            w.end_array();
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.scripts.block");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                other => {
                    eprintln!("error: unknown scripts subcommand: {other}");
                    std::process::exit(2);
                }
            }
        }

        Command::Policy { project_root, subcommand } => {
            match subcommand.as_str() {
                "check" => {
                    match policy_check(&project_root) {
                        Ok(result) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(result.pass);
                            w.key("kind"); w.value_string("better.policy.check");
                            w.key("score"); w.value_i64(result.score as i64);
                            w.key("threshold"); w.value_i64(result.threshold as i64);
                            w.key("pass"); w.value_bool(result.pass);
                            w.key("violations"); w.begin_array();
                            for v in &result.violations {
                                w.begin_object();
                                w.key("rule"); w.value_string(&v.rule);
                                w.key("severity"); w.value_string(&v.severity);
                                w.key("package"); w.value_string(&v.package);
                                w.key("reason"); w.value_string(&v.reason);
                                w.end_object();
                            }
                            w.end_array();
                            w.key("summary"); w.begin_object();
                            w.key("errors"); w.value_u64(result.errors);
                            w.key("warnings"); w.value_u64(result.warnings);
                            w.key("waived"); w.value_u64(result.waived);
                            w.end_object();
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            if !result.pass { std::process::exit(1); }
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.policy.check");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "init" => {
                    match policy_init(&project_root) {
                        Ok(path) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.policy.init");
                            w.key("path"); w.value_string(&path);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.policy.init");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                other => {
                    eprintln!("error: unknown policy subcommand: {other}");
                    std::process::exit(2);
                }
            }
        }

        Command::Lock { project_root, subcommand } => {
            match subcommand.as_str() {
                "generate" => {
                    match generate_lock_metadata(&project_root) {
                        Ok(metadata) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.lock.generate");
                            w.key("key"); w.value_string(&metadata.key);
                            w.key("lockfile"); w.value_string(&metadata.lockfile_file);
                            w.key("lockfileHash"); w.value_string(&metadata.lockfile_hash);
                            w.key("fingerprint"); w.begin_object();
                            w.key("platform"); w.value_string(&metadata.fingerprint.platform);
                            w.key("arch"); w.value_string(&metadata.fingerprint.arch);
                            w.key("nodeMajor"); w.value_u64(metadata.fingerprint.node_major);
                            w.key("pm"); w.value_string(&metadata.fingerprint.pm);
                            w.end_object();
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.lock.generate");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "verify" => {
                    match verify_lock_metadata(&project_root) {
                        Ok(result) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(result.ok);
                            w.key("kind"); w.value_string("better.lock.verify");
                            w.key("keyMatches"); w.value_bool(result.key_matches);
                            w.key("lockfileMatches"); w.value_bool(result.lockfile_matches);
                            w.key("current"); w.begin_object();
                            w.key("key"); w.value_string(&result.current.key);
                            w.key("lockfile"); w.value_string(&result.current.lockfile_file);
                            w.key("lockfileHash"); w.value_string(&result.current.lockfile_hash);
                            w.end_object();
                            if let Some(expected) = &result.expected {
                                w.key("expected"); w.begin_object();
                                w.key("key"); w.value_string(&expected.key);
                                w.key("lockfile"); w.value_string(&expected.lockfile_file);
                                w.key("lockfileHash"); w.value_string(&expected.lockfile_hash);
                                w.end_object();
                            }
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            if !result.ok { std::process::exit(1); }
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.lock.verify");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                other => {
                    eprintln!("error: unknown lock subcommand: {other}");
                    std::process::exit(2);
                }
            }
        }

        Command::Workspace { project_root, subcommand, since, command_arg } => {
            let ws_info = match detect_workspaces(&project_root) {
                Ok(info) => info,
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.workspace");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            };
            match subcommand.as_str() {
                "list" => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.workspace.list");
                    w.key("type"); w.value_string(&ws_info.workspace_type);
                    w.key("packages"); w.begin_array();
                    for pkg in &ws_info.packages {
                        w.begin_object();
                        w.key("name"); w.value_string(&pkg.name);
                        w.key("version"); w.value_string(&pkg.version);
                        w.key("dir"); w.value_string(&pkg.relative_dir);
                        w.key("workspaceDeps"); w.begin_array();
                        for d in &pkg.workspace_deps { w.value_string(d); }
                        w.end_array();
                        w.end_object();
                    }
                    w.end_array();
                    w.key("total"); w.value_u64(ws_info.packages.len() as u64);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                "graph" => {
                    let graph = workspace_graph(&ws_info);
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.workspace.graph");
                    w.key("sorted"); w.begin_array();
                    for s in &graph.sorted { w.value_string(s); }
                    w.end_array();
                    w.key("levels"); w.begin_array();
                    for level in &graph.levels {
                        w.begin_array();
                        for s in level { w.value_string(s); }
                        w.end_array();
                    }
                    w.end_array();
                    w.key("cycles"); w.begin_array();
                    for cycle in &graph.cycles {
                        w.begin_array();
                        for s in cycle { w.value_string(s); }
                        w.end_array();
                    }
                    w.end_array();
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                "changed" => {
                    let since_ref = since.unwrap_or_else(|| "HEAD~1".into());
                    match workspace_changed(&project_root, &ws_info, &since_ref) {
                        Ok(result) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.workspace.changed");
                            w.key("sinceRef"); w.value_string(&result.since_ref);
                            w.key("changedFiles"); w.value_u64(result.changed_files);
                            w.key("changedPackages"); w.begin_array();
                            for p in &result.changed_packages { w.value_string(p); }
                            w.end_array();
                            w.key("affectedPackages"); w.begin_array();
                            for p in &result.affected_packages { w.value_string(p); }
                            w.end_array();
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.workspace.changed");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "run" => {
                    let cmd = command_arg.unwrap_or_default();
                    if cmd.is_empty() {
                        eprintln!("error: workspace run requires a command");
                        std::process::exit(2);
                    }
                    match workspace_run(&project_root, &ws_info, &cmd) {
                        Ok(result) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(result.failure == 0);
                            w.key("kind"); w.value_string("better.workspace.run");
                            w.key("command"); w.value_string(&result.command);
                            w.key("total"); w.value_u64(result.total);
                            w.key("success"); w.value_u64(result.success);
                            w.key("failure"); w.value_u64(result.failure);
                            w.key("results"); w.begin_array();
                            for (name, code, dur) in &result.results {
                                w.begin_object();
                                w.key("package"); w.value_string(name);
                                w.key("exitCode"); w.value_i64(*code as i64);
                                w.key("durationMs"); w.value_u64(*dur);
                                w.end_object();
                            }
                            w.end_array();
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            if result.failure > 0 { std::process::exit(1); }
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.workspace.run");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                other => {
                    eprintln!("error: unknown workspace subcommand: {other}");
                    std::process::exit(2);
                }
            }
        }

        Command::Sbom { project_root, lockfile, format } => {
            match generate_sbom(&project_root, &lockfile, &format) {
                Ok(report) => {
                    let output = match format.as_str() {
                        "spdx" => write_spdx_json(&report),
                        _ => write_cyclonedx_json(&report),
                    };
                    print!("{}", output);
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.sbom");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }
    }
}
