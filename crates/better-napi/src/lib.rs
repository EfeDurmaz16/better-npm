use std::collections::{HashMap, HashSet};
use std::path::Path;

use napi_derive::napi;
use rayon::prelude::*;

use better_core::{
    analyze, materialize_tree, scan_tree, resolve_from_lockfile, fetch_packages,
    LinkStrategy, MaterializeProfile,
    run_audit, scan_licenses, check_outdated, run_doctor,
    trace_dependency, check_dedupe, detect_workspaces, workspace_graph,
    policy_check,
};
use better_core::audit::{smart_audit, AuditFilter, ScoredVuln};

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
    match fetch_packages(&packages, cache, None) {
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

/// Try macOS clonefile(2) for near-instant APFS copy-on-write directory cloning.
#[cfg(target_os = "macos")]
fn try_clonefile(src: &Path, dst: &Path) -> bool {
    use std::ffi::CString;
    extern "C" {
        fn clonefile(
            src: *const std::os::raw::c_char,
            dst: *const std::os::raw::c_char,
            flags: u32,
        ) -> std::os::raw::c_int;
    }
    let src_c = match CString::new(src.as_os_str().as_encoded_bytes()) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let dst_c = match CString::new(dst.as_os_str().as_encoded_bytes()) {
        Ok(c) => c,
        Err(_) => return false,
    };
    unsafe { clonefile(src_c.as_ptr(), dst_c.as_ptr(), 0) == 0 }
}

#[cfg(not(target_os = "macos"))]
fn try_clonefile(_src: &Path, _dst: &Path) -> bool {
    false
}

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
    pub cloned: f64,
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

    let jobs_per_pkg = 4;

    // Try clonefile first (macOS APFS), fall back to materialize_tree
    let results: Vec<(bool, Result<better_core::MaterializeReport, String>)> = entries
        .par_iter()
        .map(|entry| {
            let src_path = Path::new(&entry.src);
            let dest_path = Path::new(&entry.dest);

            // Try clonefile — near-instant on APFS (same volume)
            if try_clonefile(src_path, dest_path) {
                return (true, Ok(better_core::MaterializeReport::default()));
            }

            // Fallback: traditional scan+mkdir+hardlink
            (false, materialize_tree(src_path, dest_path, strategy, jobs_per_pkg, profile))
        })
        .collect();

    let mut total_files = 0u64;
    let mut total_linked = 0u64;
    let mut total_copied = 0u64;
    let mut total_dirs = 0u64;
    let mut cloned = 0u64;
    let mut failed = 0u64;

    for (was_cloned, result) in &results {
        if *was_cloned {
            cloned += 1;
            continue;
        }
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
        cloned: cloned as f64,
        failed: failed as f64,
    }
}

// --- Audit ---

#[napi(object)]
pub struct NapiAuditVulnerability {
    pub id: String,
    pub summary: String,
    pub severity: String,
    pub package: String,
    pub version: String,
    pub fixed: String,
}

#[napi(object)]
pub struct NapiAuditResult {
    pub ok: bool,
    pub reason: Option<String>,
    #[napi(js_name = "scannedPackages")]
    pub scanned_packages: f64,
    pub vulnerabilities: Vec<NapiAuditVulnerability>,
    pub total: f64,
    pub critical: f64,
    pub high: f64,
    pub medium: f64,
    pub low: f64,
    #[napi(js_name = "riskLevel")]
    pub risk_level: String,
}

#[napi(js_name = "audit")]
pub fn napi_audit(project_root: String, min_severity: Option<String>) -> NapiAuditResult {
    let root = Path::new(&project_root);
    let lockfile = root.join("package-lock.json");
    let severity = min_severity.unwrap_or_else(|| "low".to_string());

    match run_audit(&lockfile, root, &severity) {
        Ok(report) => NapiAuditResult {
            ok: true,
            reason: None,
            scanned_packages: report.scanned_packages as f64,
            vulnerabilities: report.vulnerabilities.iter().map(|v| NapiAuditVulnerability {
                id: v.id.clone(),
                summary: v.summary.clone(),
                severity: v.severity.clone(),
                package: v.package.clone(),
                version: v.version.clone(),
                fixed: v.fixed.clone(),
            }).collect(),
            total: report.total as f64,
            critical: report.critical as f64,
            high: report.high as f64,
            medium: report.medium as f64,
            low: report.low as f64,
            risk_level: report.risk_level,
        },
        Err(reason) => NapiAuditResult {
            ok: false,
            reason: Some(reason),
            scanned_packages: 0.0,
            vulnerabilities: vec![],
            total: 0.0, critical: 0.0, high: 0.0, medium: 0.0, low: 0.0,
            risk_level: "unknown".to_string(),
        },
    }
}

// --- Smart Audit ---

#[napi(object)]
pub struct NapiSmartAuditInput {
    #[napi(js_name = "projectRoot")]
    pub project_root: String,
    #[napi(js_name = "rootDeps")]
    pub root_deps: HashMap<String, String>,
    #[napi(js_name = "rootDevDeps")]
    pub root_dev_deps: HashMap<String, String>,
    #[napi(js_name = "rootOptionalDeps")]
    pub root_optional_deps: HashMap<String, String>,
    #[napi(js_name = "depGraph")]
    pub dep_graph: HashMap<String, Vec<String>>,
    #[napi(js_name = "resolvedVersions")]
    pub resolved_versions: HashMap<String, String>,
    #[napi(js_name = "prodOnly")]
    pub prod_only: bool,
    #[napi(js_name = "minScore")]
    pub min_score: Option<f64>,
    #[napi(js_name = "ignoreDev")]
    pub ignore_dev: bool,
    #[napi(js_name = "fixableOnly")]
    pub fixable_only: bool,
    #[napi(js_name = "minSeverity")]
    pub min_severity: Option<String>,
}

#[napi(object)]
pub struct NapiScoredVuln {
    pub id: String,
    pub summary: String,
    pub severity: String,
    pub context: String,
    #[napi(js_name = "baseScore")]
    pub base_score: f64,
    #[napi(js_name = "contextWeight")]
    pub context_weight: f64,
    #[napi(js_name = "effectiveScore")]
    pub effective_score: f64,
    #[napi(js_name = "packageName")]
    pub package_name: String,
    #[napi(js_name = "packageVersion")]
    pub package_version: String,
    #[napi(js_name = "fixAvailable")]
    pub fix_available: Option<String>,
}

#[napi(object)]
pub struct NapiSmartAuditResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub total: f64,
    pub filtered: f64,
    pub vulns: Vec<NapiScoredVuln>,
    #[napi(js_name = "riskLevel")]
    pub risk_level: String,
}

fn scored_vuln_to_napi(v: &ScoredVuln) -> NapiScoredVuln {
    NapiScoredVuln {
        id: v.id.clone(),
        summary: v.summary.clone(),
        severity: v.severity.as_str().to_string(),
        context: v.context.as_str().to_string(),
        base_score: v.base_score,
        context_weight: v.context_weight,
        effective_score: v.effective_score,
        package_name: v.package_name.clone(),
        package_version: v.package_version.clone(),
        fix_available: v.fix_available.clone(),
    }
}

#[napi(js_name = "smartAudit")]
pub fn napi_smart_audit(input: NapiSmartAuditInput) -> NapiSmartAuditResult {
    let root = Path::new(&input.project_root);
    let lockfile = root.join("package-lock.json");
    let severity = input.min_severity.clone().unwrap_or_else(|| "low".to_string());

    // First run the base audit to get raw vulnerabilities
    let raw_report = match run_audit(&lockfile, root, &severity) {
        Ok(r) => r,
        Err(reason) => {
            return NapiSmartAuditResult {
                ok: false,
                reason: Some(reason),
                total: 0.0,
                filtered: 0.0,
                vulns: vec![],
                risk_level: "unknown".to_string(),
            };
        }
    };

    let filter = AuditFilter::from_args(
        input.prod_only,
        input.min_score,
        input.ignore_dev,
        input.fixable_only,
    );

    let report = smart_audit(
        &raw_report.vulnerabilities,
        &input.root_deps,
        &input.root_dev_deps,
        &input.root_optional_deps,
        &input.dep_graph,
        &input.resolved_versions,
        &filter,
    );

    NapiSmartAuditResult {
        ok: true,
        reason: None,
        total: report.total as f64,
        filtered: report.filtered as f64,
        vulns: report.vulns.iter().map(scored_vuln_to_napi).collect(),
        risk_level: report.risk_level,
    }
}

// --- License ---

#[napi(object)]
pub struct NapiLicenseInfo {
    pub name: String,
    pub version: String,
    pub license: String,
}

#[napi(object)]
pub struct NapiLicenseCount {
    pub license: String,
    pub count: f64,
}

#[napi(object)]
pub struct NapiLicenseResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub packages: Vec<NapiLicenseInfo>,
    #[napi(js_name = "byLicense")]
    pub by_license: Vec<NapiLicenseCount>,
    #[napi(js_name = "totalPackages")]
    pub total_packages: f64,
    pub violations: Vec<NapiLicenseInfo>,
}

#[napi(js_name = "license")]
pub fn napi_license(
    project_root: String,
    allow: Option<Vec<String>>,
    deny: Option<Vec<String>>,
) -> NapiLicenseResult {
    let root = Path::new(&project_root);
    let nm = root.join("node_modules");
    let allow_list = allow.unwrap_or_default();
    let deny_list = deny.unwrap_or_default();

    match scan_licenses(&nm, &allow_list, &deny_list) {
        Ok(report) => NapiLicenseResult {
            ok: true,
            reason: None,
            packages: report.packages.iter().map(|p| NapiLicenseInfo {
                name: p.name.clone(), version: p.version.clone(), license: p.license.clone(),
            }).collect(),
            by_license: report.by_license.iter().map(|(k, v)| NapiLicenseCount {
                license: k.clone(), count: *v as f64,
            }).collect(),
            total_packages: report.total_packages as f64,
            violations: report.violations.iter().map(|p| NapiLicenseInfo {
                name: p.name.clone(), version: p.version.clone(), license: p.license.clone(),
            }).collect(),
        },
        Err(reason) => NapiLicenseResult {
            ok: false,
            reason: Some(reason),
            packages: vec![], by_license: vec![],
            total_packages: 0.0, violations: vec![],
        },
    }
}

// --- Outdated ---

#[napi(object)]
pub struct NapiOutdatedEntry {
    pub name: String,
    pub current: String,
    pub latest: String,
    #[napi(js_name = "updateType")]
    pub update_type: String,
}

#[napi(object)]
pub struct NapiOutdatedResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub packages: Vec<NapiOutdatedEntry>,
    #[napi(js_name = "totalChecked")]
    pub total_checked: f64,
    pub outdated: f64,
    pub major: f64,
    pub minor: f64,
    pub patch: f64,
}

#[napi(js_name = "outdated")]
pub fn napi_outdated(project_root: String) -> NapiOutdatedResult {
    let root = Path::new(&project_root);
    let lockfile = root.join("package-lock.json");

    match check_outdated(root, &lockfile) {
        Ok(report) => NapiOutdatedResult {
            ok: true,
            reason: None,
            packages: report.packages.iter().map(|p| NapiOutdatedEntry {
                name: p.name.clone(), current: p.current.clone(),
                latest: p.latest.clone(), update_type: p.update_type.clone(),
            }).collect(),
            total_checked: report.total_checked as f64,
            outdated: report.outdated as f64,
            major: report.major as f64,
            minor: report.minor as f64,
            patch: report.patch as f64,
        },
        Err(reason) => NapiOutdatedResult {
            ok: false,
            reason: Some(reason),
            packages: vec![],
            total_checked: 0.0, outdated: 0.0,
            major: 0.0, minor: 0.0, patch: 0.0,
        },
    }
}

// --- Doctor ---

#[napi(object)]
pub struct NapiDoctorFinding {
    pub id: String,
    pub title: String,
    pub severity: String,
    pub impact: f64,
    pub recommendation: String,
}

#[napi(object)]
pub struct NapiDoctorResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub score: f64,
    pub threshold: f64,
    pub findings: Vec<NapiDoctorFinding>,
}

#[napi(js_name = "doctor")]
pub fn napi_doctor(project_root: String, threshold: Option<f64>) -> NapiDoctorResult {
    let root = Path::new(&project_root);
    let thresh = threshold.map(|t| t as i32).unwrap_or(70);

    match run_doctor(root, thresh) {
        Ok(report) => NapiDoctorResult {
            ok: true,
            reason: None,
            score: report.score as f64,
            threshold: report.threshold as f64,
            findings: report.findings.iter().map(|f| NapiDoctorFinding {
                id: f.id.clone(), title: f.title.clone(),
                severity: f.severity.clone(), impact: f.impact as f64,
                recommendation: f.recommendation.clone(),
            }).collect(),
        },
        Err(reason) => NapiDoctorResult {
            ok: false,
            reason: Some(reason),
            score: 0.0, threshold: thresh as f64,
            findings: vec![],
        },
    }
}

// --- Why ---

#[napi(object)]
pub struct NapiWhyDependedBy {
    pub name: String,
    pub version: String,
}

#[napi(object)]
pub struct NapiWhyResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub package: String,
    pub version: Option<String>,
    #[napi(js_name = "isDirect")]
    pub is_direct: bool,
    #[napi(js_name = "dependencyPaths")]
    pub dependency_paths: Vec<Vec<String>>,
    #[napi(js_name = "dependedOnBy")]
    pub depended_on_by: Vec<NapiWhyDependedBy>,
    #[napi(js_name = "totalPaths")]
    pub total_paths: f64,
}

#[napi(js_name = "why")]
pub fn napi_why(project_root: String, target: String) -> NapiWhyResult {
    let root = Path::new(&project_root);
    let lockfile = root.join("package-lock.json");

    match trace_dependency(root, &lockfile, &target) {
        Ok(report) => NapiWhyResult {
            ok: true,
            reason: None,
            package: report.package,
            version: report.version,
            is_direct: report.is_direct,
            dependency_paths: report.dependency_paths,
            depended_on_by: report.depended_on_by.iter().map(|(n, v)| NapiWhyDependedBy {
                name: n.clone(), version: v.clone(),
            }).collect(),
            total_paths: report.total_paths as f64,
        },
        Err(reason) => NapiWhyResult {
            ok: false,
            reason: Some(reason),
            package: target,
            version: None,
            is_direct: false,
            dependency_paths: vec![],
            depended_on_by: vec![],
            total_paths: 0.0,
        },
    }
}

// --- Dedupe ---

#[napi(object)]
pub struct NapiDedupeEntry {
    pub name: String,
    pub versions: Vec<String>,
    pub instances: f64,
    #[napi(js_name = "canDedupe")]
    pub can_dedupe: bool,
    #[napi(js_name = "savedInstances")]
    pub saved_instances: f64,
}

#[napi(object)]
pub struct NapiDedupeResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub duplicates: Vec<NapiDedupeEntry>,
    #[napi(js_name = "totalDuplicates")]
    pub total_duplicates: f64,
    pub deduplicatable: f64,
    #[napi(js_name = "estimatedSaved")]
    pub estimated_saved: f64,
}

#[napi(js_name = "dedupe")]
pub fn napi_dedupe(project_root: String) -> NapiDedupeResult {
    let root = Path::new(&project_root);

    match check_dedupe(root) {
        Ok(report) => NapiDedupeResult {
            ok: true,
            reason: None,
            duplicates: report.duplicates.iter().map(|d| NapiDedupeEntry {
                name: d.name.clone(), versions: d.versions.clone(),
                instances: d.instances as f64, can_dedupe: d.can_dedupe,
                saved_instances: d.saved_instances as f64,
            }).collect(),
            total_duplicates: report.total_duplicates as f64,
            deduplicatable: report.deduplicatable as f64,
            estimated_saved: report.estimated_saved as f64,
        },
        Err(reason) => NapiDedupeResult {
            ok: false,
            reason: Some(reason),
            duplicates: vec![],
            total_duplicates: 0.0, deduplicatable: 0.0, estimated_saved: 0.0,
        },
    }
}

// --- Workspace List ---

#[napi(object)]
pub struct NapiWorkspaceScript {
    pub name: String,
    pub command: String,
}

#[napi(object)]
pub struct NapiWorkspacePackage {
    pub name: String,
    pub version: String,
    #[napi(js_name = "relativeDir")]
    pub relative_dir: String,
    #[napi(js_name = "workspaceDeps")]
    pub workspace_deps: Vec<String>,
    pub scripts: Vec<NapiWorkspaceScript>,
}

#[napi(object)]
pub struct NapiWorkspaceListResult {
    pub ok: bool,
    pub reason: Option<String>,
    #[napi(js_name = "workspaceType")]
    pub workspace_type: String,
    pub packages: Vec<NapiWorkspacePackage>,
}

#[napi(js_name = "workspaceList")]
pub fn napi_workspace_list(project_root: String) -> NapiWorkspaceListResult {
    let root = Path::new(&project_root);

    match detect_workspaces(root) {
        Ok(info) => NapiWorkspaceListResult {
            ok: true,
            reason: None,
            workspace_type: info.workspace_type,
            packages: info.packages.iter().map(|p| NapiWorkspacePackage {
                name: p.name.clone(), version: p.version.clone(),
                relative_dir: p.relative_dir.clone(),
                workspace_deps: p.workspace_deps.clone(),
                scripts: p.scripts.iter().map(|(n, c)| NapiWorkspaceScript {
                    name: n.clone(), command: c.clone(),
                }).collect(),
            }).collect(),
        },
        Err(reason) => NapiWorkspaceListResult {
            ok: false,
            reason: Some(reason),
            workspace_type: String::new(),
            packages: vec![],
        },
    }
}

// --- Workspace Graph ---

#[napi(object)]
pub struct NapiWorkspaceGraphResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub sorted: Vec<String>,
    pub levels: Vec<Vec<String>>,
    pub cycles: Vec<Vec<String>>,
}

#[napi(js_name = "workspaceGraph")]
pub fn napi_workspace_graph(project_root: String) -> NapiWorkspaceGraphResult {
    let root = Path::new(&project_root);

    match detect_workspaces(root) {
        Ok(info) => {
            let graph = workspace_graph(&info);
            NapiWorkspaceGraphResult {
                ok: true,
                reason: None,
                sorted: graph.sorted,
                levels: graph.levels,
                cycles: graph.cycles,
            }
        }
        Err(reason) => NapiWorkspaceGraphResult {
            ok: false,
            reason: Some(reason),
            sorted: vec![], levels: vec![], cycles: vec![],
        },
    }
}

// --- Policy Check ---

#[napi(object)]
pub struct NapiPolicyViolation {
    pub rule: String,
    pub severity: String,
    pub package: String,
    pub reason: String,
}

#[napi(object)]
pub struct NapiPolicyCheckResult {
    pub ok: bool,
    #[napi(js_name = "errorReason")]
    pub error_reason: Option<String>,
    pub score: f64,
    pub threshold: f64,
    pub pass: bool,
    pub violations: Vec<NapiPolicyViolation>,
    pub errors: f64,
    pub warnings: f64,
    pub waived: f64,
}

#[napi(js_name = "policyCheck")]
pub fn napi_policy_check(project_root: String) -> NapiPolicyCheckResult {
    let root = Path::new(&project_root);

    match policy_check(root) {
        Ok(result) => NapiPolicyCheckResult {
            ok: true,
            error_reason: None,
            score: result.score as f64,
            threshold: result.threshold as f64,
            pass: result.pass,
            violations: result.violations.iter().map(|v| NapiPolicyViolation {
                rule: v.rule.clone(), severity: v.severity.clone(),
                package: v.package.clone(), reason: v.reason.clone(),
            }).collect(),
            errors: result.errors as f64,
            warnings: result.warnings as f64,
            waived: result.waived as f64,
        },
        Err(reason) => NapiPolicyCheckResult {
            ok: false,
            error_reason: Some(reason),
            score: 0.0, threshold: 0.0, pass: false,
            violations: vec![], errors: 0.0, warnings: 0.0, waived: 0.0,
        },
    }
}

// ── v0.9 ecosystem detection ─────────────────────────────────────────────────

#[napi(js_name = "detectEcosystems")]
pub fn napi_detect_ecosystems(project_root: String) -> Vec<String> {
    let root = Path::new(&project_root);
    let registry = better_core::engine::EngineRegistry::new();
    registry.detect_workspace_ecosystems(root)
        .iter()
        .map(|m| m.ecosystem.clone())
        .collect()
}

// ── v1.0 schema version ─────────────────────────────────────────────────────

#[napi(js_name = "schemaVersion")]
pub fn napi_schema_version() -> String {
    better_core::schema::SCHEMA_VERSION.to_string()
}

// ── v1.5 supply chain ───────────────────────────────────────────────────────

#[napi(object)]
pub struct NapiSupplyChainReport {
    pub ok: bool,
    pub total_packages: u32,
    pub anomaly_count: u32,
    pub trust_score: f64,
    pub error: Option<String>,
}

#[napi(js_name = "analyzeSupplyChain")]
pub fn napi_analyze_supply_chain(project_root: String) -> NapiSupplyChainReport {
    use better_core::intelligence::supply_chain::analyze_supply_chain;
    let root = Path::new(&project_root);
    match analyze_supply_chain(root) {
        Ok(report) => NapiSupplyChainReport {
            ok: true,
            total_packages: report.total_packages as u32,
            anomaly_count: report.anomalies.len() as u32,
            trust_score: report.trust_score,
            error: None,
        },
        Err(e) => NapiSupplyChainReport {
            ok: false,
            total_packages: 0,
            anomaly_count: 0,
            trust_score: 0.0,
            error: Some(e),
        },
    }
}

// ── v1.5 intelligence ───────────────────────────────────────────────────────

#[napi(js_name = "checkTyposquat")]
pub fn napi_check_typosquat(name: String, known_packages: Vec<String>) -> f64 {
    better_core::intelligence::check_typosquat(&name, &known_packages)
}

// ── v0.8 OSP / Sardis ───────────────────────────────────────────────────────

#[napi(object)]
pub struct NapiDiscoveryResult {
    pub provider_id: String,
    pub display_name: String,
    pub offering_id: String,
    pub offering_name: String,
    pub category: String,
    pub description: Option<String>,
    pub free_tier: bool,
    pub source: String,
}

/// Search for OSP providers by category or keyword.
/// Returns JSON array of DiscoveryResult — falls back to curated list offline.
#[napi(js_name = "ospDiscover")]
pub fn napi_osp_discover(query: String, category: Option<String>) -> String {
    use better_core::osp::search::discover;
    let results = discover(
        &query,
        category.as_deref(),
        None,
        20,
    ).unwrap_or_default();
    serde_json::to_string(&results).unwrap_or_else(|_| "[]".into())
}

#[napi(object)]
pub struct NapiOspServiceEntry {
    pub provider_id: String,
    pub offering_id: String,
    pub resource_id: String,
    pub tier_id: String,
    pub status: String,
    pub dashboard_url: Option<String>,
}

/// List all provisioned OSP services from the local vault.
#[napi(js_name = "ospServicesList")]
pub fn napi_osp_services_list() -> String {
    use better_core::osp::vault::Vault;
    match Vault::open() {
        Ok(vault) => {
            let entries: Vec<_> = vault.list_entries().iter().map(|e| {
                serde_json::json!({
                    "provider_id": e.provider_id,
                    "offering_id": e.offering_id,
                    "resource_id": e.resource_id,
                    "tier_id": e.tier_id,
                    "status": format!("{:?}", e.status),
                    "dashboard_url": e.dashboard_url,
                })
            }).collect();
            serde_json::to_string(&entries).unwrap_or_else(|_| "[]".into())
        }
        Err(e) => {
            serde_json::json!({ "error": e.to_string() }).to_string()
        }
    }
}

/// Deprovision a service — calls OSP DELETE endpoint and removes vault entry.
#[napi(js_name = "ospDeprovisionService")]
pub fn napi_osp_deprovision(provider_id: String, offering: String) -> String {
    use better_core::osp::vault::Vault;
    use better_core::osp::discovery::fetch_manifest;
    use better_core::osp::deprovision::deprovision;
    match Vault::open() {
        Ok(mut vault) => {
            match fetch_manifest(&provider_id) {
                Ok(manifest) => {
                    match deprovision(&mut vault, &manifest, &provider_id, &offering, None, false) {
                        Ok(result) => serde_json::json!({
                            "ok": true,
                            "resource_id": result.resource_id,
                            "vault_cleaned": result.vault_cleaned,
                            "env_warnings": result.env_warnings,
                        }).to_string(),
                        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
                    }
                }
                Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
            }
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

/// Generate .env file by resolving osp:// URIs in .env.osp template.
#[napi(js_name = "ospEnvGenerate")]
pub fn napi_osp_env_generate(project_root: String) -> String {
    use better_core::osp::env_gen::{generate_env, write_env_file};
    use better_core::osp::vault::Vault;
    let root = Path::new(&project_root);
    let template = root.join(".env.osp");
    if !template.exists() {
        return serde_json::json!({ "ok": false, "error": ".env.osp not found" }).to_string();
    }
    match Vault::open() {
        Ok(mut vault) => {
            match vault.agent_secret_key() {
                Ok(secret) => {
                    match generate_env(&template, &vault, &secret) {
                        Ok(pairs) => {
                            let count = pairs.len();
                            let out = root.join(".env");
                            match write_env_file(&out, &pairs) {
                                Ok(()) => serde_json::json!({
                                    "ok": true,
                                    "vars_written": count,
                                    "output": out.to_string_lossy(),
                                }).to_string(),
                                Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
                            }
                        }
                        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
                    }
                }
                Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
            }
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

// ── v1.5 Reputation Scoring ─────────────────────────────────────────────────

/// Score a package's reputation (0-100) using live signals.
/// Returns JSON: { ok, package, version, score, grade, breakdown, flags, computed_at }
#[napi(js_name = "reputationScore")]
pub fn napi_reputation_score(package_name: String, ecosystem: String, version: String) -> String {
    use better_core::intelligence::signals::collect_signals;
    use better_core::intelligence::compute_score;

    let signals = collect_signals(&package_name, &ecosystem, &version);
    let scored = compute_score(&signals);

    let flags_json: Vec<serde_json::Value> = scored.flags.iter().map(|f| {
        serde_json::json!({
            "flag_type": format!("{:?}", f.flag_type).to_lowercase().replace("_", "_"),
            "severity": format!("{:?}", f.severity).to_lowercase(),
            "message": f.message
        })
    }).collect();

    serde_json::json!({
        "ok": true,
        "package": scored.package,
        "version": scored.version,
        "score": scored.score,
        "grade": scored.grade.label(),
        "breakdown": {
            "maintainer_health": scored.breakdown.maintainer_health,
            "security_posture": scored.breakdown.security_posture,
            "activity_vitality": scored.breakdown.activity_vitality,
            "community_trust": scored.breakdown.community_trust
        },
        "flags": flags_json,
        "computed_at": scored.computed_at
    }).to_string()
}

/// Plan audit vulnerability fixes (dry-run — no npm install is called).
/// Input: JSON array of { package, version, severity, ids, patched_version }
/// Returns JSON: { ok, fixes_attempted, fixes_applied, fixes_rolled_back, remaining_vulns, details }
#[napi(js_name = "planAuditFixes")]
pub fn napi_plan_audit_fixes(
    project_root: String,
    vulnerabilities_json: String,
    force_major: bool,
) -> String {
    use better_core::intelligence::audit_fix::{apply_audit_fixes, AuditFixConfig, AuditVuln};
    use std::path::Path;

    let vulns: Vec<AuditVuln> = match serde_json::from_str(&vulnerabilities_json) {
        Ok(v) => v,
        Err(e) => return serde_json::json!({ "ok": false, "error": format!("invalid vulns JSON: {}", e) }).to_string(),
    };

    let config = AuditFixConfig {
        dry_run: true,
        run_tests: false,
        force_major,
        test_command: None,
    };

    match apply_audit_fixes(Path::new(&project_root), &vulns, &config) {
        Ok(result) => match serde_json::to_string(&result) {
            Ok(json) => format!("{{\"ok\":true,\"data\":{}}}", json),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
        },
        Err(e) => serde_json::json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Plan (and optionally execute) a smart upgrade with changelog analysis + reputation gating.
/// Returns JSON: { ok, package, from_version, to_version, steps_applied, risk_level,
///                  tests_passed, rollback_applied, dry_run, summary }
#[napi(js_name = "planSmartUpgrade")]
pub fn napi_plan_smart_upgrade(
    project_root: String,
    package_name: String,
    from_version: String,
    to_version: String,
    changelog_text: Option<String>,
    dry_run: bool,
    min_reputation_score: u32,
) -> String {
    use better_core::intelligence::changelog::analyze_changelog;
    use better_core::intelligence::signals::collect_signals;
    use better_core::intelligence::compute_score;
    use better_core::intelligence::smart_upgrade::{smart_upgrade, UpgradeInput};
    use std::path::Path;

    let changelog = changelog_text.as_deref().and_then(|text| {
        if text.is_empty() { return None; }
        analyze_changelog(&package_name, &from_version, &to_version, text).ok()
    });

    let signals = collect_signals(&package_name, "npm", &to_version);
    let rep = compute_score(&signals);

    let input = UpgradeInput {
        project_root: Path::new(&project_root),
        package: &package_name,
        from_version: &from_version,
        to_version: &to_version,
        changelog: changelog.as_ref(),
        target_reputation: Some(&rep),
        dry_run,
        min_reputation_score: min_reputation_score as u8,
    };

    match smart_upgrade(&input) {
        Ok(result) => match serde_json::to_string(&result) {
            Ok(json) => format!("{{\"ok\":true,\"data\":{}}}", json),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
        },
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

/// Analyze a changelog text for breaking changes between two versions.
/// Returns JSON: { ok, package, from_version, to_version, breaking_changes, risk_level, migration_steps }
#[napi(js_name = "analyzeChangelog")]
pub fn napi_analyze_changelog(
    package_name: String,
    from_version: String,
    to_version: String,
    changelog_text: String,
) -> String {
    use better_core::intelligence::changelog::analyze_changelog;

    match analyze_changelog(&package_name, &from_version, &to_version, &changelog_text) {
        Ok(analysis) => match serde_json::to_string(&analysis) {
            Ok(json) => format!("{{\"ok\":true,\"data\":{}}}", json),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
        },
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

/// Predict maintenance status for a package using live signals.
/// Returns JSON: { ok, package, version, current_status, predicted_status_6mo,
///                 confidence, risk_score, signals, recommended_action, alternatives }
#[napi(js_name = "predictMaintenance")]
pub fn napi_predict_maintenance(package_name: String, ecosystem: String, version: String) -> String {
    use better_core::intelligence::signals::collect_signals;
    use better_core::intelligence::predict::predict_maintenance;

    let signals = collect_signals(&package_name, &ecosystem, &version);
    let prediction = predict_maintenance(&signals);

    match serde_json::to_string(&prediction) {
        Ok(json) => format!("{{\"ok\":true,\"data\":{}}}", json),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

/// Analyze the impact of removing a dependency from the project.
/// Returns JSON: { ok, package, version, usage, removal_impact, alternatives }
#[napi(js_name = "analyzeImpact")]
pub fn napi_analyze_impact(
    project_root: String,
    package_name: String,
    version: String,
    dependents: Vec<String>,
    transitive_remove_count: u32,
    pkg_size_bytes: u32,
) -> String {
    use better_core::intelligence::impact::analyze_impact;
    use std::path::Path;

    let result = analyze_impact(
        Path::new(&project_root),
        &package_name,
        &version,
        &dependents,
        transitive_remove_count as usize,
        pkg_size_bytes as u64,
    );

    match serde_json::to_string(&result) {
        Ok(json) => format!("{{\"ok\":true,\"data\":{}}}", json),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

// ── v0.8 Monetization ───────────────────────────────────────────────────────

/// Fetch earnings summary from Sardis API. Requires SARDIS_TOKEN env var.
#[napi(js_name = "fetchEarnings")]
pub fn napi_fetch_earnings(period_days: u32, with_breakdown: bool) -> String {
    use better_core::sardis::auth::{SardisSession, SardisError};
    use better_core::monetize::earnings::fetch_earnings;

    let token = match std::env::var("SARDIS_TOKEN") {
        Ok(t) => t,
        Err(_) => return serde_json::json!({ "ok": false, "error": "SARDIS_TOKEN not set" }).to_string(),
    };

    // Build a minimal session from env token
    let session = SardisSession {
        access_token: token,
        refresh_token: String::new(),
        wallet_id: std::env::var("SARDIS_WALLET_ID").unwrap_or_default(),
        agent_id: std::env::var("SARDIS_AGENT_ID").unwrap_or_default(),
        expires_at: (chrono::Utc::now() + chrono::Duration::hours(24)).to_rfc3339(),
    };

    match fetch_earnings(&session, period_days, with_breakdown) {
        Ok(summary) => match serde_json::to_string(&summary) {
            Ok(json) => format!("{{\"ok\":true,\"data\":{}}}", json),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
        },
        Err(SardisError::SessionExpired) =>
            serde_json::json!({ "ok": false, "error": "Session expired" }).to_string(),
        Err(e) =>
            serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

/// Pay a package maintainer. Requires SARDIS_TOKEN env var.
#[napi(js_name = "payPackage")]
pub fn napi_pay_package(package_name: String, amount: String, currency: String) -> String {
    use better_core::sardis::auth::SardisSession;
    use better_core::monetize::pay::pay_package;

    let token = match std::env::var("SARDIS_TOKEN") {
        Ok(t) => t,
        Err(_) => return serde_json::json!({ "ok": false, "error": "SARDIS_TOKEN not set" }).to_string(),
    };

    let session = SardisSession {
        access_token: token,
        refresh_token: String::new(),
        wallet_id: std::env::var("SARDIS_WALLET_ID").unwrap_or_default(),
        agent_id: std::env::var("SARDIS_AGENT_ID").unwrap_or_default(),
        expires_at: (chrono::Utc::now() + chrono::Duration::hours(24)).to_rfc3339(),
    };

    match pay_package(&session, &package_name, &amount, &currency) {
        Ok(result) => match serde_json::to_string(&result) {
            Ok(json) => format!("{{\"ok\":true,\"data\":{}}}", json),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
        },
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

/// Create a sponsorship for a package. Requires SARDIS_TOKEN env var.
#[napi(js_name = "createSponsorship")]
pub fn napi_create_sponsorship(
    package_name: String,
    amount: String,
    currency: String,
    schedule: String,
) -> String {
    use better_core::sardis::auth::SardisSession;
    use better_core::monetize::sponsor::{create_sponsorship, SponsorSchedule};

    let token = match std::env::var("SARDIS_TOKEN") {
        Ok(t) => t,
        Err(_) => return serde_json::json!({ "ok": false, "error": "SARDIS_TOKEN not set" }).to_string(),
    };

    let session = SardisSession {
        access_token: token,
        refresh_token: String::new(),
        wallet_id: std::env::var("SARDIS_WALLET_ID").unwrap_or_default(),
        agent_id: std::env::var("SARDIS_AGENT_ID").unwrap_or_default(),
        expires_at: (chrono::Utc::now() + chrono::Duration::hours(24)).to_rfc3339(),
    };

    let sched = match schedule.to_lowercase().as_str() {
        "monthly" => SponsorSchedule::Monthly,
        "quarterly" => SponsorSchedule::Quarterly,
        "annual" => SponsorSchedule::Annual,
        _ => SponsorSchedule::OneTime,
    };

    match create_sponsorship(&session, &package_name, &amount, &currency, sched) {
        Ok(result) => match serde_json::to_string(&result) {
            Ok(json) => format!("{{\"ok\":true,\"data\":{}}}", json),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
        },
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

// v2.0 Task: AI dependency review
#[napi(js_name = "reviewDependencies")]
pub fn napi_review_dependencies(project_root: String) -> String {
    use better_core::ai::review::review_dependencies;
    use std::path::Path;
    match review_dependencies(Path::new(&project_root)) {
        Ok(review) => match serde_json::to_string(&review) {
            Ok(json) => format!("{{\"ok\":true,\"data\":{}}}", json),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
        },
        Err(e) => serde_json::json!({ "ok": false, "error": e }).to_string(),
    }
}

// v2.0 Task: self-healing dependency checks
#[napi(js_name = "selfHeal")]
pub fn napi_self_heal(project_root: String, dry_run: bool) -> String {
    use better_core::ai::SelfHealingEngine;
    use std::path::Path;
    let actions = SelfHealingEngine::heal(Path::new(&project_root), dry_run);
    match serde_json::to_string(&actions) {
        Ok(json) => format!("{{\"ok\":true,\"actions\":{}}}", json),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

// v2.0 Task: org-level cross-project insights
#[napi(js_name = "analyzeOrg")]
pub fn napi_analyze_org(root_dir: String) -> String {
    use better_core::ai::insights::analyze_org;
    use std::path::Path;
    match analyze_org(Path::new(&root_dir)) {
        Ok(insights) => match serde_json::to_string(&insights) {
            Ok(json) => format!("{{\"ok\":true,\"data\":{}}}", json),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
        },
        Err(e) => serde_json::json!({ "ok": false, "error": e }).to_string(),
    }
}
