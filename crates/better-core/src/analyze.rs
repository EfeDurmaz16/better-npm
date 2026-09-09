use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use rayon::prelude::*;
use std::time::Instant;

use crate::types::*;
use crate::{stable_list_dir, physical_len, identity_key, is_package_dir,
            read_package_identity, depth_from_path, percentile_p95,
            hardlink_with_retry,
            JsonWriter, VERSION};

// --- Core functions ---

pub fn scan_tree(
    root: &Path,
    exclude_dir_names: &HashSet<&'static str>,
    mut seen_identities: Option<&mut HashSet<(u64, u64)>>,
) -> Result<ScanAgg, String> {
    let mut agg = ScanAgg::default();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match stable_list_dir(&dir) {
            Ok(v) => v,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::NotADirectory {
                    continue;
                }
                return Err(e.to_string());
            }
        };

        for ent in entries {
            let name = ent.file_name();
            let name_str = name.to_string_lossy();
            if exclude_dir_names.contains(name_str.as_ref()) {
                continue;
            }
            let full = dir.join(&name);
            let ft = ent.file_type().map_err(|e| e.to_string())?;

            if ft.is_dir() || (ft.is_symlink() && fs::metadata(&full).map(|m| m.is_dir()).unwrap_or(false)) {
                if is_package_dir(&full) {
                    agg.package_count += 1;
                }
                stack.push(full);
                continue;
            }

            agg.file_count += 1;
            let md = fs::symlink_metadata(&full).map_err(|e| e.to_string())?;
            let logical_len = md.len();
            let phys_len = physical_len(&md);
            agg.logical += logical_len;

            let (a, b, reliable) = identity_key(&md);
            if !reliable {
                agg.approx = true;
            }

            if let Some(seen) = seen_identities.as_deref_mut() {
                let key = (a, b);
                if a == 0 && b == 0 {
                    agg.approx = true;
                    agg.physical += phys_len;
                } else if seen.insert(key) {
                    agg.physical += phys_len;
                } else {
                    agg.shared += phys_len;
                }
            } else {
                agg.physical += phys_len;
            }
        }
    }

    Ok(agg)
}

pub(crate) fn materialize_worker_limit() -> usize {
    static LIMIT: OnceLock<usize> = OnceLock::new();
    *LIMIT.get_or_init(|| {
        std::thread::available_parallelism()
            .map_or(1, usize::from)
            .min(4)
    })
}

/// One process-wide filesystem executor. Nested package work shares these workers
/// instead of creating a second set of threads for each package.
pub(crate) fn materialize_pool() -> Result<&'static rayon::ThreadPool, String> {
    static POOL: OnceLock<Result<rayon::ThreadPool, String>> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(materialize_worker_limit())
            .thread_name(|index| format!("better-materialize-{index}"))
            .build()
            .map_err(|error| format!("materialize executor: {error}"))
    })
    .as_ref()
    .map_err(Clone::clone)
}

pub fn run_materialize_tasks_parallel(
    tasks: Vec<MaterializeTask>,
    strategy: LinkStrategy,
    jobs: usize,
    counters: &MaterializeCounters,
) -> Result<(), String> {
    if tasks.is_empty() {
        return Ok(());
    }
    let pool = materialize_pool()?;
    let workers = jobs.max(1).min(pool.current_num_threads());
    let chunk_size = tasks.len().div_ceil(workers);
    pool.install(|| {
        tasks.par_chunks(chunk_size).try_for_each(|chunk| {
            let mut staging = crate::MaterializeStaging::default();
            chunk.iter().try_for_each(|task| match task {
                MaterializeTask::File(task) => {
                    counters.files.fetch_add(1, Ordering::Relaxed);
                    match strategy {
                        LinkStrategy::Copy | LinkStrategy::Auto => {
                            let reused = staging.copy_if_changed(&task.src, &task.dst, None)?;
                            if reused {
                                counters.files_reused.fetch_add(1, Ordering::Relaxed);
                            } else {
                                counters.files_copied.fetch_add(1, Ordering::Relaxed);
                            }
                            Ok(())
                        }
                        LinkStrategy::Hardlink => match hardlink_with_retry(&task.src, &task.dst) {
                            Ok(()) => {
                                counters.files_linked.fetch_add(1, Ordering::Relaxed);
                                Ok(())
                            }
                            Err(link_err) => {
                                if link_err.contains("EPERM")
                                    || link_err.contains("Operation not permitted")
                                {
                                    counters.fallback_eperm.fetch_add(1, Ordering::Relaxed);
                                } else if link_err.contains("EXDEV")
                                    || link_err.contains("cross-device")
                                {
                                    counters.fallback_exdev.fetch_add(1, Ordering::Relaxed);
                                } else {
                                    counters.fallback_other.fetch_add(1, Ordering::Relaxed);
                                }
                                if let Err(err) = staging.copy(&task.src, &task.dst, None) {
                                    Err(err)
                                } else {
                                    counters.files_copied.fetch_add(1, Ordering::Relaxed);
                                    counters
                                        .link_fallback_copies
                                        .fetch_add(1, Ordering::Relaxed);
                                    Ok(())
                                }
                            }
                        },
                    }
                }
                MaterializeTask::Symlink(task) => {
                    let reused = staging.symlink_if_changed(task)?;
                    counters.symlinks.fetch_add(1, Ordering::Relaxed);
                    if reused {
                        counters.symlinks_reused.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(())
                }
            })
        })
    })
}

pub fn materialize_tree(
    src_root: &Path,
    dst_root: &Path,
    strategy: LinkStrategy,
    jobs: usize,
    profile: MaterializeProfile,
) -> Result<MaterializeReport, String> {
    let total_start = Instant::now();
    let mut phases = PhaseDurations::default();

    // Scan phase
    let scan_start = Instant::now();
    let mut directories: Vec<PathBuf> = vec![dst_root.to_path_buf()];
    let mut tasks: Vec<MaterializeTask> = Vec::new();
    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(src_root.to_path_buf(), dst_root.to_path_buf())];

    while let Some((src_dir, dst_dir)) = stack.pop() {
        let entries = stable_list_dir(&src_dir).map_err(|e| e.to_string())?;
        for ent in entries {
            let name = ent.file_name();
            let name_str = name.to_string_lossy();
            if name_str == "node_modules" || name_str == ".better_extracted" {
                continue;
            }

            let src = src_dir.join(&name);
            let dst = dst_dir.join(&name);
            let ft = ent.file_type().map_err(|e| e.to_string())?;

            if ft.is_dir() {
                directories.push(dst.clone());
                stack.push((src, dst));
                continue;
            }
            if ft.is_symlink() {
                let target = fs::read_link(&src).map_err(|e| e.to_string())?;
                crate::validate_materialize_symlink(dst_root, &dst, &target)?;
                tasks.push(MaterializeTask::Symlink(MaterializeSymlinkTask {
                    src,
                    dst,
                    target,
                }));
                continue;
            }
            if ft.is_file() {
                tasks.push(MaterializeTask::File(MaterializeFileTask { src, dst }));
                continue;
            }
        }
    }
    let scan_elapsed = scan_start.elapsed();
    phases.scan_ms = scan_elapsed.as_millis() as u64;
    phases.scan_us = scan_elapsed.as_micros() as u64;

    // Mkdir phase
    let mkdir_start = Instant::now();
    directories.sort();
    directories.dedup();
    for dir in &directories {
        crate::create_materialize_dir(dst_root, dir)?;
    }
    let mkdir_elapsed = mkdir_start.elapsed();
    phases.mkdir_ms = mkdir_elapsed.as_millis() as u64;
    phases.mkdir_us = mkdir_elapsed.as_micros() as u64;

    // Adjust jobs based on profile
    let effective_jobs = match profile {
        MaterializeProfile::Auto => jobs,
        MaterializeProfile::IoHeavy => jobs.saturating_mul(2).max(4),
        MaterializeProfile::SmallFiles => jobs.saturating_mul(3).max(8),
    };

    // Link/copy phase
    let link_start = Instant::now();
    let counters = MaterializeCounters::default();
    run_materialize_tasks_parallel(tasks, strategy, effective_jobs, &counters)?;
    let link_copy_elapsed = link_start.elapsed();
    phases.link_copy_ms = link_copy_elapsed.as_millis() as u64;
    phases.link_copy_us = link_copy_elapsed.as_micros() as u64;

    let total_elapsed = total_start.elapsed();
    phases.total_ms = total_elapsed.as_millis() as u64;
    phases.total_us = total_elapsed.as_micros() as u64;

    let mut stats = counters.snapshot();
    stats.directories = directories.len().saturating_sub(1) as u64;
    Ok(MaterializeReport { stats, phases })
}

fn ensure_pkg_idx(
    pkg_dir: &PathBuf,
    pkg_dir_to_idx: &mut HashMap<PathBuf, Option<usize>>,
    by_key: &mut HashMap<String, usize>,
    packages: &mut Vec<PackageOut>,
    depths: &mut Vec<u64>,
) -> Option<usize> {
    if let Some(cached) = pkg_dir_to_idx.get(pkg_dir) {
        return *cached;
    }

    let (name, version) = match read_package_identity(pkg_dir) {
        Some(v) => v,
        None => {
            pkg_dir_to_idx.insert(pkg_dir.clone(), None);
            return None;
        }
    };
    let key = format!("{name}@{version}");
    let depth = depth_from_path(pkg_dir);

    let idx = if let Some(&i) = by_key.get(&key) {
        i
    } else {
        let i = packages.len();
        by_key.insert(key.clone(), i);
        packages.push(PackageOut {
            key,
            name,
            version,
            paths: Vec::new(),
            min_depth: depth,
            max_depth: depth,
            logical: 0,
            physical: 0,
            shared: 0,
            file_count: 0,
            approx: false,
        });
        i
    };

    let p = pkg_dir.to_string_lossy().to_string();
    if !packages[idx].paths.contains(&p) {
        packages[idx].paths.push(p);
        packages[idx].min_depth = packages[idx].min_depth.min(depth);
        packages[idx].max_depth = packages[idx].max_depth.max(depth);
        depths.push(depth);
    }

    pkg_dir_to_idx.insert(pkg_dir.clone(), Some(idx));
    Some(idx)
}

pub fn analyze(root: &Path, _include_graph: bool) -> Result<AnalyzeReport, String> {
    let node_modules_dir = root.join("node_modules");
    if !node_modules_dir.exists() {
        return Err("node_modules_not_found".to_string());
    }

    let mut totals = ScanAgg::default();
    let mut seen_global: HashSet<(u64, u64)> = HashSet::new();

    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut packages: Vec<PackageOut> = Vec::new();
    let mut depths: Vec<u64> = Vec::new();
    let mut pkg_dir_to_idx: HashMap<PathBuf, Option<usize>> = HashMap::new();

    let mut stack: Vec<(PathBuf, Option<usize>)> = vec![(node_modules_dir.clone(), None)];
    while let Some((dir, owner_idx)) = stack.pop() {
        let entries = match stable_list_dir(&dir) {
            Ok(v) => v,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::NotADirectory {
                    continue;
                }
                return Err(e.to_string());
            }
        };

        for ent in entries {
            let name = ent.file_name();
            let full = dir.join(&name);
            let ft = ent.file_type().map_err(|e| e.to_string())?;

            if ft.is_dir() || (ft.is_symlink() && fs::metadata(&full).map(|m| m.is_dir()).unwrap_or(false)) {
                let next_owner = if is_package_dir(&full) {
                    ensure_pkg_idx(&full, &mut pkg_dir_to_idx, &mut by_key, &mut packages, &mut depths)
                } else {
                    owner_idx
                };
                stack.push((full, next_owner));
                continue;
            }

            totals.file_count += 1;
            let md = fs::symlink_metadata(&full).map_err(|e| e.to_string())?;
            let logical_len = md.len();
            let phys_len = physical_len(&md);
            totals.logical = totals.logical.saturating_add(logical_len);

            let (a, b, reliable) = identity_key(&md);
            if !reliable {
                totals.approx = true;
            }

            if let Some(idx) = owner_idx {
                let pkg = &mut packages[idx];
                pkg.file_count = pkg.file_count.saturating_add(1);
                pkg.logical = pkg.logical.saturating_add(logical_len);
                if !reliable {
                    pkg.approx = true;
                }
            }

            if a == 0 && b == 0 {
                totals.approx = true;
                totals.physical = totals.physical.saturating_add(phys_len);
                if let Some(idx) = owner_idx {
                    let pkg = &mut packages[idx];
                    pkg.approx = true;
                    pkg.physical = pkg.physical.saturating_add(phys_len);
                }
                continue;
            }

            let first = seen_global.insert((a, b));
            if first {
                totals.physical = totals.physical.saturating_add(phys_len);
                if let Some(idx) = owner_idx {
                    packages[idx].physical = packages[idx].physical.saturating_add(phys_len);
                }
            } else {
                totals.shared = totals.shared.saturating_add(phys_len);
                if let Some(idx) = owner_idx {
                    packages[idx].shared = packages[idx].shared.saturating_add(phys_len);
                }
            }
        }
    }

    // Duplicates.
    let mut by_name: BTreeMap<String, Vec<&PackageOut>> = BTreeMap::new();
    for p in &packages {
        by_name.entry(p.name.clone()).or_default().push(p);
    }
    let mut duplicates: Vec<DuplicateOut> = Vec::new();
    for (name, list) in by_name {
        let mut versions: BTreeSet<String> = BTreeSet::new();
        for p in &list {
            versions.insert(p.version.clone());
        }
        if versions.len() <= 1 {
            continue;
        }
        let versions_vec: Vec<String> = versions.into_iter().collect();
        let majors_set: BTreeSet<String> = versions_vec
            .iter()
            .map(|v| v.split('.').next().unwrap_or("0").parse::<u64>().unwrap_or(0).to_string())
            .collect();
        duplicates.push(DuplicateOut {
            name,
            versions: versions_vec,
            majors: majors_set.into_iter().collect(),
            count: list.len() as u64,
        });
    }

    let max_depth = depths.iter().copied().max().unwrap_or(0);
    let p95_depth = percentile_p95(depths);
    let depth_out = DepthOut {
        max_depth,
        p95_depth,
    };

    Ok(AnalyzeReport {
        totals,
        packages,
        duplicates,
        depth: depth_out,
        node_modules_dir,
    })
}

// --- JSON serialization functions (used by binary) ---

pub fn write_analyze_json(
    project_root: &Path,
    totals: &ScanAgg,
    node_modules_dir: &Path,
    packages: &Vec<PackageOut>,
    duplicates: &Vec<DuplicateOut>,
    depth: &DepthOut,
    include_graph: bool,
) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("ok");
    w.value_bool(true);
    w.key("kind");
    w.value_string("better.analyze.report");
    w.key("schemaVersion");
    w.value_u64(1);
    w.key("projectRoot");
    w.value_string(&project_root.to_string_lossy());

    w.key("nodeModules");
    w.begin_object();
    w.key("path");
    w.value_string(&node_modules_dir.to_string_lossy());
    w.key("logicalBytes");
    w.value_u64(totals.logical);
    w.key("physicalBytes");
    w.value_u64(totals.physical);
    w.key("physicalBytesApprox");
    w.value_bool(totals.approx);
    w.key("fileCount");
    w.value_u64(totals.file_count);
    w.end_object();

    w.key("packages");
    w.begin_array();
    for p in packages {
        w.begin_object();
        w.key("key");
        w.value_string(&p.key);
        w.key("name");
        w.value_string(&p.name);
        w.key("version");
        w.value_string(&p.version);
        w.key("paths");
        w.begin_array();
        for pp in &p.paths {
            w.value_string(pp);
        }
        w.end_array();
        w.key("depthStats");
        w.begin_object();
        w.key("minDepth");
        w.value_u64(p.min_depth);
        w.key("maxDepth");
        w.value_u64(p.max_depth);
        w.end_object();
        w.key("sizes");
        w.begin_object();
        w.key("logicalBytes");
        w.value_u64(p.logical);
        w.key("physicalBytes");
        w.value_u64(p.physical);
        w.key("sharedBytes");
        w.value_u64(p.shared);
        w.key("physicalBytesApprox");
        w.value_bool(p.approx);
        w.key("fileCount");
        w.value_u64(p.file_count);
        w.end_object();
        w.end_object();
    }
    w.end_array();

    w.key("duplicates");
    w.begin_array();
    for d in duplicates {
        w.begin_object();
        w.key("name");
        w.value_string(&d.name);
        w.key("versions");
        w.begin_array();
        for v in &d.versions {
            w.value_string(v);
        }
        w.end_array();
        w.key("majors");
        w.begin_array();
        for m in &d.majors {
            w.value_string(m);
        }
        w.end_array();
        w.key("count");
        w.value_u64(d.count);
        w.end_object();
    }
    w.end_array();

    w.key("depth");
    w.begin_object();
    w.key("maxDepth");
    w.value_u64(depth.max_depth);
    w.key("p95Depth");
    w.value_u64(depth.p95_depth);
    w.end_object();

    w.key("graph");
    if include_graph {
        w.begin_object();
        w.key("nodes");
        w.begin_object();
        let mut nodes: BTreeMap<String, (String, String)> = BTreeMap::new();
        for p in packages {
            nodes.insert(p.key.clone(), (p.name.clone(), p.version.clone()));
        }
        for (k, (name, version)) in nodes {
            w.key(&k);
            w.begin_object();
            w.key("key");
            w.value_string(&k);
            w.key("name");
            w.value_string(&name);
            w.key("version");
            w.value_string(&version);
            w.end_object();
        }
        w.end_object();
        w.key("edges");
        w.begin_array();
        w.end_array();
        w.end_object();
    } else {
        w.value_null();
    }

    w.key("extensions");
    w.begin_object();
    w.key("generatedBy");
    w.begin_object();
    w.key("engine");
    w.value_string("better-core");
    w.key("version");
    w.value_string(VERSION);
    w.end_object();
    w.end_object();

    w.end_object();
    w.out.push('\n');
    w.finish()
}

pub fn write_scan_json(root: &Path, agg: &ScanAgg, ok: bool, reason: Option<String>) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("ok");
    w.value_bool(ok);
    w.key("rootDir");
    w.value_string(&root.to_string_lossy());
    w.key("reason");
    if let Some(r) = reason {
        w.value_string(&r);
    } else {
        w.value_null();
    }
    w.key("logicalBytes");
    w.value_u64(agg.logical);
    w.key("physicalBytes");
    w.value_u64(agg.physical);
    w.key("sharedBytes");
    w.value_u64(agg.shared);
    w.key("physicalBytesApprox");
    w.value_bool(agg.approx);
    w.key("fileCount");
    w.value_u64(agg.file_count);
    w.key("packageCount");
    w.value_u64(agg.package_count);
    w.end_object();
    w.out.push('\n');
    w.finish()
}

pub fn write_materialize_json(
    src: &Path,
    dest: &Path,
    strategy: LinkStrategy,
    jobs: usize,
    profile: MaterializeProfile,
    effective_jobs: usize,
    ok: bool,
    reason: Option<String>,
    duration_ms: u64,
    stats: &MaterializeStats,
    phases: &PhaseDurations,
) -> String {
    let effective_jobs = effective_jobs.max(1).min(materialize_worker_limit());
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("ok");
    w.value_bool(ok);
    w.key("kind");
    w.value_string("better.core.materialize");
    w.key("schemaVersion");
    w.value_u64(1);
    w.key("srcDir");
    w.value_string(&src.to_string_lossy());
    w.key("destDir");
    w.value_string(&dest.to_string_lossy());
    w.key("strategy");
    w.value_string(strategy.as_str());
    w.key("jobs");
    w.value_u64(jobs as u64);
    w.key("durationMs");
    w.value_u64(duration_ms);
    w.key("reason");
    if let Some(r) = reason {
        w.value_string(&r);
    } else {
        w.value_null();
    }
    w.key("stats");
    w.begin_object();
    w.key("files");
    w.value_u64(stats.files);
    w.key("filesLinked");
    w.value_u64(stats.files_linked);
    w.key("filesReused");
    w.value_u64(stats.files_reused);
    w.key("symlinksReused");
    w.value_u64(stats.symlinks_reused);
    w.key("filesCopied");
    w.value_u64(stats.files_copied);
    w.key("linkFallbackCopies");
    w.value_u64(stats.link_fallback_copies);
    w.key("directories");
    w.value_u64(stats.directories);
    w.key("symlinks");
    w.value_u64(stats.symlinks);
    w.end_object();
    w.key("profile");
    w.value_string(profile.as_str());
    w.key("effectiveJobs");
    w.value_u64(effective_jobs as u64);
    w.key("phaseDurations");
    w.begin_object();
    w.key("scanUs");
    w.value_u64(phases.scan_us);
    w.key("mkdirUs");
    w.value_u64(phases.mkdir_us);
    w.key("linkCopyUs");
    w.value_u64(phases.link_copy_us);
    w.key("totalUs");
    w.value_u64(phases.total_us);
    w.key("scanMs");
    w.value_u64(phases.scan_ms);
    w.key("mkdirMs");
    w.value_u64(phases.mkdir_ms);
    w.key("linkCopyMs");
    w.value_u64(phases.link_copy_ms);
    w.end_object();
    w.key("fallbackReasons");
    w.begin_object();
    w.key("eperm");
    w.value_u64(stats.fallback_eperm);
    w.key("exdev");
    w.value_u64(stats.fallback_exdev);
    w.key("other");
    w.value_u64(stats.fallback_other);
    w.end_object();
    w.end_object();
    w.out.push('\n');
    w.finish()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn shared_executor_is_bounded_and_accepts_nested_work() {
        let pool = materialize_pool().unwrap();
        assert!((1..=4).contains(&pool.current_num_threads()));
        let threads = std::sync::Mutex::new(HashSet::new());
        std::thread::scope(|scope| {
            for _ in 0..12 {
                let threads = &threads;
                scope.spawn(move || pool.install(|| {
                    // Reentrant submissions must use the same executor without deadlock.
                    materialize_pool().unwrap().install(|| {
                        threads.lock().unwrap().insert(std::thread::current().id());
                    });
                }));
            }
        });
        assert!(!threads.lock().unwrap().is_empty());
        assert!(threads.lock().unwrap().len() <= pool.current_num_threads());
    }

    #[test]
    fn concurrent_tree_batches_preserve_content_and_cleanup_staging() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        for index in 0..32 { fs::write(source.join(format!("file-{index}")), format!("original-{index}")).unwrap(); }
        std::thread::scope(|scope| {
            for batch in 0..12 {
                let source = &source;
                let destination = root.path().join(format!("batch-{batch}"));
                scope.spawn(move || {
                    let result = materialize_tree(source, &destination, LinkStrategy::Auto, 32, MaterializeProfile::Auto).unwrap();
                    assert_eq!(result.stats.files_copied, 32);
                    assert_eq!(fs::read_dir(&destination).unwrap().count(), 32);
                    for index in 0..32 {
                        assert_eq!(fs::read_to_string(destination.join(format!("file-{index}"))).unwrap(), format!("original-{index}"));
                    }
                    fs::write(destination.join("file-0"), "worktree-local edit").unwrap();
                    assert_eq!(fs::read_to_string(source.join("file-0")).unwrap(), "original-0");
                    assert_eq!(result.phases.total_ms, result.phases.total_us / 1000);
                });
            }
        });
    }

    #[cfg(unix)]
    #[test]
    fn tree_reconciliation_reuses_only_verified_files_and_links() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("one"), "original").unwrap();
        fs::write(source.join("two"), "original").unwrap();
        std::os::unix::fs::symlink("one", source.join("link")).unwrap();
        let materialize = || materialize_tree(&source, &target, LinkStrategy::Auto, 4, MaterializeProfile::Auto).unwrap();
        assert_eq!(materialize().stats.files_copied, 2);
        let warm = materialize();
        assert_eq!(warm.stats.files_reused, 2);
        assert_eq!(warm.stats.files_copied, 0);
        assert_eq!(warm.stats.symlinks_reused, 1);
        fs::write(target.join("one"), "modified").unwrap();
        let repaired = materialize();
        assert_eq!(repaired.stats.files_reused, 1);
        assert_eq!(repaired.stats.files_copied, 1);
        assert_eq!(fs::read_to_string(target.join("one")).unwrap(), "original");
    }

    fn write_pkg(nm: &Path, name: &str, content: &str) {
        let dir = nm.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = std::fs::File::create(dir.join("package.json")).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        let mut f2 = std::fs::File::create(dir.join("index.js")).unwrap();
        f2.write_all(b"module.exports = {};").unwrap();
    }

    #[test]
    fn analyze_missing_node_modules_returns_error() {
        let result = analyze(Path::new("/nonexistent-analyze-project"), false);
        assert!(result.is_err());
        assert!(result.err().unwrap().contains("node_modules_not_found"));
    }

    #[test]
    fn analyze_empty_node_modules() {
        let tmp = std::env::temp_dir().join("analyze-test-empty");
        let nm = tmp.join("node_modules");
        std::fs::create_dir_all(&nm).unwrap();
        let report = analyze(&tmp, false).unwrap();
        assert_eq!(report.packages.len(), 0);
        assert_eq!(report.totals.package_count, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn analyze_single_package() {
        let tmp = std::env::temp_dir().join("analyze-test-single");
        let nm = tmp.join("node_modules");
        write_pkg(&nm, "lodash", r#"{"name":"lodash","version":"4.17.21"}"#);
        let report = analyze(&tmp, false).unwrap();
        assert_eq!(report.packages.len(), 1);
        assert_eq!(report.packages[0].name, "lodash");
        assert_eq!(report.packages[0].version, "4.17.21");
        assert!(report.totals.file_count > 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn analyze_multiple_packages_counts_correctly() {
        let tmp = std::env::temp_dir().join("analyze-test-multi");
        let nm = tmp.join("node_modules");
        write_pkg(&nm, "express", r#"{"name":"express","version":"4.18.2"}"#);
        write_pkg(&nm, "lodash", r#"{"name":"lodash","version":"4.17.21"}"#);
        write_pkg(&nm, "chalk", r#"{"name":"chalk","version":"5.0.0"}"#);
        let report = analyze(&tmp, false).unwrap();
        assert_eq!(report.packages.len(), 3);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn analyze_logical_bytes_nonzero_for_files() {
        let tmp = std::env::temp_dir().join("analyze-test-bytes");
        let nm = tmp.join("node_modules");
        write_pkg(&nm, "react", r#"{"name":"react","version":"18.0.0"}"#);
        let report = analyze(&tmp, false).unwrap();
        assert!(report.totals.logical > 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_scan_json_contains_ok_true() {
        let agg = ScanAgg {
            logical: 1024,
            physical: 512,
            shared: 0,
            file_count: 10,
            package_count: 2,
            approx: false,
        };
        let json = write_scan_json(std::path::Path::new("/project"), &agg, true, None);
        assert!(json.contains("\"ok\":true"));
        assert!(json.contains("\"fileCount\":10"));
        assert!(json.contains("\"packageCount\":2"));
    }

    #[test]
    fn write_scan_json_includes_reason_when_provided() {
        let agg = ScanAgg::default();
        let json = write_scan_json(std::path::Path::new("/project"), &agg, false, Some("something went wrong".into()));
        assert!(json.contains("\"ok\":false"));
        assert!(json.contains("something went wrong"));
    }

    #[test]
    fn materialize_json_reports_worker_ceiling_and_microseconds() {
        let phases = PhaseDurations { scan_us: 125, total_us: 875, ..PhaseDurations::default() };
        let json = write_materialize_json(Path::new("/src"), Path::new("/dst"),
            LinkStrategy::Auto, 32, MaterializeProfile::SmallFiles, 96, true,
            None, 0, &MaterializeStats::default(), &phases);
        let report: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(report["jobs"], 32);
        assert_eq!(report["effectiveJobs"], materialize_worker_limit());
        assert_eq!(report["phaseDurations"]["scanUs"], 125);
        assert_eq!(report["phaseDurations"]["scanMs"], 0);
        assert_eq!(report["phaseDurations"]["totalUs"], 875);
    }

    #[test]
    fn write_materialize_json_contains_key_fields() {
        let stats = MaterializeStats {
            files: 5,
            files_linked: 3,
            files_copied: 2,
            ..MaterializeStats::default()
        };
        let phases = PhaseDurations::default();
        let json = write_materialize_json(
            std::path::Path::new("/src"),
            std::path::Path::new("/dst"),
            LinkStrategy::Hardlink,
            4,
            MaterializeProfile::Auto,
            4,
            true,
            None,
            150,
            &stats,
            &phases,
        );
        assert!(json.contains("\"ok\":true"));
        assert!(json.contains("\"filesLinked\":3"));
        assert!(json.contains("\"durationMs\":150"));
    }

    #[test]
    fn analyze_scoped_package_name_extracted() {
        let tmp = std::env::temp_dir().join("analyze-test-scoped");
        let nm = tmp.join("node_modules");
        // Scoped package: @scope/pkg
        let scope_dir = nm.join("@scope").join("pkg");
        std::fs::create_dir_all(&scope_dir).unwrap();
        let mut f = std::fs::File::create(scope_dir.join("package.json")).unwrap();
        use std::io::Write;
        f.write_all(br#"{"name":"@scope/pkg","version":"1.0.0"}"#).unwrap();
        let report = analyze(&tmp, false).unwrap();
        assert_eq!(report.packages.len(), 1);
        assert_eq!(report.packages[0].name, "@scope/pkg");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
