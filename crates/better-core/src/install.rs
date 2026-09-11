//! Canonical install orchestration shared by the CLI and resident bindings.
use crate::fetch_pipeline::{ArtifactLimits, FetchOptions};
use crate::*;
use std::io::IsTerminal;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Debug)]
pub struct InstallOptions {
    pub lockfile: PathBuf,
    pub project_root: PathBuf,
    pub cache_root: PathBuf,
    pub store_root: Option<PathBuf>,
    pub link_strategy: LinkStrategy,
    pub jobs: usize,
    pub extraction_jobs: Option<usize>,
    pub artifact_limits: ArtifactLimits,
    pub scripts: bool,
    pub dedup: bool,
    pub frozen: bool,
    pub offline: bool,
    pub production: bool,
    pub target_os: String,
    pub target_cpu: String,
    pub json_progress: bool,
    pub node_layout: NodeLayout,
    pub sandbox: bool,
    pub verify_provenance: bool,
    pub require_provenance: bool,
    pub registry_failover: bool,
    pub json_mode: bool,
    pub progress_enabled: bool,
}

#[derive(Debug)]
pub struct InstallError {
    pub report: String,
}
impl InstallError {
    pub fn new(reason: impl Into<String>) -> Self {
        Self { report: serde_json::json!({"ok": false, "kind": "better.install.report", "reason": reason.into()}).to_string() + "\n" }
    }
}

/// Completes the install before returning. Never exits the host process.
pub fn run_install(options: InstallOptions) -> Result<String, InstallError> {
    let InstallOptions {
        lockfile,
        project_root,
        cache_root,
        store_root,
        link_strategy,
        jobs,
        extraction_jobs,
        artifact_limits,
        scripts,
        dedup,
        frozen,
        offline,
        production,
        target_os,
        target_cpu,
        json_progress,
        node_layout,
        sandbox,
        verify_provenance: vp,
        require_provenance: rp,
        registry_failover,
        json_mode,
        progress_enabled,
    } = options;
    // Every entry point must preserve the CLI's unsupported security-option gate.
    if sandbox || vp || rp {
        return Err(InstallError::new(
            "Sandbox and cryptographic provenance options are not supported for install",
        ));
    }
    FetchOptions {
        network_jobs: jobs,
        extract_jobs: extraction_jobs.unwrap_or(jobs),
        limits: artifact_limits,
    }
    .validate()
    .map_err(InstallError::new)?;
    let started = Instant::now();
    let _project_lease = project_install_lease(&project_root)?;

    let npmrc = parse_npmrc(&project_root);
    let is_tty = std::io::stderr().is_terminal() && !json_mode;
    let progress = if progress_enabled {
        InstallProgress::new(is_tty, json_progress || json_mode)
    } else {
        InstallProgress::disabled()
    };

    // Step 1: Resolve
    let t_resolve = Instant::now();
    progress.set_resolve_total(1);
    let resolve_result = match crate::fetch::resolve_from_lockfile_shared(&lockfile) {
        Ok(r) => r,
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
            return Err(InstallError { report: w.finish() });
        }
    };
    progress.set_resolve_total(resolve_result.packages.len() as u64);
    progress.finish_resolve();
    let phase_resolve_elapsed = t_resolve.elapsed();
    let phase_resolve_ms = phase_resolve_elapsed.as_millis() as u64;
    let phase_resolve_micros = phase_resolve_elapsed.as_micros().min(u64::MAX as u128) as u64;

    // Frozen lockfile check: fail if better.lock exists and would change
    if frozen {
        match verify_frozen_lockfile(&project_root, &resolve_result.packages) {
            Ok(true) => { /* lockfile matches, proceed */ }
            Ok(false) => {
                let mut w = JsonWriter::new();
                w.begin_object();
                w.key("ok");
                w.value_bool(false);
                w.key("kind");
                w.value_string("better.install.report");
                w.key("reason");
                w.value_string("--frozen: better.lock would change - lockfile is out of date");
                w.end_object();
                w.out.push('\n');
                return Err(InstallError { report: w.finish() });
            }
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
                return Err(InstallError { report: w.finish() });
            }
        }
    }

    let selected_packages =
        match crate::select_platform_packages(&resolve_result, production, &target_os, &target_cpu)
        {
            Ok(packages) => packages,
            Err(reason) => {
                return Err(InstallError::new(format!("{reason}")));
            }
        };
    if let Err(reason) = crate::validate_package_paths(&selected_packages) {
        return Err(InstallError::new(format!("{reason}")));
    }
    let refresh_tree = production || selected_packages.len() != resolve_result.packages.len();

    // Step 2: Fetch (skip network in --offline mode, only use CAS)
    let t_fetch = Instant::now();
    progress.set_fetch_total(selected_packages.len() as u64);
    let fetch_result = if offline {
        let result = crate::artifact_cache::prepare_offline_packages_with_options(
            &selected_packages,
            &cache_root,
            &FetchOptions {
                network_jobs: jobs,
                extract_jobs: extraction_jobs.unwrap_or(jobs),
                limits: artifact_limits,
            },
        )
        .map_err(InstallError::new)?;
        progress.finish_fetch();
        result
    } else {
        // Build registry chain for failover if requested
        let registry_chain = if registry_failover {
            let primary = &npmrc.default_registry;
            Some(RegistryChain::new(primary))
        } else {
            None
        };
        let _ = registry_chain; // chain available for future fetch integration

        match fetch_packages_with_options(
            &selected_packages,
            &cache_root,
            Some(&npmrc),
            &FetchOptions {
                network_jobs: jobs,
                extract_jobs: extraction_jobs.unwrap_or(jobs),
                limits: artifact_limits,
            },
        ) {
            Ok(r) => {
                progress.finish_fetch();
                r
            }
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
                return Err(InstallError { report: w.finish() });
            }
        }
    };
    let phase_fetch_elapsed = t_fetch.elapsed();
    let phase_fetch_ms = phase_fetch_elapsed.as_millis() as u64;
    let phase_fetch_micros = phase_fetch_elapsed.as_micros().min(u64::MAX as u128) as u64;
    // Hold stable source generations until materialization completes.
    let _package_leases =
        crate::artifact_cache::acquire_package_leases(&selected_packages, &cache_root)
            .map_err(InstallError::new)?;

    // Step 3: Materialize
    let t_mat = Instant::now();
    let layout = CasLayout::new(&cache_root);
    let file_cas_root = store_root.unwrap_or_else(|| cache_root.join("file-store"));
    let final_node_modules = project_root.join("node_modules");
    let fresh_tree = if node_layout == NodeLayout::Hoist
        && matches!(std::fs::symlink_metadata(&final_node_modules), Err(ref e) if e.kind() == std::io::ErrorKind::NotFound)
    {
        Some(FreshTree::new(&project_root)?)
    } else {
        None
    };
    let node_modules = fresh_tree
        .as_ref()
        .map(|tree| tree.path.clone())
        .unwrap_or_else(|| final_node_modules.clone());
    if std::fs::symlink_metadata(&node_modules).is_ok_and(|md| md.file_type().is_symlink()) {
        return Err(InstallError::new(format!(
            "Refusing a symlink node_modules destination"
        )));
    }
    // Refresh only after every selected package has passed fetch/cache checks.
    // This also removes stale dev bins and strict-layout store entries.
    if refresh_tree {
        for pkg in &selected_packages {
            let source = cas_key_from_integrity(&pkg.integrity)
                .map(|(algo, hex)| unpacked_path(&layout, &algo, &hex).join("package"));
            if !source.is_some_and(|path| path.is_dir() && path.join("package.json").is_file()) {
                return Err(InstallError::new(format!(
                    "Selected install requires a complete cached package: {}@{}",
                    pkg.name, pkg.version
                )));
            }
        }
    }
    if refresh_tree && fresh_tree.is_none() && node_modules.exists() {
        // A custom cache/store may live inside the tree being refreshed.
        // Resolve symlinks too: never delete fetched inputs during cleanup.
        if let Ok(tree) = node_modules.canonicalize() {
            for protected in [&cache_root, &file_cas_root] {
                if protected
                    .canonicalize()
                    .is_ok_and(|path| path.starts_with(&tree))
                {
                    return Err(InstallError::new(format!(
                        "Selected install requires cache and store roots outside node_modules: {}",
                        protected.display()
                    )));
                }
            }
        }
        if let Err(reason) = std::fs::remove_dir_all(&node_modules) {
            return Err(InstallError::new(format!(
                "Failed to refresh node_modules for selection: {reason}"
            )));
        }
    }
    if let Err(reason) = crate::create_materialize_dir(&node_modules, &node_modules) {
        return Err(InstallError::new(format!("{reason}")));
    }

    let total_files = std::sync::atomic::AtomicU64::new(0);
    let total_dirs = std::sync::atomic::AtomicU64::new(0);
    let total_symlinks = std::sync::atomic::AtomicU64::new(0);
    let files_reused = std::sync::atomic::AtomicU64::new(0);
    let symlinks_reused = std::sync::atomic::AtomicU64::new(0);
    let cloned = std::sync::atomic::AtomicU64::new(0);
    let cas_linked = std::sync::atomic::AtomicU64::new(0);
    let cas_copied = std::sync::atomic::AtomicU64::new(0);
    let fallback_materialized = std::sync::atomic::AtomicU64::new(0);
    // Diagnostic work sums across concurrently materialized packages, not wall time.
    let materialize_scan_work_us = std::sync::atomic::AtomicU64::new(0);
    let materialize_mkdir_work_us = std::sync::atomic::AtomicU64::new(0);
    let materialize_copy_work_us = std::sync::atomic::AtomicU64::new(0);
    let archive_snapshot_packages = std::sync::atomic::AtomicU64::new(0);
    let mut strict_stats: Option<StrictMaterializeStats> = None;

    if node_layout == NodeLayout::Strict {
        // Strict mode: pnpm-style isolated node_modules with symlinks
        progress.set_extract_total(selected_packages.len() as u64);
        match materialize_strict(
            &selected_packages,
            &project_root,
            &layout,
            &file_cas_root,
            link_strategy,
        ) {
            Ok(ss) => {
                total_files.store(
                    ss.files_linked + ss.files_copied + ss.files_reused,
                    std::sync::atomic::Ordering::Relaxed,
                );
                total_dirs.store(ss.directories, std::sync::atomic::Ordering::Relaxed);
                total_symlinks.store(
                    ss.internal_symlinks + ss.root_symlinks + ss.package_symlinks,
                    std::sync::atomic::Ordering::Relaxed,
                );
                files_reused.store(ss.files_reused, std::sync::atomic::Ordering::Relaxed);
                symlinks_reused.store(ss.symlinks_reused, std::sync::atomic::Ordering::Relaxed);
                progress.finish_extract();
                strict_stats = Some(ss);
            }
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
                return Err(InstallError { report: w.finish() });
            }
        }
    } else {
        // Hoist mode: traditional flat node_modules
        for pkg in &selected_packages {
            let dest_path = if pkg.rel_path.starts_with("node_modules/") {
                node_modules.join(&pkg.rel_path[13..])
            } else {
                node_modules.join(&pkg.rel_path)
            };
            if let Some(parent) = dest_path.parent() {
                if let Err(reason) = crate::create_materialize_dir(&node_modules, parent) {
                    return Err(InstallError::new(format!("{reason}")));
                }
            }
        }

        use rayon::prelude::*;
        let materialize_error: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
        progress.set_extract_total(selected_packages.len() as u64);

        // Materializing a parent may replace its entire directory. Finish
        // shallower packages before descendants; siblings remain parallel.
        let mut layers = std::collections::BTreeMap::new();
        for pkg in &selected_packages {
            let depth = std::path::Path::new(&pkg.rel_path).components().count();
            layers.entry(depth).or_insert_with(Vec::new).push(pkg);
        }
        let materialize_pool = crate::analyze::materialize_pool().map_err(InstallError::new)?;
        for packages in layers.values() {
            materialize_pool.install(|| {
                packages.par_iter().for_each(|pkg| {
                    if materialize_error
                        .lock()
                        .ok()
                        .and_then(|g| g.as_ref().cloned())
                        .is_some()
                    {
                        return;
                    }
                    let (algo, hex) = match cas_key_from_integrity(&pkg.integrity) {
                        Some(k) => k,
                        None => {
                            progress.inc_extract();
                            return;
                        }
                    };
                    let unpacked = unpacked_path(&layout, &algo, &hex);
                    let src_dir = unpacked.join("package");
                    if !src_dir.is_dir() {
                        if let Ok(mut guard) = materialize_error.lock() {
                            *guard =
                                Some(format!("Missing materialization source for {}", pkg.name));
                        }
                        return;
                    }
                    let dest_path = if pkg.rel_path.starts_with("node_modules/") {
                        node_modules.join(&pkg.rel_path[13..])
                    } else {
                        node_modules.join(&pkg.rel_path)
                    };

                    let use_snapshot = !dedup && fresh_tree.is_none() && dest_path.is_dir()
                        && matches!(link_strategy, LinkStrategy::Auto | LinkStrategy::Copy);
                    if let Err(reason) = crate::create_materialize_dir(&node_modules, &dest_path) {
                        if let Ok(mut guard) = materialize_error.lock() {
                            *guard = Some(reason);
                        }
                        return;
                    }

                    if use_snapshot {
                        match crate::archive_materialize::reconcile(
                            &tarball_path(&layout, &algo, &hex), &pkg.integrity,
                            &dest_path, artifact_limits,
                        ) {
                            Ok(Some((stats, phases))) => {
                                use std::sync::atomic::Ordering::Relaxed;
                                total_files.fetch_add(stats.files, Relaxed);
                                total_dirs.fetch_add(stats.directories, Relaxed);
                                files_reused.fetch_add(stats.files_reused, Relaxed);
                                materialize_scan_work_us.fetch_add(phases.scan_us, Relaxed);
                                materialize_mkdir_work_us.fetch_add(phases.mkdir_us, Relaxed);
                                materialize_copy_work_us.fetch_add(phases.link_copy_us, Relaxed);
                                archive_snapshot_packages.fetch_add(1, Relaxed);
                                fallback_materialized.fetch_add(1, Relaxed);
                                progress.inc_extract();
                                return;
                            }
                            Ok(None) => {}
                            Err(reason) => {
                                if let Ok(mut guard) = materialize_error.lock() { *guard = Some(reason); }
                                return;
                            }
                        }
                    }

                    if dedup {
                        let _ = ingest_to_file_cas(&file_cas_root, &algo, &hex, &src_dir);
                        if let Ok(result) = materialize_from_file_cas(
                            &file_cas_root,
                            &algo,
                            &hex,
                            &dest_path,
                            link_strategy,
                        ) {
                            if result.ok && result.files > 0 {
                                total_files
                                    .fetch_add(result.files, std::sync::atomic::Ordering::Relaxed);
                                files_reused.fetch_add(
                                    result.files_reused,
                                    std::sync::atomic::Ordering::Relaxed,
                                );
                                symlinks_reused.fetch_add(
                                    result.symlinks_reused,
                                    std::sync::atomic::Ordering::Relaxed,
                                );
                                cas_linked
                                    .fetch_add(result.linked, std::sync::atomic::Ordering::Relaxed);
                                cas_copied
                                    .fetch_add(result.copied, std::sync::atomic::Ordering::Relaxed);
                                total_symlinks.fetch_add(
                                    result.symlinks,
                                    std::sync::atomic::Ordering::Relaxed,
                                );
                                progress.inc_extract();
                                return;
                            }
                        }
                        if matches!(link_strategy, LinkStrategy::Auto)
                            && try_clonefile_dir(&src_dir, &dest_path)
                        {
                            cloned.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            progress.inc_extract();
                            return;
                        }
                    } else {
                        if matches!(link_strategy, LinkStrategy::Auto)
                            && try_clonefile_dir(&src_dir, &dest_path)
                        {
                            cloned.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            progress.inc_extract();
                            return;
                        }
                        // File CAS is demand-driven. Reconcile directly from the
                        // verified unpacked tree when deduplication was not requested.
                    }

                    match crate::analyze::materialize_tree_with(
                        &src_dir,
                        &dest_path,
                        link_strategy,
                        4,
                        MaterializeProfile::Auto,
                        fresh_tree.is_some(),
                    ) {
                        Ok(report) => {
                            materialize_scan_work_us.fetch_add(
                                report.phases.scan_us,
                                std::sync::atomic::Ordering::Relaxed,
                            );
                            materialize_mkdir_work_us.fetch_add(
                                report.phases.mkdir_us,
                                std::sync::atomic::Ordering::Relaxed,
                            );
                            materialize_copy_work_us.fetch_add(
                                report.phases.link_copy_us,
                                std::sync::atomic::Ordering::Relaxed,
                            );
                            total_files.fetch_add(
                                report.stats.files,
                                std::sync::atomic::Ordering::Relaxed,
                            );
                            files_reused.fetch_add(
                                report.stats.files_reused,
                                std::sync::atomic::Ordering::Relaxed,
                            );
                            symlinks_reused.fetch_add(
                                report.stats.symlinks_reused,
                                std::sync::atomic::Ordering::Relaxed,
                            );
                            total_dirs.fetch_add(
                                report.stats.directories,
                                std::sync::atomic::Ordering::Relaxed,
                            );
                            total_symlinks.fetch_add(
                                report.stats.symlinks,
                                std::sync::atomic::Ordering::Relaxed,
                            );
                            fallback_materialized
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                        Err(reason) => {
                            if let Ok(mut guard) = materialize_error.lock() {
                                if guard.is_none() {
                                    *guard = Some(format!(
                                        "Failed to materialize {}: {}",
                                        pkg.name, reason
                                    ));
                                }
                            }
                        }
                    }
                    progress.inc_extract();
                })
            });
        }
        progress.finish_extract();

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
            return Err(InstallError { report: w.finish() });
        }
    }
    let phase_materialize_elapsed = t_mat.elapsed();
    let phase_materialize_ms = phase_materialize_elapsed.as_millis() as u64;
    let phase_materialize_micros =
        phase_materialize_elapsed.as_micros().min(u64::MAX as u128) as u64;
    drop(_package_leases);

    // Step 4: Bin links
    let t_bins = Instant::now();
    progress.set_link_total(selected_packages.len() as u64);
    let bin_result = required_bin_links(&node_modules, &selected_packages)?;
    progress.finish_link();
    let phase_binlinks_elapsed = t_bins.elapsed();
    let phase_binlinks_ms = phase_binlinks_elapsed.as_millis() as u64;
    let phase_binlinks_micros = phase_binlinks_elapsed.as_micros().min(u64::MAX as u128) as u64;

    let t_activation = Instant::now();
    if let Some(tree) = &fresh_tree {
        tree.publish(&final_node_modules)?;
    }
    let phase_activation_micros = t_activation.elapsed().as_micros().min(u64::MAX as u128) as u64;
    let node_modules = final_node_modules;

    // Step 5: Lifecycle scripts (with optional sandboxing)
    let t_scripts = Instant::now();
    let scripts_result = if scripts {
        let detection = detect_lifecycle_scripts(&node_modules, &selected_packages);
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
                        eprintln!(
                            "  sandbox: blocked scripts for {}",
                            script_info.package_name
                        );
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
                            eprintln!(
                                "  sandbox: script failed for {} (exit {})",
                                script_info.package_name, sr.exit_code
                            );
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
            run_lifecycle_scripts_for_install(&project_root, &detection, production)
        }
    } else {
        LifecycleRunResult {
            skipped_reason: Some("disabled".into()),
            ..Default::default()
        }
    };
    let phase_scripts_elapsed = t_scripts.elapsed();
    let phase_scripts_ms = phase_scripts_elapsed.as_millis() as u64;
    let phase_scripts_micros = phase_scripts_elapsed.as_micros().min(u64::MAX as u128) as u64;

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
    let phase_lockfile_elapsed = t_lockfile.elapsed();
    let phase_lockfile_ms = phase_lockfile_elapsed.as_millis() as u64;
    let phase_lockfile_micros = phase_lockfile_elapsed.as_micros().min(u64::MAX as u128) as u64;

    let t_provenance = Instant::now();
    // Step 7: Provenance verification (if requested)
    let mut provenance_packages: Vec<String> = Vec::new();
    if vp || rp {
        let mode = if rp { "require" } else { "verify" };
        match crate::provenance::verify_provenance_with_config(&selected_packages, mode, &npmrc) {
            Ok(report) => {
                for att in &report.attestations {
                    if att.has_attestation && att.signature_valid {
                        provenance_packages.push(format!("{}@{}", att.package, att.version));
                    }
                }
                if vp && report.without_provenance > 0 {
                    eprintln!(
                        "warning: {} package(s) lack provenance attestation",
                        report.without_provenance
                    );
                }
            }
            Err(reason) => {
                if rp {
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
                    return Err(InstallError { report: w.finish() });
                } else {
                    eprintln!("warning: provenance check failed: {}", reason);
                }
            }
        }
    }

    let phase_provenance_micros = t_provenance.elapsed().as_micros().min(u64::MAX as u128) as u64;
    let t_firewall = Instant::now();
    // Step 8: Dependency firewall
    let firewall_config = load_firewall_config(&project_root);
    let _firewall_report = if firewall_config.enabled {
        let report = run_firewall(&selected_packages, &project_root, &firewall_config);
        if report.blocked > 0 {
            eprintln!(
                "firewall: {} package(s) blocked, {} warning(s)",
                report.blocked, report.warnings
            );
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

    let phase_firewall_micros = t_firewall.elapsed().as_micros().min(u64::MAX as u128) as u64;
    let t_receipt = Instant::now();
    // Step 9: Write install receipt
    let lockfile_hash = lockfile_result.as_ref().map(|lr| lr.fingerprint.clone());
    let _ = write_install_receipt(
        &project_root,
        &selected_packages,
        None,
        lockfile_hash.as_deref(),
        &provenance_packages,
    );

    let phase_receipt_micros = t_receipt.elapsed().as_micros().min(u64::MAX as u128) as u64;
    let duration = started.elapsed();
    let duration_ms = duration.as_millis() as u64;
    let duration_micros = duration.as_micros().min(u64::MAX as u128) as u64;
    let total_files = total_files.load(std::sync::atomic::Ordering::Relaxed);
    let total_dirs = total_dirs.load(std::sync::atomic::Ordering::Relaxed);
    let total_symlinks = total_symlinks.load(std::sync::atomic::Ordering::Relaxed);
    let cloned = cloned.load(std::sync::atomic::Ordering::Relaxed);
    let cas_linked = cas_linked.load(std::sync::atomic::Ordering::Relaxed);
    let cas_copied = cas_copied.load(std::sync::atomic::Ordering::Relaxed);
    let fallback_materialized = fallback_materialized.load(std::sync::atomic::Ordering::Relaxed);

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
    w.key("preparedTree");
    w.value_bool(fresh_tree.is_some());
    w.key("nodeLayout");
    w.value_string(node_layout.as_str());
    w.key("target");
    w.begin_object();
    w.key("os");
    w.value_string(&target_os);
    w.key("cpu");
    w.value_string(&target_cpu);
    w.end_object();
    w.key("stats");
    w.begin_object();
    w.key("packagesResolved");
    w.value_u64(selected_packages.len() as u64);
    w.key("packagesFetched");
    w.value_u64(fetch_result.packages_fetched);
    w.key("packagesCached");
    w.value_u64(fetch_result.packages_cached);
    w.key("bytesDownloaded");
    w.value_u64(fetch_result.bytes_downloaded);
    w.key("fetchMetrics");
    w.begin_object();
    w.key("networkJobs");
    w.value_u64(fetch_result.metrics.network_jobs as u64);
    w.key("extractJobs");
    w.value_u64(fetch_result.metrics.extract_jobs as u64);
    w.key("queueCapacity");
    w.value_u64(fetch_result.metrics.queue_capacity as u64);
    w.key("peakPreparing");
    w.value_u64(fetch_result.metrics.peak_preparing as u64);
    w.key("peakExtracting");
    w.value_u64(fetch_result.metrics.peak_extracting as u64);
    w.key("prepareMicros");
    w.value_u64(fetch_result.metrics.prepare_micros as u64);
    w.key("extractMicros");
    w.value_u64(fetch_result.metrics.extract_micros as u64);
    w.key("backpressureMicros");
    w.value_u64(fetch_result.metrics.backpressure_micros as u64);
    w.end_object();
    w.key("files");
    w.value_u64(total_files);
    w.key("directories");
    w.value_u64(total_dirs);
    w.key("symlinks");
    w.value_u64(total_symlinks);
    w.key("filesReused");
    w.value_u64(files_reused.load(std::sync::atomic::Ordering::Relaxed));
    w.key("archiveSnapshotPackages");
    w.value_u64(archive_snapshot_packages.load(std::sync::atomic::Ordering::Relaxed));
    w.key("symlinksReused");
    w.value_u64(symlinks_reused.load(std::sync::atomic::Ordering::Relaxed));
    w.key("cloned");
    w.value_u64(cloned);
    w.key("casLinked");
    w.value_u64(cas_linked);
    w.key("casCopied");
    w.value_u64(cas_copied);
    w.key("fallbackMaterialized");
    w.value_u64(fallback_materialized);
    w.end_object();
    if let Some(ref ss) = strict_stats {
        w.key("strict");
        w.begin_object();
        w.key("packages");
        w.value_u64(ss.packages);
        w.key("filesLinked");
        w.value_u64(ss.files_linked);
        w.key("filesCopied");
        w.value_u64(ss.files_copied);
        w.key("filesReused");
        w.value_u64(ss.files_reused);
        w.key("symlinksReused");
        w.value_u64(ss.symlinks_reused);
        w.key("packageSymlinks");
        w.value_u64(ss.package_symlinks);
        w.key("internalSymlinks");
        w.value_u64(ss.internal_symlinks);
        w.key("rootSymlinks");
        w.value_u64(ss.root_symlinks);
        w.key("directories");
        w.value_u64(ss.directories);
        w.end_object();
    }
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
    if let Some(ref lr) = lockfile_result {
        w.key("betterLock");
        w.begin_object();
        w.key("packageCount");
        w.value_u64(lr.package_count as u64);
        w.key("binarySize");
        w.value_u64(lr.binary_size);
        w.key("fingerprint");
        w.value_string(&lr.fingerprint);
        w.end_object();
    }
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
    w.key("lockfileMs");
    w.value_u64(phase_lockfile_ms);
    w.key("totalMs");
    w.value_u64(duration_ms);
    w.key("resolveMicros");
    w.value_u64(phase_resolve_micros);
    w.key("fetchMicros");
    w.value_u64(phase_fetch_micros);
    w.key("materializeMicros");
    w.value_u64(phase_materialize_micros);
    w.key("materializeScanWorkMicros");
    w.value_u64(materialize_scan_work_us.load(std::sync::atomic::Ordering::Relaxed));
    w.key("materializeMkdirWorkMicros");
    w.value_u64(materialize_mkdir_work_us.load(std::sync::atomic::Ordering::Relaxed));
    w.key("materializeCopyWorkMicros");
    w.value_u64(materialize_copy_work_us.load(std::sync::atomic::Ordering::Relaxed));
    w.key("binLinksMicros");
    w.value_u64(phase_binlinks_micros);
    w.key("scriptsMicros");
    w.value_u64(phase_scripts_micros);
    w.key("lockfileMicros");
    w.value_u64(phase_lockfile_micros);
    w.key("provenanceMicros");
    w.value_u64(phase_provenance_micros);
    w.key("firewallMicros");
    w.value_u64(phase_firewall_micros);
    w.key("receiptMicros");
    w.value_u64(phase_receipt_micros);
    w.key("activationMicros");
    w.value_u64(phase_activation_micros);
    w.key("totalMicros");
    w.value_u64(duration_micros);
    w.end_object();
    w.end_object();
    w.out.push('\n');
    Ok(w.finish())
}

/// Cooperative project writer lease. A nested install fails promptly instead of
/// deadlocking its parent lifecycle script. The stable lock file is never removed.
fn project_install_lease(project_root: &std::path::Path) -> Result<std::fs::File, InstallError> {
    let state = project_root.join(".better");
    crate::create_materialize_dir(project_root, &state).map_err(InstallError::new)?;
    let path = state.join("install.lock");
    if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err(InstallError::new("Install lock must be a regular file"));
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| InstallError::new(format!("Cannot open install lock: {e}")))?;
    let linked = std::fs::symlink_metadata(&path).map_err(|e| InstallError::new(e.to_string()))?;
    if !linked.is_file() || linked.file_type().is_symlink() {
        return Err(InstallError::new("Install lock changed during open"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = file
            .metadata()
            .map_err(|e| InstallError::new(e.to_string()))?;
        if (opened.dev(), opened.ino()) != (linked.dev(), linked.ino()) {
            return Err(InstallError::new("Install lock changed during open"));
        }
    }
    file.try_lock()
        .map_err(|e| InstallError::new(format!("Project install is busy or unavailable: {e}")))?;
    Ok(file)
}

/// Only fresh hoist trees use private preparation. Existing trees and strict
/// layouts retain their current reconciliation path. This is not a filesystem
/// transaction covering lifecycle scripts or arbitrary external writers.
struct FreshTree {
    path: PathBuf,
    container: PathBuf,
}
impl FreshTree {
    fn new(project_root: &std::path::Path) -> Result<Self, InstallError> {
        loop {
            let path = project_root.join(format!(
                ".better-install-stage-{}-{:016x}",
                std::process::id(),
                rand::random::<u64>()
            ));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&path) {
                Ok(()) => {
                    // Keep staging private through its parent while allowing the
                    // published tree to inherit the ordinary directory mode and
                    // process umask. Never inspect or mutate the global umask.
                    let tree = Self {
                        path: path.join("tree"),
                        container: path,
                    };
                    std::fs::create_dir(&tree.path).map_err(|e| {
                        InstallError::new(format!("Cannot create prepared tree: {e}"))
                    })?;
                    return Ok(tree);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(InstallError::new(format!(
                        "Cannot prepare install tree: {e}"
                    )))
                }
            }
        }
    }
    fn publish(&self, destination: &std::path::Path) -> Result<(), InstallError> {
        match std::fs::symlink_metadata(destination) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(InstallError::new(
                    "Install destination appeared during preparation",
                ))
            }
            Err(e) => return Err(InstallError::new(e.to_string())),
        }
        std::fs::rename(&self.path, destination)
            .map_err(|e| InstallError::new(format!("Cannot activate prepared tree: {e}")))
    }
}
impl Drop for FreshTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.container);
    }
}

fn required_bin_links(
    root: &std::path::Path,
    packages: &[ResolvedPackage],
) -> Result<BinLinkResult, InstallError> {
    let result = create_bin_links(root, packages).map_err(InstallError::new)?;
    if result.links_failed > 0 {
        return Err(InstallError::new(format!(
            "Failed to create {} executable bin link(s)",
            result.links_failed
        )));
    }
    Ok(result)
}

#[cfg(test)]
mod preparation_tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn private_container_preserves_normal_published_tree_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let control = root.path().join("control");
        std::fs::create_dir(&control).unwrap();
        let expected = std::fs::metadata(&control).unwrap().permissions().mode() & 0o777;
        let tree = FreshTree::new(root.path()).unwrap();
        assert_eq!(
            std::fs::metadata(&tree.container)
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0
        );
        assert_eq!(
            std::fs::metadata(&tree.path).unwrap().permissions().mode() & 0o777,
            expected
        );
        let container = tree.container.clone();
        let final_path = root.path().join("node_modules");
        tree.publish(&final_path).unwrap();
        drop(tree);
        assert!(!container.exists());
        assert_eq!(
            std::fs::metadata(final_path).unwrap().permissions().mode() & 0o777,
            expected
        );
    }
    #[test]
    fn bin_directory_failure_drops_private_tree_before_activation() {
        let root = tempfile::tempdir().unwrap();
        {
            let tree = FreshTree::new(root.path()).unwrap();
            std::fs::write(tree.path.join(".bin"), "conflict").unwrap();
            assert!(required_bin_links(&tree.path, &[]).is_err());
            assert!(!root.path().join("node_modules").exists());
        }
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
