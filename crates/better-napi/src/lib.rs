use std::collections::HashSet;
use std::path::Path;

use napi_derive::napi;
use rayon::prelude::*;

use better_core::{
    analyze, materialize_tree, scan_tree, resolve_from_lockfile, fetch_packages,
    LinkStrategy, MaterializeProfile,
};

// --- Scan ---

#[napi(object)]
pub struct NapiScanResult {
    pub ok: bool,
    pub reason: Option<String>,
    #[napi(js_name = "logicalBytes")]
    pub logical_bytes: f64,
    #[napi(js_name = "physicalBytes")]
    pub physical_bytes: f64,
    #[napi(js_name = "sharedBytes")]
    pub shared_bytes: f64,
    #[napi(js_name = "physicalBytesApprox")]
    pub physical_bytes_approx: bool,
    #[napi(js_name = "fileCount")]
    pub file_count: f64,
    #[napi(js_name = "packageCount")]
    pub package_count: f64,
}

#[napi]
pub fn scan(root: String) -> NapiScanResult {
    let root_path = Path::new(&root);
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    match scan_tree(root_path, &HashSet::new(), Some(&mut seen)) {
        Ok(agg) => NapiScanResult {
            ok: true,
            reason: None,
            logical_bytes: agg.logical as f64,
            physical_bytes: agg.physical as f64,
            shared_bytes: agg.shared as f64,
            physical_bytes_approx: agg.approx,
            file_count: agg.file_count as f64,
            package_count: agg.package_count as f64,
        },
        Err(e) => NapiScanResult {
            ok: false,
            reason: Some(e),
            logical_bytes: 0.0,
            physical_bytes: 0.0,
            shared_bytes: 0.0,
            physical_bytes_approx: false,
            file_count: 0.0,
            package_count: 0.0,
        },
    }
}

// --- Analyze ---

#[napi(object)]
pub struct NapiDepthStats {
    #[napi(js_name = "minDepth")]
    pub min_depth: f64,
    #[napi(js_name = "maxDepth")]
    pub max_depth: f64,
}

#[napi(object)]
pub struct NapiPackageSizes {
    #[napi(js_name = "logicalBytes")]
    pub logical_bytes: f64,
    #[napi(js_name = "physicalBytes")]
    pub physical_bytes: f64,
    #[napi(js_name = "sharedBytes")]
    pub shared_bytes: f64,
    #[napi(js_name = "physicalBytesApprox")]
    pub physical_bytes_approx: bool,
    #[napi(js_name = "fileCount")]
    pub file_count: f64,
}

#[napi(object)]
pub struct NapiPackage {
    pub key: String,
    pub name: String,
    pub version: String,
    pub paths: Vec<String>,
    #[napi(js_name = "depthStats")]
    pub depth_stats: NapiDepthStats,
    pub sizes: NapiPackageSizes,
}

#[napi(object)]
pub struct NapiDuplicate {
    pub name: String,
    pub versions: Vec<String>,
    pub majors: Vec<String>,
    pub count: f64,
}

#[napi(object)]
pub struct NapiDepth {
    #[napi(js_name = "maxDepth")]
    pub max_depth: f64,
    #[napi(js_name = "p95Depth")]
    pub p95_depth: f64,
}

#[napi(object)]
pub struct NapiNodeModules {
    pub path: String,
    #[napi(js_name = "logicalBytes")]
    pub logical_bytes: f64,
    #[napi(js_name = "physicalBytes")]
    pub physical_bytes: f64,
    #[napi(js_name = "physicalBytesApprox")]
    pub physical_bytes_approx: bool,
    #[napi(js_name = "fileCount")]
    pub file_count: f64,
}

#[napi(object)]
pub struct NapiAnalyzeResult {
    pub ok: bool,
    pub reason: Option<String>,
    #[napi(js_name = "projectRoot")]
    pub project_root: Option<String>,
    #[napi(js_name = "nodeModules")]
    pub node_modules: Option<NapiNodeModules>,
    pub packages: Vec<NapiPackage>,
    pub duplicates: Vec<NapiDuplicate>,
    pub depth: Option<NapiDepth>,
}

#[napi(js_name = "analyze")]
pub fn napi_analyze(root: String, include_graph: bool) -> NapiAnalyzeResult {
    let root_path = Path::new(&root);
    match analyze(root_path, include_graph) {
        Ok(report) => NapiAnalyzeResult {
            ok: true,
            reason: None,
            project_root: Some(root.clone()),
            node_modules: Some(NapiNodeModules {
                path: report.node_modules_dir.to_string_lossy().to_string(),
                logical_bytes: report.totals.logical as f64,
                physical_bytes: report.totals.physical as f64,
                physical_bytes_approx: report.totals.approx,
                file_count: report.totals.file_count as f64,
            }),
            packages: report
                .packages
                .iter()
                .map(|p| NapiPackage {
                    key: p.key.clone(),
                    name: p.name.clone(),
                    version: p.version.clone(),
                    paths: p.paths.clone(),
                    depth_stats: NapiDepthStats {
                        min_depth: p.min_depth as f64,
                        max_depth: p.max_depth as f64,
                    },
                    sizes: NapiPackageSizes {
                        logical_bytes: p.logical as f64,
                        physical_bytes: p.physical as f64,
                        shared_bytes: p.shared as f64,
                        physical_bytes_approx: p.approx,
                        file_count: p.file_count as f64,
                    },
                })
                .collect(),
            duplicates: report
                .duplicates
                .iter()
                .map(|d| NapiDuplicate {
                    name: d.name.clone(),
                    versions: d.versions.clone(),
                    majors: d.majors.clone(),
                    count: d.count as f64,
                })
                .collect(),
            depth: Some(NapiDepth {
                max_depth: report.depth.max_depth as f64,
                p95_depth: report.depth.p95_depth as f64,
            }),
        },
        Err(reason) => NapiAnalyzeResult {
            ok: false,
            reason: Some(reason),
            project_root: Some(root),
            node_modules: None,
            packages: vec![],
            duplicates: vec![],
            depth: None,
        },
    }
}

// --- Materialize ---

#[napi(object)]
pub struct NapiMaterializeOpts {
    #[napi(js_name = "linkStrategy")]
    pub link_strategy: Option<String>,
    pub jobs: Option<f64>,
    pub profile: Option<String>,
}

#[napi(object)]
pub struct NapiMaterializeStats {
    pub files: f64,
    #[napi(js_name = "filesLinked")]
    pub files_linked: f64,
    #[napi(js_name = "filesCopied")]
    pub files_copied: f64,
    #[napi(js_name = "linkFallbackCopies")]
    pub link_fallback_copies: f64,
    pub directories: f64,
    pub symlinks: f64,
}

#[napi(object)]
pub struct NapiPhaseDurations {
    #[napi(js_name = "scanMs")]
    pub scan_ms: f64,
    #[napi(js_name = "mkdirMs")]
    pub mkdir_ms: f64,
    #[napi(js_name = "linkCopyMs")]
    pub link_copy_ms: f64,
    #[napi(js_name = "totalMs")]
    pub total_ms: f64,
}

#[napi(object)]
pub struct NapiFallbackReasons {
    pub eperm: f64,
    pub exdev: f64,
    pub other: f64,
}

#[napi(object)]
pub struct NapiMaterializeResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub stats: Option<NapiMaterializeStats>,
    #[napi(js_name = "phaseDurations")]
    pub phase_durations: Option<NapiPhaseDurations>,
    #[napi(js_name = "fallbackReasons")]
    pub fallback_reasons: Option<NapiFallbackReasons>,
}

#[napi]
pub fn materialize(
    src: String,
    dest: String,
    opts: Option<NapiMaterializeOpts>,
) -> NapiMaterializeResult {
    let src_path = Path::new(&src);
    let dest_path = Path::new(&dest);

    let strategy = opts
        .as_ref()
        .and_then(|o| o.link_strategy.as_deref())
        .and_then(LinkStrategy::from_arg)
        .unwrap_or(LinkStrategy::Auto);

    let jobs = opts
        .as_ref()
        .and_then(|o| o.jobs)
        .map(|j| (j as usize).clamp(1, 256))
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get().saturating_mul(2).clamp(1, 64))
                .unwrap_or(8)
        });

    let profile = opts
        .as_ref()
        .and_then(|o| o.profile.as_deref())
        .and_then(MaterializeProfile::from_arg)
        .unwrap_or(MaterializeProfile::Auto);

    match materialize_tree(src_path, dest_path, strategy, jobs, profile) {
        Ok(report) => NapiMaterializeResult {
            ok: true,
            reason: None,
            stats: Some(NapiMaterializeStats {
                files: report.stats.files as f64,
                files_linked: report.stats.files_linked as f64,
                files_copied: report.stats.files_copied as f64,
                link_fallback_copies: report.stats.link_fallback_copies as f64,
                directories: report.stats.directories as f64,
                symlinks: report.stats.symlinks as f64,
            }),
            phase_durations: Some(NapiPhaseDurations {
                scan_ms: report.phases.scan_ms as f64,
                mkdir_ms: report.phases.mkdir_ms as f64,
                link_copy_ms: report.phases.link_copy_ms as f64,
                total_ms: report.phases.total_ms as f64,
            }),
            fallback_reasons: Some(NapiFallbackReasons {
                eperm: report.stats.fallback_eperm as f64,
                exdev: report.stats.fallback_exdev as f64,
                other: report.stats.fallback_other as f64,
            }),
        },
        Err(reason) => NapiMaterializeResult {
            ok: false,
            reason: Some(reason),
            stats: None,
            phase_durations: None,
            fallback_reasons: None,
        },
    }
}

// --- Resolve ---

#[napi(object)]
pub struct NapiResolvedPackage {
    pub name: String,
    pub version: String,
    #[napi(js_name = "relPath")]
    pub rel_path: String,
    #[napi(js_name = "resolvedUrl")]
    pub resolved_url: String,
    pub integrity: String,
}

#[napi(object)]
pub struct NapiResolveResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub packages: Vec<NapiResolvedPackage>,
    #[napi(js_name = "lockfileVersion")]
    pub lockfile_version: f64,
}

#[napi]
pub fn resolve(lockfile_path: String) -> NapiResolveResult {
    let path = Path::new(&lockfile_path);
    match resolve_from_lockfile(path) {
        Ok(result) => NapiResolveResult {
            ok: true,
            reason: None,
            packages: result
                .packages
                .iter()
                .map(|p| NapiResolvedPackage {
                    name: p.name.clone(),
                    version: p.version.clone(),
                    rel_path: p.rel_path.clone(),
                    resolved_url: p.resolved_url.clone(),
                    integrity: p.integrity.clone(),
                })
                .collect(),
            lockfile_version: result.lockfile_version as f64,
        },
        Err(reason) => NapiResolveResult {
            ok: false,
            reason: Some(reason),
            packages: vec![],
            lockfile_version: 0.0,
        },
    }
}

// --- Fetch and Extract ---

#[napi(object)]
pub struct NapiFetchOpts {
    pub jobs: Option<f64>,
}

#[napi(object)]
pub struct NapiFetchResult {
    pub ok: bool,
    pub reason: Option<String>,
    #[napi(js_name = "packagesFetched")]
    pub packages_fetched: f64,
    #[napi(js_name = "packagesCached")]
    pub packages_cached: f64,
    #[napi(js_name = "bytesDownloaded")]
    pub bytes_downloaded: f64,
}

#[napi]
pub fn fetch_and_extract(
    lockfile_path: String,
    cache_dir: String,
    _opts: Option<NapiFetchOpts>,
) -> NapiFetchResult {
    let lockfile = Path::new(&lockfile_path);
    let cache = Path::new(&cache_dir);

    // Resolve packages from lockfile
    let packages = match resolve_from_lockfile(lockfile) {
        Ok(result) => result.packages,
        Err(reason) => {
            return NapiFetchResult {
                ok: false,
                reason: Some(reason),
                packages_fetched: 0.0,
                packages_cached: 0.0,
                bytes_downloaded: 0.0,
            }
        }
    };

    // Fetch packages
    match fetch_packages(&packages, cache) {
        Ok(fetch_result) => NapiFetchResult {
            ok: true,
            reason: None,
            packages_fetched: fetch_result.packages_fetched as f64,
            packages_cached: fetch_result.packages_cached as f64,
            bytes_downloaded: fetch_result.bytes_downloaded as f64,
        },
        Err(reason) => NapiFetchResult {
            ok: false,
            reason: Some(reason),
            packages_fetched: 0.0,
            packages_cached: 0.0,
            bytes_downloaded: 0.0,
        },
    }
}

// --- Batch Materialize ---

#[napi(object)]
pub struct NapiBatchEntry {
    pub src: String,
    pub dest: String,
}

#[napi(object)]
pub struct NapiBatchMaterializeResult {
    pub ok: bool,
    pub reason: Option<String>,
    #[napi(js_name = "totalFiles")]
    pub total_files: f64,
    #[napi(js_name = "totalLinked")]
    pub total_linked: f64,
    #[napi(js_name = "totalCopied")]
    pub total_copied: f64,
    #[napi(js_name = "totalDirs")]
    pub total_dirs: f64,
    pub failed: f64,
}

#[napi]
pub fn materialize_batch(
    entries: Vec<NapiBatchEntry>,
    opts: Option<NapiMaterializeOpts>,
) -> NapiBatchMaterializeResult {
    let strategy = opts
        .as_ref()
        .and_then(|o| o.link_strategy.as_deref())
        .and_then(LinkStrategy::from_arg)
        .unwrap_or(LinkStrategy::Auto);

    let profile = opts
        .as_ref()
        .and_then(|o| o.profile.as_deref())
        .and_then(MaterializeProfile::from_arg)
        .unwrap_or(MaterializeProfile::Auto);

    let jobs_per_pkg = 4; // modest per-package parallelism, rayon handles cross-package

    let results: Vec<_> = entries
        .par_iter()
        .map(|entry| {
            let src_path = Path::new(&entry.src);
            let dest_path = Path::new(&entry.dest);
            materialize_tree(src_path, dest_path, strategy, jobs_per_pkg, profile)
        })
        .collect();

    let mut total_files = 0u64;
    let mut total_linked = 0u64;
    let mut total_copied = 0u64;
    let mut total_dirs = 0u64;
    let mut failed = 0u64;

    for result in &results {
        match result {
            Ok(report) => {
                total_files += report.stats.files;
                total_linked += report.stats.files_linked;
                total_copied += report.stats.files_copied;
                total_dirs += report.stats.directories;
            }
            Err(_) => {
                failed += 1;
            }
        }
    }

    NapiBatchMaterializeResult {
        ok: failed == 0,
        reason: if failed > 0 {
            Some(format!("{} packages failed to materialize", failed))
        } else {
            None
        },
        total_files: total_files as f64,
        total_linked: total_linked as f64,
        total_copied: total_copied as f64,
        total_dirs: total_dirs as f64,
        failed: failed as f64,
    }
}
