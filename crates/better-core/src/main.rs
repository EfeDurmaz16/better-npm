use std::collections::HashSet;
use std::io::IsTerminal;
use std::path::PathBuf;
use std::time::Instant;

use better_core::{
    analyze, cas_key_from_integrity, create_bin_links, detect_lifecycle_scripts, fetch_packages,
    ingest_to_file_cas, materialize_from_file_cas, materialize_tree, resolve_from_lockfile,
    run_lifecycle_scripts, scan_tree, try_clonefile_dir, unpacked_path, write_analyze_json,
    write_materialize_json, write_scan_json, CasLayout, JsonWriter, LifecycleRunResult,
    InstallProgress, LinkStrategy, MaterializeProfile, MaterializeStats, NodeLayout, PhaseDurations, ScanAgg,
    StrictMaterializeStats, VERSION, materialize_strict,
    // Phase B
    run_script, run_scripts_parallel,
    scan_licenses, check_dedupe, trace_dependency, check_outdated,
    run_doctor, cache_stats, cache_gc, run_benchmark,
    // Phase C
    hooks_install, exec_script, env_info, env_check, init_project, run_script_watch,
    // Phase D
    parse_npmrc, scan_scripts, scripts_allow, scripts_block,
    policy_check, policy_init,
    // Audit allow-listing
    run_audit_with_config, add_audit_ignore,
    // Dependency approval
    approve_package, revoke_package, pending_packages,
    generate_lock_metadata, verify_lock_metadata,
    detect_workspaces, workspace_graph, workspace_changed, workspace_run,
    generate_sbom_v2,
    LockfileWriter, verify_frozen_lockfile,
    merge_lockfiles, run_merge_driver, install_merge_driver,
    // v0.4 intelligence
    detect_unused, load_license_policy, check_license_policy,
    // v0.5 registry
    registry_add, registry_list, registry_remove, registry_rotate,
    // v0.5 provenance + receipt + firewall
    verify_provenance, write_provenance_json,
    write_install_receipt, list_receipts, verify_receipt, write_receipt_verify_json,
    run_firewall, load_firewall_config, save_firewall_config, write_firewall_json,
    // v0.5 sandbox
    load_sandbox_policy, permissions_for_package, execute_sandboxed,
    sandbox_scan, write_sandbox_scan_json,
    // v0.7 output
    GlobalFlags,
    // v0.7 suggest
    suggest_deps, write_suggest_json,
};
use better_core::engine::EngineRegistry;
use better_core::context;
use better_core::search;

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
        frozen: bool,
        json_progress: bool,
        node_layout: NodeLayout,
        sandbox: bool,
        verify_provenance: bool,
        require_provenance: bool,
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
        policy: bool,
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
        unused: bool,
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
        strict: bool,
        add_ignore: Option<String>,
        ignore_reason: Option<String>,
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
        policy_arg: Option<String>,
        approved_by: Option<String>,
    },
    Lock {
        project_root: PathBuf,
        subcommand: String,
        lock_args: Vec<String>,
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
        vex: bool,
    },
    Registry {
        subcommand: String,
        registry_url: Option<String>,
        scope: Option<String>,
        token_env: Option<String>,
        priority: Option<u64>,
    },
    Provenance {
        project_root: PathBuf,
        lockfile: PathBuf,
        require: bool,
    },
    Receipts {
        project_root: PathBuf,
        subcommand: String,
    },
    Firewall {
        project_root: PathBuf,
        subcommand: String,
    },
    Shell { project_root: PathBuf },
    Migrate {
        project_root: PathBuf,
        from: String,
    },
    Completions { shell: String },
    // v0.7 agentic
    Context {
        project_root: PathBuf,
        package: Option<String>,
        all: bool,
        gc: bool,
        force: bool,
        ecosystem: Option<String>,
    },
    Mcp {
        transport: String,
    },
    Search {
        query: String,
        ecosystem: Option<String>,
        limit: usize,
    },
    Suggest {
        project_root: PathBuf,
        json: bool,
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

/// Parse global flags (--json, --no-color, --no-interactive, --verbose, agent prefix)
/// Returns (GlobalFlags, remaining args with global flags stripped)
fn parse_global_flags(args: &[String]) -> (GlobalFlags, Vec<String>) {
    let mut flags = GlobalFlags::default();
    let mut remaining = Vec::new();
    let mut skip_next = false;

    for (i, arg) in args.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        match arg.as_str() {
            "--no-color" => flags.no_color = true,
            "--no-interactive" => flags.no_interactive = true,
            "--verbose" | "-v" if i > 0 || args.first().map(|s| s.as_str()) != Some("version") => {
                flags.verbose = true;
            }
            _ => remaining.push(arg.clone()),
        }
    }

    // Check for "agent" prefix command
    if remaining.first().map(|s| s.as_str()) == Some("agent") {
        flags.agent_mode = true;
        flags.json = true;
        flags.no_color = true;
        flags.no_interactive = true;
        remaining.remove(0);
    }

    // Check --json in remaining (after agent prefix stripped)
    let mut final_remaining = Vec::new();
    for arg in &remaining {
        if arg == "--json" {
            flags.json = true;
        } else {
            final_remaining.push(arg.clone());
        }
    }

    (flags, final_remaining)
}

fn parse_args() -> (Command, GlobalFlags) {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    if raw_args.is_empty() {
        return (Command::Help { error: None }, GlobalFlags::default());
    }

    let (global_flags, args) = parse_global_flags(&raw_args);

    if args.is_empty() {
        return (Command::Help { error: None }, global_flags);
    }
    if args[0] == "version" || args[0] == "--version" || args[0] == "-V" {
        return (Command::Version, global_flags);
    }
    if args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
        return (Command::Help { error: None }, global_flags);
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
    let mut frozen = false;
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
    let mut json_progress = false;
    let mut node_layout = NodeLayout::Hoist;
    let mut strict = false;
    let mut add_ignore: Option<String> = None;
    let mut ignore_reason: Option<String> = None;
    let mut approved_by: Option<String> = None;
    let mut unused_flag = false;
    let mut policy_flag = false;
    let mut scope_opt: Option<String> = None;
    let mut token_env_opt: Option<String> = None;
    let mut priority_opt: Option<u64> = None;
    let mut sandbox_flag = false;
    let mut vex_flag = false;
    let mut verify_provenance_flag = false;
    let mut require_provenance_flag = false;
    let mut from_opt: Option<String> = None;
    let mut all_flag = false;
    let mut force_flag = false;
    let mut ecosystem_opt: Option<String> = None;
    let mut limit_opt: usize = 10;
    let mut transport_opt = "stdio".to_string();

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
                if i + 1 >= args.len() { return (Command::Help { error: Some("--root requires a value".into()) }, global_flags); }
                root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--graph" => { graph = true; i += 1; }
            "--no-graph" => { graph = false; i += 1; }
            "--src" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--src requires a value".into()) }, global_flags); }
                src = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--dest" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--dest requires a value".into()) }, global_flags); }
                dest = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--link-strategy" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--link-strategy requires a value".into()) }, global_flags); }
                match LinkStrategy::from_arg(&args[i + 1]) {
                    Some(s) => link_strategy = s,
                    None => return (Command::Help { error: Some(format!("unknown --link-strategy '{}'", args[i + 1])) }, global_flags),
                }
                i += 2;
            }
            "--jobs" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--jobs requires a value".into()) }, global_flags); }
                match args[i + 1].parse::<usize>() {
                    Ok(n) if n > 0 => jobs = n.clamp(1, 256),
                    _ => return (Command::Help { error: Some(format!("invalid --jobs '{}'", args[i + 1])) }, global_flags),
                }
                i += 2;
            }
            "--profile" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--profile requires a value".into()) }, global_flags); }
                match MaterializeProfile::from_arg(&args[i + 1]) {
                    Some(p) => profile = p,
                    None => return (Command::Help { error: Some(format!("unknown --profile '{}'", args[i + 1])) }, global_flags),
                }
                i += 2;
            }
            "--lockfile" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--lockfile requires a value".into()) }, global_flags); }
                lockfile = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--project-root" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--project-root requires a value".into()) }, global_flags); }
                project_root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--cache-root" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--cache-root requires a value".into()) }, global_flags); }
                cache_root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--store-root" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--store-root requires a value".into()) }, global_flags); }
                store_root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--no-scripts" => { scripts_flag = false; i += 1; }
            "--scripts" => { scripts_flag = true; i += 1; }
            "--sandbox" => { sandbox_flag = true; i += 1; }
            "--no-sandbox" => { sandbox_flag = false; i += 1; }
            "--vex" => { vex_flag = true; i += 1; }
            "--verify-provenance" => { verify_provenance_flag = true; i += 1; }
            "--require-provenance" => { require_provenance_flag = true; i += 1; }
            "--dedup" => { dedup = true; i += 1; }
            "--no-dedup" => { dedup = false; i += 1; }
            "--frozen" | "--frozen-lockfile" => { frozen = true; i += 1; }
            "--allow" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--allow requires a value".into()) }, global_flags); }
                allow = args[i + 1].split(',').map(|s| s.trim().to_string()).collect();
                i += 2;
            }
            "--deny" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--deny requires a value".into()) }, global_flags); }
                deny = args[i + 1].split(',').map(|s| s.trim().to_string()).collect();
                i += 2;
            }
            "--threshold" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--threshold requires a value".into()) }, global_flags); }
                threshold = args[i + 1].parse().unwrap_or(70);
                i += 2;
            }
            "--max-age" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--max-age requires a value".into()) }, global_flags); }
                max_age = args[i + 1].parse().unwrap_or(30);
                i += 2;
            }
            "--dry-run" => { dry_run = true; i += 1; }
            "--min-severity" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--min-severity requires a value".into()) }, global_flags); }
                min_severity = args[i + 1].clone();
                i += 2;
            }
            "--rounds" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--rounds requires a value".into()) }, global_flags); }
                rounds = args[i + 1].parse().unwrap_or(3);
                i += 2;
            }
            "--pm" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--pm requires a value".into()) }, global_flags); }
                pms = args[i + 1].split(',').map(|s| s.trim().to_string()).collect();
                i += 2;
            }
            "--name" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--name requires a value".into()) }, global_flags); }
                name_opt = Some(args[i + 1].clone());
                i += 2;
            }
            "--template" | "-t" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--template requires a value".into()) }, global_flags); }
                template_opt = Some(args[i + 1].clone());
                i += 2;
            }
            "--strict" => { node_layout = NodeLayout::Strict; strict = true; i += 1; }
            "--hoist" | "--hoisted" => { node_layout = NodeLayout::Hoist; i += 1; }
            "--add-ignore" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--add-ignore requires a CVE ID".into()) }, global_flags); }
                add_ignore = Some(args[i + 1].clone());
                i += 2;
            }
            "--reason" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--reason requires a value".into()) }, global_flags); }
                ignore_reason = Some(args[i + 1].clone());
                i += 2;
            }
            "--approved-by" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--approved-by requires a value".into()) }, global_flags); }
                approved_by = Some(args[i + 1].clone());
                i += 2;
            }
            "--node-layout" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--node-layout requires a value".into()) }, global_flags); }
                match NodeLayout::from_arg(&args[i + 1]) {
                    Some(l) => node_layout = l,
                    None => return (Command::Help { error: Some(format!("unknown --node-layout '{}'", args[i + 1])) }, global_flags),
                }
                i += 2;
            }
            "--json" => { json_progress = true; i += 1; } // also handled by global_flags
            "--watch" | "-w" => { watch = true; i += 1; }
            "--unused" => { unused_flag = true; i += 1; }
            "--policy" => { policy_flag = true; i += 1; }
            "--scope" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--scope requires a value".into()) }, global_flags); }
                scope_opt = Some(args[i + 1].clone());
                i += 2;
            }
            "--token" | "--token-env" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--token-env requires a value".into()) }, global_flags); }
                token_env_opt = Some(args[i + 1].clone());
                i += 2;
            }
            "--priority" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--priority requires a value".into()) }, global_flags); }
                match args[i + 1].parse::<u64>() {
                    Ok(p) => priority_opt = Some(p),
                    Err(_) => return (Command::Help { error: Some(format!("invalid --priority '{}'", args[i + 1])) }, global_flags),
                }
                i += 2;
            }
            "--format" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--format requires a value".into()) }, global_flags); }
                format_opt = args[i + 1].clone();
                i += 2;
            }
            "--from" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--from requires a value (pip, pipenv, poetry)".into()) }, global_flags); }
                from_opt = Some(args[i + 1].clone());
                i += 2;
            }
            "--since" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--since requires a value".into()) }, global_flags); }
                since_opt = Some(args[i + 1].clone());
                i += 2;
            }
            "--all" => { all_flag = true; i += 1; }
            "--force" => { force_flag = true; i += 1; }
            "--ecosystem" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--ecosystem requires a value".into()) }, global_flags); }
                ecosystem_opt = Some(args[i + 1].clone());
                i += 2;
            }
            "--limit" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--limit requires a value".into()) }, global_flags); }
                match args[i + 1].parse::<usize>() {
                    Ok(l) => limit_opt = l,
                    Err(_) => return (Command::Help { error: Some(format!("invalid --limit '{}'", args[i + 1])) }, global_flags),
                }
                i += 2;
            }
            "--transport" => {
                if i + 1 >= args.len() { return (Command::Help { error: Some("--transport requires a value".into()) }, global_flags); }
                transport_opt = args[i + 1].clone();
                i += 2;
            }
            other => {
                if other.starts_with('-') {
                    return (Command::Help { error: Some(format!("unknown flag: {other}")) }, global_flags);
                }
                positional.push(other.to_string());
                i += 1;
            }
        }
    }

    let cmd = match sub {
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
            Command::Install { lockfile: lf, project_root: pr, cache_root: cr, store_root, link_strategy, jobs, scripts: scripts_flag, dedup, frozen, json_progress, node_layout, sandbox: sandbox_flag, verify_provenance: verify_provenance_flag, require_provenance: require_provenance_flag }
        },
        "run" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            if positional.is_empty() {
                return (Command::Help { error: Some("run requires a script name".into()) }, global_flags);
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
            Command::License { root: r, allow, deny, policy: policy_flag }
        },
        "dedupe" | "dedup" => {
            let r = root.unwrap_or_else(|| project_root.unwrap_or_else(|| PathBuf::from(".")));
            Command::Dedupe { root: r }
        },
        "why" => {
            if positional.is_empty() {
                return (Command::Help { error: Some("why requires a package name".into()) }, global_flags);
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
            Command::Doctor { project_root: pr, threshold, unused: unused_flag }
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
            Command::Audit { project_root: pr, lockfile: lf, min_severity, strict, add_ignore, ignore_reason }
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
                return (Command::Help { error: Some("exec requires a script path".into()) }, global_flags);
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
            let pol_arg = positional.get(1).cloned();
            Command::Policy { project_root: pr, subcommand: subcmd, policy_arg: pol_arg, approved_by }
        },
        "lock" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let subcmd = positional.first().cloned().unwrap_or_else(|| "generate".into());
            let lock_args: Vec<String> = if positional.len() > 1 { positional[1..].to_vec() } else { Vec::new() };
            Command::Lock { project_root: pr, subcommand: subcmd, lock_args }
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
            Command::Sbom { project_root: pr, lockfile: lf, format: format_opt, vex: vex_flag }
        },
        "registry" => {
            let subcmd = positional.first().cloned().unwrap_or_else(|| "list".into());
            let reg_url = positional.get(1).cloned();
            Command::Registry { subcommand: subcmd, registry_url: reg_url, scope: scope_opt, token_env: token_env_opt, priority: priority_opt }
        },
        "provenance" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let lf = lockfile.unwrap_or_else(|| pr.join("package-lock.json"));
            Command::Provenance { project_root: pr, lockfile: lf, require: require_provenance_flag }
        },
        "receipts" | "receipt" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let subcmd = positional.first().cloned().unwrap_or_else(|| "list".into());
            Command::Receipts { project_root: pr, subcommand: subcmd }
        },
        "firewall" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let subcmd = positional.first().cloned().unwrap_or_else(|| "rules".into());
            Command::Firewall { project_root: pr, subcommand: subcmd }
        },
        "shell" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::Shell { project_root: pr }
        },
        "migrate" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let from = from_opt.or_else(|| positional.first().cloned())
                .unwrap_or_else(|| "pip".to_string());
            Command::Migrate { project_root: pr, from }
        },
        "suggest" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            Command::Suggest { project_root: pr, json: json_progress }
        },
        "completions" => {
            let shell = positional.first().cloned().unwrap_or_else(|| "bash".into());
            Command::Completions { shell }
        },
        "context" => {
            let pr = project_root.unwrap_or_else(|| PathBuf::from("."));
            let gc = positional.first().map(|s| s == "gc").unwrap_or(false);
            let package = if gc { None } else { positional.first().cloned() };
            Command::Context {
                project_root: pr,
                package,
                all: all_flag,
                gc,
                force: force_flag,
                ecosystem: ecosystem_opt.clone(),
            }
        },
        "mcp" => {
            Command::Mcp { transport: transport_opt.clone() }
        },
        "search" => {
            let query = positional.join(" ");
            if query.is_empty() {
                return (Command::Help { error: Some("search requires a query".into()) }, global_flags);
            }
            Command::Search { query, ecosystem: ecosystem_opt.clone(), limit: limit_opt }
        },
        _ => Command::Help { error: Some(format!("unknown command: {sub}")) },
    };

    (cmd, global_flags)
}

fn print_help(error: Option<String>) {
    if let Some(e) = error {
        eprintln!("error: {e}\n");
    }
    println!(
        "better-core {VERSION}

Usage:
  better-core install [--lockfile <path>] [--project-root <path>] [--cache-root <path>] [--dedup] [--frozen] [--sandbox]
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
  better-core scripts [list|scan|allow|block|sandbox-scan] [package] [--project-root <path>]
  better-core policy [check|init] [--project-root <path>]
  better-core lock [generate|verify] [--project-root <path>]
  better-core workspace [list|graph|changed|run] [--project-root <path>] [--since <ref>]
  better-core sbom [--project-root <path>] [--lockfile <path>] [--format cyclonedx|spdx] [--vex]
  better-core registry [add|list|remove|rotate] [url] [--scope @org] [--token-env VAR] [--priority N]
  better-core provenance [--project-root <path>] [--lockfile <path>] [--require-provenance]
  better-core receipts [list|verify] [--project-root <path>]
  better-core firewall [enable|disable|rules|scan] [--project-root <path>]
  better-core shell [--project-root <path>]                  (spawn venv-activated subshell)
  better-core suggest [--project-root <path>] [--json]            (suggest missing/unused deps)
  better-core migrate [--from pip|pipenv|poetry] [--project-root <path>]
  better-core context <package> [--ecosystem npm|python]   (generate LLM context for a package)
  better-core context --all [--force]                      (generate context for all deps)
  better-core context gc                                   (clean stale context cache)
  better-core mcp [--transport stdio]                      (start MCP server for AI agents)
  better-core search <query> [--ecosystem npm|python] [--limit 10]
  better-core completions <bash|zsh|fish|powershell>
  better-core analyze --root <path> [--graph]
  better-core scan --root <path>
  better-core version

Agent mode (structured output for AI agents):
  better-core agent <command> [options]    (= --json --no-color --no-interactive)
  better-core --json <command>             (machine-readable JSON output)

Semantic exit codes (agent mode):
  0 = success, 1 = dependency-error, 2 = security-blocked, 3 = policy-failure, 4 = network-error
"
    );
}

fn generate_bash_completions() -> &'static str {
    r#"_better() {
    local cur prev commands
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    commands="install analyze cache doctor serve benchmark lock policy workspace audit dashboard run why dedupe license outdated scripts lint test dev build start exec env init hooks sbom registry completions scan materialize agent version help"

    case "${prev}" in
        better|better-core)
            COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )
            return 0
            ;;
        cache)
            COMPREPLY=( $(compgen -W "stats gc" -- "${cur}") )
            return 0
            ;;
        scripts)
            COMPREPLY=( $(compgen -W "list scan allow block" -- "${cur}") )
            return 0
            ;;
        policy)
            COMPREPLY=( $(compgen -W "check init" -- "${cur}") )
            return 0
            ;;
        lock)
            COMPREPLY=( $(compgen -W "generate verify" -- "${cur}") )
            return 0
            ;;
        workspace|ws)
            COMPREPLY=( $(compgen -W "list graph changed run" -- "${cur}") )
            return 0
            ;;
        env)
            COMPREPLY=( $(compgen -W "check" -- "${cur}") )
            return 0
            ;;
        hooks)
            COMPREPLY=( $(compgen -W "install" -- "${cur}") )
            return 0
            ;;
        completions)
            COMPREPLY=( $(compgen -W "bash zsh fish powershell" -- "${cur}") )
            return 0
            ;;
        --template)
            COMPREPLY=( $(compgen -W "react next express" -- "${cur}") )
            return 0
            ;;
        --format)
            COMPREPLY=( $(compgen -W "cyclonedx spdx" -- "${cur}") )
            return 0
            ;;
        --min-severity)
            COMPREPLY=( $(compgen -W "low medium high critical" -- "${cur}") )
            return 0
            ;;
        --link-strategy)
            COMPREPLY=( $(compgen -W "auto clone hardlink copy" -- "${cur}") )
            return 0
            ;;
        --node-layout)
            COMPREPLY=( $(compgen -W "hoist strict" -- "${cur}") )
            return 0
            ;;
    esac

    if [[ "${cur}" == -* ]]; then
        local opts="--json --cache-root --log-level --config --project-root --lockfile --root --help --version"
        COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
        return 0
    fi
}
complete -F _better better
complete -F _better better-core
"#
}

fn generate_zsh_completions() -> &'static str {
    r#"#compdef better better-core

_better() {
    local -a commands
    commands=(
        'install:Wrap your package manager install'
        'analyze:Analyze node_modules sizes and duplication'
        'cache:Inspect/manage Better cache (stats, gc)'
        'doctor:Dependency health checks and score'
        'serve:Start web UI server for dependency visualization'
        'benchmark:Run comparative cold/warm install benchmark'
        'lock:Generate/verify Better lock metadata'
        'policy:Dependency policy enforcement (check, init)'
        'workspace:Workspace management (list, graph, changed, run)'
        'audit:Scan dependencies for known vulnerabilities'
        'dashboard:Interactive TUI dashboard for project health'
        'run:Run package.json scripts'
        'why:Show why a package is installed'
        'dedupe:Detect duplicate packages in node_modules'
        'license:Scan node_modules for package licenses'
        'outdated:Check for newer versions of installed packages'
        'scripts:Manage install script sandboxing'
        'exec:Execute a script file'
        'env:Show/check environment info'
        'init:Initialize a new project'
        'hooks:Install git hooks'
        'sbom:Generate Software Bill of Materials'
        'completions:Generate shell completions'
        'scan:Scan node_modules tree'
        'materialize:Materialize packages from CAS'
        'lint:Run lint script'
        'test:Run test script'
        'dev:Run dev script (watch mode)'
        'build:Run build script'
        'start:Run start script'
        'version:Show version'
        'help:Show help'
    )

    _arguments -C \
        '--json[Machine-readable JSON output]' \
        '--cache-root[Override cache root]:path:_files -/' \
        '--log-level[Log level]:level:(debug info warn error silent)' \
        '--config[Config file path]:path:_files' \
        '--project-root[Project root]:path:_files -/' \
        '--lockfile[Lockfile path]:path:_files' \
        '1:command:->cmd' \
        '*::arg:->args'

    case "$state" in
        cmd)
            _describe -t commands 'better command' commands
            ;;
        args)
            case "${words[1]}" in
                cache)
                    _values 'subcommand' 'stats[Show cache statistics]' 'gc[Run garbage collection]'
                    ;;
                scripts)
                    _values 'subcommand' 'list[List scripts]' 'scan[Scan for scripts]' 'allow[Allow a script]' 'block[Block a script]'
                    ;;
                policy)
                    _values 'subcommand' 'check[Check policy]' 'init[Initialize policy]'
                    ;;
                lock)
                    _values 'subcommand' 'generate[Generate lock metadata]' 'verify[Verify lock metadata]'
                    ;;
                workspace|ws)
                    _values 'subcommand' 'list[List workspaces]' 'graph[Show dependency graph]' 'changed[Show changed packages]' 'run[Run command in workspaces]'
                    ;;
                env)
                    _values 'subcommand' 'check[Check environment]'
                    ;;
                hooks)
                    _values 'subcommand' 'install[Install git hooks]'
                    ;;
                completions)
                    _values 'shell' 'bash' 'zsh' 'fish' 'powershell'
                    ;;
                init)
                    _arguments '--name[Project name]:name:' '--template[Template]:template:(react next express)'
                    ;;
                sbom)
                    _arguments '--format[Output format]:format:(cyclonedx spdx)'
                    ;;
                audit)
                    _arguments '--min-severity[Minimum severity]:severity:(low medium high critical)'
                    ;;
            esac
            ;;
    esac
}

_better "$@"
"#
}

fn generate_fish_completions() -> &'static str {
    r#"# Fish completions for better / better-core

# Disable file completions by default
complete -c better -f
complete -c better-core -f

# Commands
complete -c better -n "__fish_use_subcommand" -a install -d "Wrap your package manager install"
complete -c better -n "__fish_use_subcommand" -a analyze -d "Analyze node_modules sizes and duplication"
complete -c better -n "__fish_use_subcommand" -a cache -d "Inspect/manage Better cache"
complete -c better -n "__fish_use_subcommand" -a doctor -d "Dependency health checks and score"
complete -c better -n "__fish_use_subcommand" -a serve -d "Start web UI server"
complete -c better -n "__fish_use_subcommand" -a benchmark -d "Run comparative install benchmark"
complete -c better -n "__fish_use_subcommand" -a lock -d "Generate/verify lock metadata"
complete -c better -n "__fish_use_subcommand" -a policy -d "Dependency policy enforcement"
complete -c better -n "__fish_use_subcommand" -a workspace -d "Workspace management"
complete -c better -n "__fish_use_subcommand" -a audit -d "Scan for known vulnerabilities"
complete -c better -n "__fish_use_subcommand" -a dashboard -d "Interactive TUI dashboard"
complete -c better -n "__fish_use_subcommand" -a run -d "Run package.json scripts"
complete -c better -n "__fish_use_subcommand" -a why -d "Show why a package is installed"
complete -c better -n "__fish_use_subcommand" -a dedupe -d "Detect duplicate packages"
complete -c better -n "__fish_use_subcommand" -a license -d "Scan for package licenses"
complete -c better -n "__fish_use_subcommand" -a outdated -d "Check for newer versions"
complete -c better -n "__fish_use_subcommand" -a scripts -d "Manage install script sandboxing"
complete -c better -n "__fish_use_subcommand" -a exec -d "Execute a script file"
complete -c better -n "__fish_use_subcommand" -a env -d "Show/check environment info"
complete -c better -n "__fish_use_subcommand" -a init -d "Initialize a new project"
complete -c better -n "__fish_use_subcommand" -a hooks -d "Install git hooks"
complete -c better -n "__fish_use_subcommand" -a sbom -d "Generate SBOM"
complete -c better -n "__fish_use_subcommand" -a completions -d "Generate shell completions"
complete -c better -n "__fish_use_subcommand" -a scan -d "Scan node_modules tree"
complete -c better -n "__fish_use_subcommand" -a lint -d "Run lint script"
complete -c better -n "__fish_use_subcommand" -a test -d "Run test script"
complete -c better -n "__fish_use_subcommand" -a dev -d "Run dev script (watch mode)"
complete -c better -n "__fish_use_subcommand" -a build -d "Run build script"
complete -c better -n "__fish_use_subcommand" -a start -d "Run start script"
complete -c better -n "__fish_use_subcommand" -a version -d "Show version"
complete -c better -n "__fish_use_subcommand" -a help -d "Show help"

# Copy all completions for better-core
complete -c better-core -n "__fish_use_subcommand" -a install -d "Wrap your package manager install"
complete -c better-core -n "__fish_use_subcommand" -a analyze -d "Analyze node_modules sizes and duplication"
complete -c better-core -n "__fish_use_subcommand" -a cache -d "Inspect/manage Better cache"
complete -c better-core -n "__fish_use_subcommand" -a doctor -d "Dependency health checks and score"
complete -c better-core -n "__fish_use_subcommand" -a serve -d "Start web UI server"
complete -c better-core -n "__fish_use_subcommand" -a benchmark -d "Run comparative install benchmark"
complete -c better-core -n "__fish_use_subcommand" -a lock -d "Generate/verify lock metadata"
complete -c better-core -n "__fish_use_subcommand" -a policy -d "Dependency policy enforcement"
complete -c better-core -n "__fish_use_subcommand" -a workspace -d "Workspace management"
complete -c better-core -n "__fish_use_subcommand" -a audit -d "Scan for known vulnerabilities"
complete -c better-core -n "__fish_use_subcommand" -a dashboard -d "Interactive TUI dashboard"
complete -c better-core -n "__fish_use_subcommand" -a run -d "Run package.json scripts"
complete -c better-core -n "__fish_use_subcommand" -a why -d "Show why a package is installed"
complete -c better-core -n "__fish_use_subcommand" -a dedupe -d "Detect duplicate packages"
complete -c better-core -n "__fish_use_subcommand" -a license -d "Scan for package licenses"
complete -c better-core -n "__fish_use_subcommand" -a outdated -d "Check for newer versions"
complete -c better-core -n "__fish_use_subcommand" -a scripts -d "Manage install script sandboxing"
complete -c better-core -n "__fish_use_subcommand" -a exec -d "Execute a script file"
complete -c better-core -n "__fish_use_subcommand" -a env -d "Show/check environment info"
complete -c better-core -n "__fish_use_subcommand" -a init -d "Initialize a new project"
complete -c better-core -n "__fish_use_subcommand" -a hooks -d "Install git hooks"
complete -c better-core -n "__fish_use_subcommand" -a sbom -d "Generate SBOM"
complete -c better-core -n "__fish_use_subcommand" -a completions -d "Generate shell completions"
complete -c better-core -n "__fish_use_subcommand" -a scan -d "Scan node_modules tree"
complete -c better-core -n "__fish_use_subcommand" -a lint -d "Run lint script"
complete -c better-core -n "__fish_use_subcommand" -a test -d "Run test script"
complete -c better-core -n "__fish_use_subcommand" -a dev -d "Run dev script (watch mode)"
complete -c better-core -n "__fish_use_subcommand" -a build -d "Run build script"
complete -c better-core -n "__fish_use_subcommand" -a start -d "Run start script"
complete -c better-core -n "__fish_use_subcommand" -a version -d "Show version"
complete -c better-core -n "__fish_use_subcommand" -a help -d "Show help"

# Subcommands
complete -c better -n "__fish_seen_subcommand_from cache" -a "stats gc"
complete -c better -n "__fish_seen_subcommand_from scripts" -a "list scan allow block"
complete -c better -n "__fish_seen_subcommand_from policy" -a "check init"
complete -c better -n "__fish_seen_subcommand_from lock" -a "generate verify"
complete -c better -n "__fish_seen_subcommand_from workspace" -a "list graph changed run"
complete -c better -n "__fish_seen_subcommand_from env" -a "check"
complete -c better -n "__fish_seen_subcommand_from hooks" -a "install"
complete -c better -n "__fish_seen_subcommand_from completions" -a "bash zsh fish powershell"

complete -c better-core -n "__fish_seen_subcommand_from cache" -a "stats gc"
complete -c better-core -n "__fish_seen_subcommand_from scripts" -a "list scan allow block"
complete -c better-core -n "__fish_seen_subcommand_from policy" -a "check init"
complete -c better-core -n "__fish_seen_subcommand_from lock" -a "generate verify"
complete -c better-core -n "__fish_seen_subcommand_from workspace" -a "list graph changed run"
complete -c better-core -n "__fish_seen_subcommand_from env" -a "check"
complete -c better-core -n "__fish_seen_subcommand_from hooks" -a "install"
complete -c better-core -n "__fish_seen_subcommand_from completions" -a "bash zsh fish powershell"

# Global options
complete -c better -l json -d "Machine-readable JSON output"
complete -c better -l cache-root -d "Override cache root" -r -F
complete -c better -l log-level -d "Log level" -r -a "debug info warn error silent"
complete -c better -l config -d "Config file path" -r -F
complete -c better -l project-root -d "Project root" -r -F
complete -c better -l lockfile -d "Lockfile path" -r -F
complete -c better -s h -l help -d "Show help"
complete -c better -s v -l version -d "Show version"

complete -c better-core -l json -d "Machine-readable JSON output"
complete -c better-core -l cache-root -d "Override cache root" -r -F
complete -c better-core -l log-level -d "Log level" -r -a "debug info warn error silent"
complete -c better-core -l config -d "Config file path" -r -F
complete -c better-core -l project-root -d "Project root" -r -F
complete -c better-core -l lockfile -d "Lockfile path" -r -F
complete -c better-core -s h -l help -d "Show help"
complete -c better-core -s v -l version -d "Show version"
"#
}

fn generate_powershell_completions() -> &'static str {
    r#"Register-ArgumentCompleter -Native -CommandName @('better', 'better-core') -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commands = @(
        @{ Name = 'install';     Description = 'Wrap your package manager install' }
        @{ Name = 'analyze';     Description = 'Analyze node_modules sizes and duplication' }
        @{ Name = 'cache';       Description = 'Inspect/manage Better cache' }
        @{ Name = 'doctor';      Description = 'Dependency health checks and score' }
        @{ Name = 'serve';       Description = 'Start web UI server' }
        @{ Name = 'benchmark';   Description = 'Run comparative install benchmark' }
        @{ Name = 'lock';        Description = 'Generate/verify lock metadata' }
        @{ Name = 'policy';      Description = 'Dependency policy enforcement' }
        @{ Name = 'workspace';   Description = 'Workspace management' }
        @{ Name = 'audit';       Description = 'Scan for known vulnerabilities' }
        @{ Name = 'dashboard';   Description = 'Interactive TUI dashboard' }
        @{ Name = 'run';         Description = 'Run package.json scripts' }
        @{ Name = 'why';         Description = 'Show why a package is installed' }
        @{ Name = 'dedupe';      Description = 'Detect duplicate packages' }
        @{ Name = 'license';     Description = 'Scan for package licenses' }
        @{ Name = 'outdated';    Description = 'Check for newer versions' }
        @{ Name = 'scripts';     Description = 'Manage install script sandboxing' }
        @{ Name = 'exec';        Description = 'Execute a script file' }
        @{ Name = 'env';         Description = 'Show/check environment info' }
        @{ Name = 'init';        Description = 'Initialize a new project' }
        @{ Name = 'hooks';       Description = 'Install git hooks' }
        @{ Name = 'sbom';        Description = 'Generate SBOM' }
        @{ Name = 'completions'; Description = 'Generate shell completions' }
        @{ Name = 'scan';        Description = 'Scan node_modules tree' }
        @{ Name = 'lint';        Description = 'Run lint script' }
        @{ Name = 'test';        Description = 'Run test script' }
        @{ Name = 'dev';         Description = 'Run dev script (watch mode)' }
        @{ Name = 'build';       Description = 'Run build script' }
        @{ Name = 'start';       Description = 'Run start script' }
        @{ Name = 'version';     Description = 'Show version' }
        @{ Name = 'help';        Description = 'Show help' }
    )

    $subcommands = @{
        'cache'       = @('stats', 'gc')
        'scripts'     = @('list', 'scan', 'allow', 'block')
        'policy'      = @('check', 'init')
        'lock'        = @('generate', 'verify')
        'workspace'   = @('list', 'graph', 'changed', 'run')
        'env'         = @('check')
        'hooks'       = @('install')
        'completions' = @('bash', 'zsh', 'fish', 'powershell')
    }

    $elements = $commandAst.CommandElements
    if ($elements.Count -ge 2) {
        $cmd = $elements[1].ToString()
        if ($subcommands.ContainsKey($cmd)) {
            $subcommands[$cmd] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
            return
        }
    }

    $commands | Where-Object { $_.Name -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_.Name, $_.Name, 'ParameterValue', $_.Description)
    }
}
"#
}

/// Semantic exit codes for agent mode
/// 0=success, 1=dependency-error, 2=security-blocked, 3=policy-failure, 4=network-error
fn agent_exit(kind: &str, raw_code: i32, agent_mode: bool) -> i32 {
    if !agent_mode {
        return raw_code;
    }
    match kind {
        "security" | "audit" => 2,
        "policy" => 3,
        "network" => 4,
        _ => if raw_code == 0 { 0 } else { 1 },
    }
}

fn main() {
    let (command, global_flags) = parse_args();
    let json_mode = global_flags.json || global_flags.agent_mode;
    let agent_mode = global_flags.agent_mode;

    match command {
        Command::Registry { subcommand, registry_url, scope, token_env, priority } => {
            match subcommand.as_str() {
                "add" => {
                    let url = match registry_url {
                        Some(u) => u,
                        None => {
                            eprintln!("error: 'registry add' requires a URL");
                            std::process::exit(2);
                        }
                    };
                    match registry_add(&url, scope.as_deref(), token_env.as_deref(), priority) {
                        Ok(path) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.registry.add");
                            w.key("url"); w.value_string(&url);
                            if let Some(ref s) = scope { w.key("scope"); w.value_string(s); }
                            w.key("path"); w.value_string(&path);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.registry.add");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "list" | "ls" => {
                    match registry_list() {
                        Ok(config) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.registry.list");
                            w.key("registries"); w.begin_array();
                            for entry in &config.registries {
                                w.begin_object();
                                w.key("url"); w.value_string(&entry.url);
                                match &entry.scope {
                                    Some(s) => { w.key("scope"); w.value_string(s); }
                                    None => { w.key("scope"); w.value_null(); }
                                }
                                if let Some(ref te) = entry.token_env {
                                    w.key("tokenEnv"); w.value_string(te);
                                }
                                w.key("priority"); w.value_u64(entry.priority);
                                w.end_object();
                            }
                            w.end_array();
                            w.key("total"); w.value_u64(config.registries.len() as u64);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.registry.list");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "remove" | "rm" => {
                    let url = match registry_url {
                        Some(u) => u,
                        None => {
                            eprintln!("error: 'registry remove' requires a URL");
                            std::process::exit(2);
                        }
                    };
                    match registry_remove(&url) {
                        Ok(removed) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.registry.remove");
                            w.key("url"); w.value_string(&url);
                            w.key("removed"); w.value_u64(removed);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.registry.remove");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "rotate" => {
                    match registry_rotate(scope.as_deref()) {
                        Ok(msg) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.registry.rotate");
                            w.key("message"); w.value_string(&msg);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.registry.rotate");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                other => {
                    eprintln!("error: unknown registry subcommand: {other}");
                    std::process::exit(2);
                }
            }
        }

        Command::Provenance { project_root: _, lockfile, require } => {
            let resolve_result = match resolve_from_lockfile(&lockfile) {
                Ok(r) => r,
                Err(reason) => {
                    eprintln!("error: {reason}");
                    std::process::exit(1);
                }
            };
            let mode = if require { "require" } else { "verify" };
            match verify_provenance(&resolve_result.packages, mode) {
                Ok(report) => {
                    let json = write_provenance_json(&report);
                    println!("{json}");
                    if require && report.without_provenance > 0 {
                        std::process::exit(1);
                    }
                }
                Err(reason) => {
                    eprintln!("error: {reason}");
                    std::process::exit(1);
                }
            }
        }

        Command::Receipts { project_root, subcommand } => {
            match subcommand.as_str() {
                "list" => {
                    match list_receipts(&project_root) {
                        Ok(receipts) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("kind"); w.value_string("better.receipts.list");
                            w.key("count"); w.value_u64(receipts.len() as u64);
                            w.key("receipts"); w.begin_array();
                            for r in &receipts {
                                w.begin_object();
                                w.key("timestamp"); w.value_string(&r.timestamp);
                                w.key("betterVersion"); w.value_string(&r.better_version);
                                w.key("packagesInstalled"); w.value_u64(r.packages_installed);
                                if let Some(score) = r.policy_score {
                                    w.key("policyScore"); w.value_i64(score as i64);
                                }
                                if let Some(ref hash) = r.lockfile_hash {
                                    w.key("lockfileHash"); w.value_string(hash);
                                }
                                w.end_object();
                            }
                            w.end_array();
                            w.end_object();
                            println!("{}", w.finish());
                        }
                        Err(reason) => {
                            eprintln!("error: {reason}");
                            std::process::exit(1);
                        }
                    }
                }
                "verify" => {
                    match verify_receipt(&project_root) {
                        Ok(result) => {
                            let json = write_receipt_verify_json(&result);
                            println!("{json}");
                            if !result.ok {
                                std::process::exit(1);
                            }
                        }
                        Err(reason) => {
                            eprintln!("error: {reason}");
                            std::process::exit(1);
                        }
                    }
                }
                other => {
                    eprintln!("error: unknown receipts subcommand: {other}");
                    eprintln!("usage: better receipts [list|verify]");
                    std::process::exit(2);
                }
            }
        }

        Command::Firewall { project_root, subcommand } => {
            match subcommand.as_str() {
                "enable" => {
                    let mut config = load_firewall_config(&project_root);
                    config.enabled = true;
                    match save_firewall_config(&project_root, &config) {
                        Ok(()) => println!("{{\"ok\":true,\"message\":\"firewall enabled\"}}"),
                        Err(reason) => {
                            eprintln!("error: {reason}");
                            std::process::exit(1);
                        }
                    }
                }
                "disable" => {
                    let mut config = load_firewall_config(&project_root);
                    config.enabled = false;
                    match save_firewall_config(&project_root, &config) {
                        Ok(()) => println!("{{\"ok\":true,\"message\":\"firewall disabled\"}}"),
                        Err(reason) => {
                            eprintln!("error: {reason}");
                            std::process::exit(1);
                        }
                    }
                }
                "rules" => {
                    let config = load_firewall_config(&project_root);
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("kind"); w.value_string("better.firewall.rules");
                    w.key("enabled"); w.value_bool(config.enabled);
                    w.key("typosquatDetection"); w.value_bool(config.typosquat_detection);
                    w.key("binaryDetection"); w.value_bool(config.binary_detection);
                    w.key("newPackageWarning"); w.value_bool(config.new_package_warning);
                    w.key("maxLevenshteinDistance"); w.value_u64(config.max_levenshtein_distance as u64);
                    w.key("newPackageDays"); w.value_u64(config.new_package_days);
                    w.end_object();
                    println!("{}", w.finish());
                }
                "scan" => {
                    let lockfile = project_root.join("package-lock.json");
                    let resolve_result = match resolve_from_lockfile(&lockfile) {
                        Ok(r) => r,
                        Err(reason) => {
                            eprintln!("error: {reason}");
                            std::process::exit(1);
                        }
                    };
                    let config = load_firewall_config(&project_root);
                    let report = run_firewall(&resolve_result.packages, &project_root, &config);
                    let json = write_firewall_json(&report);
                    println!("{json}");
                    if report.blocked > 0 {
                        std::process::exit(agent_exit("security", 1, agent_mode));
                    }
                }
                other => {
                    eprintln!("error: unknown firewall subcommand: {other}");
                    eprintln!("usage: better firewall [enable|disable|rules|scan]");
                    std::process::exit(2);
                }
            }
        }

        Command::Shell { project_root } => {
            if !better_core::is_python_project(&project_root) {
                eprintln!("error: not a Python project (no pyproject.toml / requirements.txt)");
                std::process::exit(2);
            }
            // Ensure venv exists
            match better_core::create_venv(&project_root) {
                Ok(result) => {
                    if result.created {
                        eprintln!("Created venv at {} (Python {})", result.venv_path.display(), result.python_version);
                    }
                }
                Err(reason) => {
                    eprintln!("error: {reason}");
                    std::process::exit(1);
                }
            }
            match better_core::spawn_shell(&project_root) {
                Ok(code) => std::process::exit(code),
                Err(reason) => {
                    eprintln!("error: {reason}");
                    std::process::exit(1);
                }
            }
        }

        Command::Migrate { project_root, from } => {
            match better_core::migrate_lockfile(&project_root, &from) {
                Ok(result) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.migrate");
                    w.key("from"); w.value_string(&result.source);
                    w.key("packages"); w.value_u64(result.package_count as u64);
                    w.key("lockfile"); w.value_string(&result.lockfile_path);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.migrate");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

        Command::Completions { shell } => {
            match shell.as_str() {
                "bash" => print!("{}", generate_bash_completions()),
                "zsh" => print!("{}", generate_zsh_completions()),
                "fish" => print!("{}", generate_fish_completions()),
                "powershell" | "ps" | "pwsh" => print!("{}", generate_powershell_completions()),
                _ => {
                    eprintln!("Unknown shell: {shell}");
                    eprintln!("Supported shells: bash, zsh, fish, powershell");
                    std::process::exit(1);
                }
            }
        }
        Command::Context { project_root, package, all, gc, force, ecosystem } => {
            if gc {
                // better context gc
                match context::cache::gc(30, false) {
                    Ok(result) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(true);
                        w.key("kind"); w.value_string("better.context.gc");
                        w.key("removed"); w.value_u64(result.removed);
                        w.key("freedBytes"); w.value_u64(result.freed_bytes);
                        w.key("kept"); w.value_u64(result.kept);
                        w.end_object(); w.out.push('
');
                        print!("{}", w.finish());
                    }
                    Err(reason) => {
                        eprintln!("error: {reason}");
                        std::process::exit(1);
                    }
                }
            } else if all {
                // better context --all
                let cache_root = default_cache_root();
                match context::generate_all_context(&project_root, &cache_root, force) {
                    Ok(result) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(true);
                        w.key("kind"); w.value_string("better.context.all");
                        w.key("generated"); w.value_u64(result.generated as u64);
                        w.key("cached"); w.value_u64(result.cached as u64);
                        w.key("failed"); w.value_u64(result.failed.len() as u64);
                        w.key("totalMs"); w.value_u64(result.total_ms);
                        w.key("outputDir"); w.value_string(&result.output_dir);
                        w.end_object(); w.out.push('
');
                        print!("{}", w.finish());
                        eprintln!("  context: generated {} (cached: {}, failed: {}) in {}ms",
                            result.generated, result.cached, result.failed.len(), result.total_ms);
                    }
                    Err(reason) => {
                        eprintln!("error: {reason}");
                        std::process::exit(1);
                    }
                }
            } else if let Some(pkg_name) = package {
                // better context <package>
                // Check cache first
                let eco = ecosystem.as_deref().unwrap_or("npm");
                let nm_path = project_root.join("node_modules").join(&pkg_name).join("package.json");
                let version = if nm_path.exists() {
                    let content = std::fs::read_to_string(&nm_path).unwrap_or_default();
                    better_core::extract_json_field(&content, "version").unwrap_or_else(|| "0.0.0".to_string())
                } else {
                    "0.0.0".to_string()
                };

                if let Some(cached) = context::cache::read_cached(eco, &pkg_name, &version) {
                    println!("{}", cached);
                } else {
                    match context::generate_context(&project_root, &pkg_name, ecosystem.as_deref()) {
                        Ok(ctx) => {
                            // Cache it
                            context::cache::write_cached(eco, &pkg_name, &version, &ctx.markdown, false).ok();
                            println!("{}", ctx.markdown);
                        }
                        Err(reason) => {
                            eprintln!("error: {reason}");
                            std::process::exit(1);
                        }
                    }
                }
            } else {
                // Show context cache stats
                match context::cache::stats() {
                    Ok(stats) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(true);
                        w.key("kind"); w.value_string("better.context.stats");
                        w.key("totalEntries"); w.value_u64(stats.total_entries as u64);
                        w.key("totalSizeBytes"); w.value_u64(stats.total_size_bytes);
                        w.key("npmEntries"); w.value_u64(stats.npm_entries as u64);
                        w.key("pythonEntries"); w.value_u64(stats.python_entries as u64);
                        w.end_object(); w.out.push('
');
                        print!("{}", w.finish());
                    }
                    Err(reason) => {
                        eprintln!("error: {reason}");
                        std::process::exit(1);
                    }
                }
            }
        }

        Command::Mcp { transport } => {
            match transport.as_str() {
                "stdio" | "" => {
                    let transport = better_core::mcp::transport::StdioTransport::new();
                    let mut server = better_core::mcp::server::McpServer::new(transport);
                    server.run().unwrap_or_else(|e| {
                        eprintln!("MCP server error: {}", e);
                        std::process::exit(1);
                    });
                }
                _ => {
                    eprintln!("unknown transport: {} (use 'stdio')", transport);
                    std::process::exit(1);
                }
            }
        }

        Command::Search { query, ecosystem, limit } => {
            match search::search(&query, ecosystem.as_deref(), limit) {
                Ok(result) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(true);
                    w.key("kind"); w.value_string("better.search");
                    w.key("query"); w.value_string(&query);
                    w.key("total"); w.value_u64(result.total as u64);
                    w.key("searchMs"); w.value_u64(result.search_ms);
                    w.key("packages"); w.begin_array();
                    for pkg in &result.packages {
                        w.begin_object();
                        w.key("name"); w.value_string(&pkg.name);
                        w.key("ecosystem"); w.value_string(&pkg.ecosystem);
                        w.key("version"); w.value_string(&pkg.version);
                        w.key("description"); w.value_string(&pkg.description);
                        w.key("score"); w.value_f64(pkg.score);
                        w.key("downloadsWeekly"); w.value_u64(pkg.downloads_weekly);
                        w.key("hasTypes"); w.value_bool(pkg.has_types);
                        match &pkg.license {
                            Some(l) => { w.key("license"); w.value_string(l); }
                            None => { w.key("license"); w.value_null(); }
                        }
                        w.end_object();
                    }
                    w.end_array();
                    w.end_object(); w.out.push('
');
                    print!("{}", w.finish());
                }
                Err(reason) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(false);
                    w.key("kind"); w.value_string("better.search");
                    w.key("reason"); w.value_string(&reason);
                    w.end_object(); w.out.push('
');
                    print!("{}", w.finish());
                    std::process::exit(1);
                }
            }
        }

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
        Command::Install { lockfile, project_root, cache_root, store_root, link_strategy, jobs: _, scripts, dedup, frozen, json_progress, node_layout, sandbox, verify_provenance: vp, require_provenance: rp } => {
            let started = Instant::now();

            // Engine detection: identify which ecosystem this project uses
            let registry = EngineRegistry::new();
            let detected_engines = registry.detect(&project_root);
            let engine_name = detected_engines.first().map(|e| e.name()).unwrap_or("npm");
            let _ = engine_name; // Will be used for multi-engine dispatch in future

            let npmrc = parse_npmrc(&project_root);
            let is_tty = std::io::stderr().is_terminal() && !json_mode;
            let progress = InstallProgress::new(is_tty, json_progress || json_mode);

            // Step 1: Resolve
            let t_resolve = Instant::now();
            progress.set_resolve_total(1);
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
            progress.set_resolve_total(resolve_result.packages.len() as u64);
            progress.finish_resolve();
            let phase_resolve_ms = t_resolve.elapsed().as_millis() as u64;

            // Frozen lockfile check: fail if better.lock exists and would change
            if frozen {
                match verify_frozen_lockfile(&project_root, &resolve_result.packages) {
                    Ok(true) => { /* lockfile matches, proceed */ }
                    Ok(false) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(false);
                        w.key("kind"); w.value_string("better.install.report");
                        w.key("reason"); w.value_string("--frozen: better.lock would change — lockfile is out of date");
                        w.end_object(); w.out.push('\n');
                        print!("{}", w.finish());
                        std::process::exit(1);
                    }
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
                }
            }

            // Step 2: Fetch
            let t_fetch = Instant::now();
            progress.set_fetch_total(resolve_result.packages.len() as u64);
            let fetch_result = match fetch_packages(&resolve_result.packages, &cache_root, Some(&npmrc)) {
                Ok(r) => {
                    progress.finish_fetch();
                    r
                }
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
            let mut strict_stats: Option<StrictMaterializeStats> = None;

            if node_layout == NodeLayout::Strict {
                // Strict mode: pnpm-style isolated node_modules with symlinks
                progress.set_extract_total(resolve_result.packages.len() as u64);
                match materialize_strict(
                    &resolve_result.packages,
                    &project_root,
                    &layout,
                    &file_cas_root,
                    link_strategy,
                ) {
                    Ok(ss) => {
                        total_files.store(ss.files_linked + ss.files_copied, std::sync::atomic::Ordering::Relaxed);
                        total_dirs.store(ss.directories, std::sync::atomic::Ordering::Relaxed);
                        total_symlinks.store(ss.internal_symlinks + ss.root_symlinks, std::sync::atomic::Ordering::Relaxed);
                        progress.finish_extract();
                        strict_stats = Some(ss);
                    }
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
                }
            } else {
                // Hoist mode: traditional flat node_modules
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
                progress.set_extract_total(resolve_result.packages.len() as u64);

                resolve_result.packages.par_iter().for_each(|pkg| {
                    if materialize_error.lock().ok().and_then(|g| g.as_ref().cloned()).is_some() { return; }
                    let (algo, hex) = match cas_key_from_integrity(&pkg.integrity) { Some(k) => k, None => { progress.inc_extract(); return } };
                    let unpacked = unpacked_path(&layout, &algo, &hex);
                    let src_dir = unpacked.join("package");
                    if !src_dir.exists() { progress.inc_extract(); return; }
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
                                progress.inc_extract();
                                return;
                            }
                        }
                        if try_clonefile_dir(&src_dir, &dest_path) {
                            cloned.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            progress.inc_extract();
                            return;
                        }
                    } else {
                        if try_clonefile_dir(&src_dir, &dest_path) {
                            cloned.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let _ = ingest_to_file_cas(&file_cas_root, &algo, &hex, &src_dir);
                            progress.inc_extract();
                            return;
                        }
                        let _ = ingest_to_file_cas(&file_cas_root, &algo, &hex, &src_dir);
                        if let Ok(result) = materialize_from_file_cas(&file_cas_root, &algo, &hex, &dest_path, link_strategy) {
                            if result.ok && result.files > 0 {
                                total_files.fetch_add(result.files, std::sync::atomic::Ordering::Relaxed);
                                cas_linked.fetch_add(result.linked, std::sync::atomic::Ordering::Relaxed);
                                cas_copied.fetch_add(result.copied, std::sync::atomic::Ordering::Relaxed);
                                total_symlinks.fetch_add(result.symlinks, std::sync::atomic::Ordering::Relaxed);
                                progress.inc_extract();
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
                    progress.inc_extract();
                });
                progress.finish_extract();

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
            }
            let phase_materialize_ms = t_mat.elapsed().as_millis() as u64;

            // Step 4: Bin links
            let t_bins = Instant::now();
            progress.set_link_total(resolve_result.packages.len() as u64);
            let bin_result = create_bin_links(&node_modules, &resolve_result.packages).unwrap_or_default();
            progress.finish_link();
            let phase_binlinks_ms = t_bins.elapsed().as_millis() as u64;

            // Step 5: Lifecycle scripts (with optional sandboxing)
            let t_scripts = Instant::now();
            let scripts_result = if scripts {
                let detection = detect_lifecycle_scripts(&node_modules, &resolve_result.packages);
                if sandbox {
                    let sandbox_policy = load_sandbox_policy(&project_root);
                    let mut result = LifecycleRunResult::default();
                    for script_info in &detection.scripts {
                        result.scripts_run += 1;
                        let perms = match permissions_for_package(
                            &sandbox_policy,
                            &script_info.package_name,
                            &script_info.package_dir,
                        ) {
                            Some(p) => p,
                            None => {
                                eprintln!("  sandbox: blocked scripts for {}", script_info.package_name);
                                result.scripts_failed += 1;
                                continue;
                            }
                        };
                        match execute_sandboxed(
                            "sh",
                            &["-c", &script_info.script_command],
                            &script_info.package_dir,
                            &perms,
                        ) {
                            Ok(sr) => {
                                if sr.exit_code == 0 {
                                    result.scripts_succeeded += 1;
                                } else {
                                    result.scripts_failed += 1;
                                    eprintln!("  sandbox: script failed for {} (exit {})", script_info.package_name, sr.exit_code);
                                }
                                for v in &sr.sandbox_violations {
                                    eprintln!("  sandbox violation: {}", v);
                                }
                            }
                            Err(e) => {
                                eprintln!("  sandbox error for {}: {}", script_info.package_name, e);
                                result.scripts_failed += 1;
                            }
                        }
                    }
                    result
                } else {
                    run_lifecycle_scripts(&project_root, &detection)
                }
            } else {
                LifecycleRunResult { skipped_reason: Some("disabled".into()), ..Default::default() }
            };
            let phase_scripts_ms = t_scripts.elapsed().as_millis() as u64;

            // Step 6: Write better.lock + better.lock.json (skip in frozen mode)
            let t_lockfile = Instant::now();
            let lockfile_result = if !frozen {
                let lw = LockfileWriter::from_resolved_packages(&resolve_result.packages);
                match lw.write_both(&project_root) {
                    Ok(r) => Some(r),
                    Err(_) => None, // non-fatal: lockfile writing failure shouldn't break install
                }
            } else {
                None
            };
            let phase_lockfile_ms = t_lockfile.elapsed().as_millis() as u64;

            // Step 7: Provenance verification (if requested)
            let mut provenance_packages: Vec<String> = Vec::new();
            if vp || rp {
                let mode = if rp { "require" } else { "verify" };
                match verify_provenance(&resolve_result.packages, mode) {
                    Ok(report) => {
                        for att in &report.attestations {
                            if att.has_attestation && att.signature_valid {
                                provenance_packages.push(format!("{}@{}", att.package, att.version));
                            }
                        }
                        if vp && report.without_provenance > 0 {
                            eprintln!("warning: {} package(s) lack provenance attestation", report.without_provenance);
                        }
                    }
                    Err(reason) => {
                        if rp {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.install.report");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(agent_exit("security", 1, agent_mode));
                        } else {
                            eprintln!("warning: provenance check failed: {}", reason);
                        }
                    }
                }
            }

            // Step 8: Dependency firewall
            let firewall_config = load_firewall_config(&project_root);
            let _firewall_report = if firewall_config.enabled {
                let report = run_firewall(&resolve_result.packages, &project_root, &firewall_config);
                if report.blocked > 0 {
                    eprintln!("firewall: {} package(s) blocked, {} warning(s)", report.blocked, report.warnings);
                    for alert in &report.alerts {
                        if alert.severity == "high" {
                            eprintln!("  BLOCKED: {}", alert.message);
                        }
                    }
                } else if report.warnings > 0 {
                    eprintln!("firewall: {} warning(s)", report.warnings);
                }
                Some(report)
            } else {
                None
            };

            // Step 9: Write install receipt
            let lockfile_hash = lockfile_result.as_ref().map(|lr| lr.fingerprint.clone());
            let _ = write_install_receipt(
                &project_root,
                &resolve_result.packages,
                None,
                lockfile_hash.as_deref(),
                &provenance_packages,
            );

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
            w.key("nodeLayout"); w.value_string(node_layout.as_str());
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
            if let Some(ref ss) = strict_stats {
                w.key("strict"); w.begin_object();
                w.key("packages"); w.value_u64(ss.packages);
                w.key("filesLinked"); w.value_u64(ss.files_linked);
                w.key("filesCopied"); w.value_u64(ss.files_copied);
                w.key("internalSymlinks"); w.value_u64(ss.internal_symlinks);
                w.key("rootSymlinks"); w.value_u64(ss.root_symlinks);
                w.key("directories"); w.value_u64(ss.directories);
                w.end_object();
            }
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
            if let Some(ref lr) = lockfile_result {
                w.key("betterLock"); w.begin_object();
                w.key("packageCount"); w.value_u64(lr.package_count as u64);
                w.key("binarySize"); w.value_u64(lr.binary_size);
                w.key("fingerprint"); w.value_string(&lr.fingerprint);
                w.end_object();
            }
            w.key("timing"); w.begin_object();
            w.key("resolveMs"); w.value_u64(phase_resolve_ms);
            w.key("fetchMs"); w.value_u64(phase_fetch_ms);
            w.key("materializeMs"); w.value_u64(phase_materialize_ms);
            w.key("binLinksMs"); w.value_u64(phase_binlinks_ms);
            w.key("scriptsMs"); w.value_u64(phase_scripts_ms);
            w.key("lockfileMs"); w.value_u64(phase_lockfile_ms);
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

        Command::License { root, allow, deny, policy } => {
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
            // License policy enforcement
            if policy {
                let project_root = root.parent().unwrap_or(std::path::Path::new("."));
                match load_license_policy(project_root) {
                    Ok(license_policy) => {
                        match check_license_policy(&root, &license_policy) {
                            Ok(result) => {
                                let mut w = JsonWriter::new();
                                w.begin_object();
                                w.key("ok"); w.value_bool(result.violations.is_empty());
                                w.key("kind"); w.value_string("better.license.policy");
                                w.key("totalChecked"); w.value_u64(result.total_checked);
                                w.key("passed"); w.value_u64(result.passed);
                                w.key("overridden"); w.value_u64(result.overridden);
                                w.key("violations"); w.begin_array();
                                for v in &result.violations {
                                    w.begin_object();
                                    w.key("package"); w.value_string(&v.package);
                                    w.key("version"); w.value_string(&v.version);
                                    w.key("license"); w.value_string(&v.license);
                                    w.key("reason"); w.value_string(&v.reason);
                                    w.end_object();
                                }
                                w.end_array();
                                w.key("warnings"); w.begin_array();
                                for v in &result.warnings {
                                    w.begin_object();
                                    w.key("package"); w.value_string(&v.package);
                                    w.key("version"); w.value_string(&v.version);
                                    w.key("license"); w.value_string(&v.license);
                                    w.key("reason"); w.value_string(&v.reason);
                                    w.end_object();
                                }
                                w.end_array();
                                w.end_object(); w.out.push('\n');
                                print!("{}", w.finish());
                                if !result.violations.is_empty() { std::process::exit(agent_exit("policy", 1, agent_mode)); }
                            }
                            Err(reason) => {
                                let mut w = JsonWriter::new();
                                w.begin_object();
                                w.key("ok"); w.value_bool(false);
                                w.key("kind"); w.value_string("better.license.policy");
                                w.key("reason"); w.value_string(&reason);
                                w.end_object(); w.out.push('\n');
                                print!("{}", w.finish());
                                std::process::exit(1);
                            }
                        }
                    }
                    Err(reason) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(false);
                        w.key("kind"); w.value_string("better.license.policy");
                        w.key("reason"); w.value_string(&reason);
                        w.end_object(); w.out.push('\n');
                        print!("{}", w.finish());
                        std::process::exit(1);
                    }
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

        Command::Doctor { project_root, threshold, unused } => {
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
                    // Unused dependency detection
                    if unused {
                        match detect_unused(&project_root) {
                            Ok(unused_result) => {
                                w.key("unused"); w.begin_object();
                                w.key("scannedFiles"); w.value_u64(unused_result.scanned_files as u64);
                                w.key("totalDeps"); w.value_u64(unused_result.total_deps as u64);
                                w.key("unused"); w.begin_array();
                                for pkg in &unused_result.unused {
                                    w.begin_object();
                                    w.key("name"); w.value_string(&pkg.name);
                                    w.key("version"); w.value_string(&pkg.version);
                                    w.key("isDev"); w.value_bool(pkg.is_dev);
                                    w.end_object();
                                }
                                w.end_array();
                                w.key("maybeUnused"); w.begin_array();
                                for pkg in &unused_result.maybe_unused {
                                    w.begin_object();
                                    w.key("name"); w.value_string(&pkg.name);
                                    w.key("version"); w.value_string(&pkg.version);
                                    w.key("isDev"); w.value_bool(pkg.is_dev);
                                    w.key("possibleScriptUse"); w.value_bool(pkg.possible_script_use);
                                    w.end_object();
                                }
                                w.end_array();
                                w.end_object();
                            }
                            Err(reason) => {
                                w.key("unused"); w.begin_object();
                                w.key("error"); w.value_string(&reason);
                                w.end_object();
                            }
                        }
                    }
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

        Command::Audit { project_root, lockfile, min_severity, strict, add_ignore, ignore_reason } => {
            // Handle --add-ignore: add a CVE to the ignore list
            if let Some(cve_id) = add_ignore {
                let reason = ignore_reason.unwrap_or_else(|| "No reason provided".to_string());
                match add_audit_ignore(&project_root, &cve_id, &reason) {
                    Ok(path) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(true);
                        w.key("kind"); w.value_string("better.audit.addIgnore");
                        w.key("id"); w.value_string(&cve_id);
                        w.key("reason"); w.value_string(&reason);
                        w.key("path"); w.value_string(&path);
                        w.end_object(); w.out.push('\n');
                        print!("{}", w.finish());
                    }
                    Err(err) => {
                        let mut w = JsonWriter::new();
                        w.begin_object();
                        w.key("ok"); w.value_bool(false);
                        w.key("kind"); w.value_string("better.audit.addIgnore");
                        w.key("reason"); w.value_string(&err);
                        w.end_object(); w.out.push('\n');
                        print!("{}", w.finish());
                        std::process::exit(agent_exit("security", 1, agent_mode));
                    }
                }
                return;
            }

            // Run audit with allow-listing support
            match run_audit_with_config(&lockfile, &project_root, &min_severity, strict) {
                Ok(report) => {
                    let mut w = JsonWriter::new();
                    w.begin_object();
                    w.key("ok"); w.value_bool(report.total == 0 && !report.strict_fail);
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
                    w.key("ignored"); w.value_u64(report.ignored_count);
                    w.end_object();
                    if !report.expired_warnings.is_empty() {
                        w.key("expiredWaivers"); w.begin_array();
                        for warning in &report.expired_warnings {
                            w.value_string(warning);
                        }
                        w.end_array();
                    }
                    if report.strict_fail {
                        w.key("strictFail"); w.value_bool(true);
                    }
                    w.end_object(); w.out.push('\n');
                    print!("{}", w.finish());
                    if report.total > 0 || report.strict_fail { std::process::exit(agent_exit("security", 1, agent_mode)); }
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
                "sandbox-scan" => {
                    match sandbox_scan(&project_root) {
                        Ok(result) => {
                            print!("{}", write_sandbox_scan_json(&result));
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.scripts.sandbox-scan");
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

        Command::Policy { project_root, subcommand, policy_arg, approved_by } => {
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
                            if !result.pass { std::process::exit(agent_exit("policy", 1, agent_mode)); }
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.policy.check");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(agent_exit("policy", 1, agent_mode));
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
                "approve" => {
                    let pattern = match policy_arg {
                        Some(p) => p,
                        None => {
                            eprintln!("error: 'policy approve' requires a package pattern (e.g. lodash@4.17.21)");
                            std::process::exit(2);
                        }
                    };
                    let by = approved_by.unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "unknown".to_string()));
                    match approve_package(&project_root, &pattern, &by) {
                        Ok(path) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.policy.approve");
                            w.key("pattern"); w.value_string(&pattern);
                            w.key("approvedBy"); w.value_string(&by);
                            w.key("path"); w.value_string(&path);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.policy.approve");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "revoke" => {
                    let name = match policy_arg {
                        Some(n) => n,
                        None => {
                            eprintln!("error: 'policy revoke' requires a package name");
                            std::process::exit(2);
                        }
                    };
                    match revoke_package(&project_root, &name) {
                        Ok(removed) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.policy.revoke");
                            w.key("package"); w.value_string(&name);
                            w.key("removed"); w.value_u64(removed);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.policy.revoke");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "pending" => {
                    match pending_packages(&project_root) {
                        Ok(result) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.policy.pending");
                            w.key("approved"); w.value_u64(result.approved_count);
                            w.key("unapproved"); w.begin_array();
                            for (name, version) in &result.unapproved {
                                w.begin_object();
                                w.key("name"); w.value_string(name);
                                w.key("version"); w.value_string(version);
                                w.end_object();
                            }
                            w.end_array();
                            w.key("total"); w.value_u64(result.unapproved.len() as u64);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.policy.pending");
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

        Command::Lock { project_root, subcommand, lock_args } => {
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
                "merge" => {
                    if lock_args.len() < 3 {
                        eprintln!("error: lock merge requires 3 arguments: <base> <ours> <theirs>");
                        std::process::exit(2);
                    }
                    let base_path = PathBuf::from(&lock_args[0]);
                    let ours_path = PathBuf::from(&lock_args[1]);
                    let theirs_path = PathBuf::from(&lock_args[2]);
                    match merge_lockfiles(&base_path, &ours_path, &theirs_path, &project_root) {
                        Ok(result) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(result.ok);
                            w.key("kind"); w.value_string("better.lock.merge");
                            w.key("totalPackages"); w.value_u64(result.total_packages as u64);
                            w.key("added"); w.begin_array();
                            for a in &result.added { w.value_string(a); }
                            w.end_array();
                            w.key("removed"); w.begin_array();
                            for r in &result.removed { w.value_string(r); }
                            w.end_array();
                            w.key("conflicts"); w.begin_array();
                            for c in &result.conflicts { w.value_string(c); }
                            w.end_array();
                            if let Some(ref wr) = result.write_result {
                                w.key("fingerprint"); w.value_string(&wr.fingerprint);
                            }
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            if !result.ok { std::process::exit(1); }
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.lock.merge");
                            w.key("reason"); w.value_string(&reason);
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                            std::process::exit(1);
                        }
                    }
                }
                "merge-driver" => {
                    // Git merge driver: better-core lock merge-driver %O %A %B
                    if lock_args.len() < 3 {
                        eprintln!("error: merge-driver requires 3 arguments: <base> <ours> <theirs>");
                        std::process::exit(2);
                    }
                    let base_path = PathBuf::from(&lock_args[0]);
                    let ours_path = PathBuf::from(&lock_args[1]);
                    let theirs_path = PathBuf::from(&lock_args[2]);
                    match run_merge_driver(&base_path, &ours_path, &theirs_path) {
                        Ok(result) => {
                            if !result.ok {
                                eprintln!("better.lock merge: {} conflict(s)", result.conflicts.len());
                                for c in &result.conflicts {
                                    eprintln!("  conflict: {}", c);
                                }
                                std::process::exit(1);
                            }
                            // Clean merge — exit 0
                        }
                        Err(reason) => {
                            eprintln!("better.lock merge failed: {}", reason);
                            std::process::exit(1);
                        }
                    }
                }
                "install-driver" => {
                    match install_merge_driver(&project_root) {
                        Ok(result) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(true);
                            w.key("kind"); w.value_string("better.lock.install-driver");
                            w.key("installed"); w.value_bool(result.installed);
                            w.key("filesModified"); w.begin_array();
                            for f in &result.files_modified { w.value_string(f); }
                            w.end_array();
                            w.end_object(); w.out.push('\n');
                            print!("{}", w.finish());
                        }
                        Err(reason) => {
                            let mut w = JsonWriter::new();
                            w.begin_object();
                            w.key("ok"); w.value_bool(false);
                            w.key("kind"); w.value_string("better.lock.install-driver");
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

        Command::Sbom { project_root, lockfile, format, vex } => {
            match generate_sbom_v2(&project_root, &lockfile, &format, vex) {
                Ok(output) => {
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
