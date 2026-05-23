use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

// --- Core types ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeLayout {
    /// Traditional flat node_modules (default, npm-style hoisted)
    Hoist,
    /// Strict isolation: pnpm-style symlink structure preventing phantom deps
    Strict,
}

impl NodeLayout {
    pub fn from_arg(value: &str) -> Option<Self> {
        match value {
            "hoist" | "hoisted" | "flat" => Some(Self::Hoist),
            "strict" | "isolated" | "pnpm" => Some(Self::Strict),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Hoist => "hoist",
            Self::Strict => "strict",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum LinkStrategy {
    Auto,
    Hardlink,
    Copy,
}

impl LinkStrategy {
    pub fn from_arg(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "hardlink" => Some(Self::Hardlink),
            "copy" => Some(Self::Copy),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Hardlink => "hardlink",
            Self::Copy => "copy",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum MaterializeProfile {
    Auto,
    IoHeavy,
    SmallFiles,
}

impl MaterializeProfile {
    pub fn from_arg(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "io-heavy" => Some(Self::IoHeavy),
            "small-files" => Some(Self::SmallFiles),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::IoHeavy => "io-heavy",
            Self::SmallFiles => "small-files",
        }
    }
}

#[derive(Default, Clone)]
pub struct ScanAgg {
    pub logical: u64,
    pub physical: u64,
    pub shared: u64,
    pub file_count: u64,
    pub package_count: u64,
    pub approx: bool,
}

#[derive(Default, Clone)]
pub struct MaterializeStats {
    pub files: u64,
    pub files_linked: u64,
    pub files_copied: u64,
    pub link_fallback_copies: u64,
    pub directories: u64,
    pub symlinks: u64,
    pub fallback_eperm: u64,
    pub fallback_exdev: u64,
    pub fallback_other: u64,
}

#[derive(Default)]
pub struct PhaseDurations {
    pub scan_ms: u64,
    pub mkdir_ms: u64,
    pub link_copy_ms: u64,
    pub total_ms: u64,
}

#[derive(Default)]
pub struct MaterializeCounters {
    pub files: AtomicU64,
    pub files_linked: AtomicU64,
    pub files_copied: AtomicU64,
    pub link_fallback_copies: AtomicU64,
    pub symlinks: AtomicU64,
    pub fallback_eperm: AtomicU64,
    pub fallback_exdev: AtomicU64,
    pub fallback_other: AtomicU64,
}

impl MaterializeCounters {
    pub fn snapshot(&self) -> MaterializeStats {
        MaterializeStats {
            files: self.files.load(Ordering::Relaxed),
            files_linked: self.files_linked.load(Ordering::Relaxed),
            files_copied: self.files_copied.load(Ordering::Relaxed),
            link_fallback_copies: self.link_fallback_copies.load(Ordering::Relaxed),
            directories: 0,
            symlinks: self.symlinks.load(Ordering::Relaxed),
            fallback_eperm: self.fallback_eperm.load(Ordering::Relaxed),
            fallback_exdev: self.fallback_exdev.load(Ordering::Relaxed),
            fallback_other: self.fallback_other.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone)]
pub struct PackageOut {
    pub key: String,
    pub name: String,
    pub version: String,
    pub paths: Vec<String>,
    pub min_depth: u64,
    pub max_depth: u64,
    pub logical: u64,
    pub physical: u64,
    pub shared: u64,
    pub file_count: u64,
    pub approx: bool,
}

pub struct DuplicateOut {
    pub name: String,
    pub versions: Vec<String>,
    pub majors: Vec<String>,
    pub count: u64,
}

pub struct DepthOut {
    pub max_depth: u64,
    pub p95_depth: u64,
}

/// Aggregate return type for analyze()
pub struct AnalyzeReport {
    pub totals: ScanAgg,
    pub packages: Vec<PackageOut>,
    pub duplicates: Vec<DuplicateOut>,
    pub depth: DepthOut,
    pub node_modules_dir: PathBuf,
}

/// Aggregate return type for materialize_tree()
#[derive(Default)]
pub struct MaterializeReport {
    pub stats: MaterializeStats,
    pub phases: PhaseDurations,
}

// --- Install engine types ---

#[derive(Clone)]
pub struct ResolvedPackage {
    pub name: String,
    pub version: String,
    pub rel_path: String,
    pub resolved_url: String,
    pub integrity: String,
}

#[derive(Clone)]
pub struct ResolveResult {
    pub packages: Vec<ResolvedPackage>,
    pub lockfile_version: u64,
}

#[derive(Clone)]
pub struct FetchResult {
    pub packages_fetched: u64,
    pub packages_cached: u64,
    pub bytes_downloaded: u64,
}

/// Content-addressed store layout
pub struct CasLayout {
    pub tarballs_dir: PathBuf,
    pub unpacked_dir: PathBuf,
    pub tmp_dir: PathBuf,
}

impl CasLayout {
    pub fn new(cache_dir: &std::path::Path) -> Self {
        Self {
            tarballs_dir: cache_dir.join("store").join("tarballs"),
            unpacked_dir: cache_dir.join("store").join("unpacked"),
            tmp_dir: cache_dir.join("tmp"),
        }
    }
}

// --- File-level CAS types ---

#[derive(Debug, Clone)]
pub struct FileCasIngestResult {
    pub total_files: u64,
    pub new_files: u64,
    pub existing_files: u64,
    pub total_bytes: u64,
    pub reused: bool,
}

#[derive(Debug, Clone)]
pub struct FileCasMaterializeResult {
    pub ok: bool,
    pub files: u64,
    pub linked: u64,
    pub copied: u64,
    pub symlinks: u64,
}

// --- Bin links ---

#[derive(Debug, Clone, Default)]
pub struct BinLinkResult {
    pub links_created: u64,
    pub links_failed: u64,
}

// --- Lifecycle scripts ---

#[derive(Debug, Clone)]
pub struct LifecycleScriptInfo {
    pub package_name: String,
    pub package_dir: PathBuf,
    pub script_name: String,
    pub script_command: String,
}

#[derive(Debug, Clone, Default)]
pub struct LifecycleDetectionResult {
    pub has_native_addons: bool,
    pub scripts: Vec<LifecycleScriptInfo>,
    pub packages_with_binding_gyp: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct LifecycleRunResult {
    pub scripts_run: u64,
    pub scripts_succeeded: u64,
    pub scripts_failed: u64,
    pub skipped_reason: Option<String>,
    pub rebuild_exit_code: Option<i32>,
}

// --- Strict materialization types ---

#[derive(Debug, Default)]
pub struct StrictMaterializeStats {
    pub packages: u64,
    pub files_linked: u64,
    pub files_copied: u64,
    pub internal_symlinks: u64,
    pub root_symlinks: u64,
    pub directories: u64,
}

// --- Materialize task types ---

#[derive(Clone)]
pub struct MaterializeFileTask {
    pub src: PathBuf,
    pub dst: PathBuf,
}

#[derive(Clone)]
pub struct MaterializeSymlinkTask {
    pub src: PathBuf,
    pub dst: PathBuf,
    pub target: PathBuf,
}

pub enum MaterializeTask {
    File(MaterializeFileTask),
    Symlink(MaterializeSymlinkTask),
}

// --- Script runner types ---

#[derive(Debug)]
pub struct ScriptRunResult {
    pub script_name: String,
    pub command: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

// --- License types ---

#[derive(Debug, Clone)]
pub struct LicenseInfo {
    pub name: String,
    pub version: String,
    pub license: String,
}

#[derive(Debug)]
pub struct LicenseReport {
    pub packages: Vec<LicenseInfo>,
    pub by_license: std::collections::BTreeMap<String, u64>,
    pub total_packages: u64,
    pub violations: Vec<LicenseInfo>,
}

// --- Dedupe types ---

#[derive(Debug)]
pub struct DedupeEntry {
    pub name: String,
    pub versions: Vec<String>,
    pub instances: u64,
    pub can_dedupe: bool,
    pub saved_instances: u64,
}

#[derive(Debug)]
pub struct DedupeReport {
    pub duplicates: Vec<DedupeEntry>,
    pub total_duplicates: u64,
    pub deduplicatable: u64,
    pub estimated_saved: u64,
}

// --- Why (dependency tracer) types ---

#[derive(Debug)]
pub struct WhyReport {
    pub package: String,
    pub version: Option<String>,
    pub is_direct: bool,
    pub dependency_paths: Vec<Vec<String>>,
    pub depended_on_by: Vec<(String, String, String)>, // (name, version, range)
    pub total_paths: u64,
}

// --- Outdated types ---

#[derive(Debug, Clone)]
pub struct OutdatedEntry {
    pub name: String,
    pub current: String,
    pub latest: String,
    pub update_type: String,
}

#[derive(Debug)]
pub struct OutdatedReport {
    pub packages: Vec<OutdatedEntry>,
    pub total_checked: u64,
    pub outdated: u64,
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

// --- Doctor types ---

#[derive(Debug, Clone)]
pub struct DoctorFinding {
    pub id: String,
    pub title: String,
    pub severity: String,
    pub impact: i32,
    pub recommendation: String,
}

#[derive(Debug)]
pub struct DoctorReport {
    pub score: i32,
    pub threshold: i32,
    pub findings: Vec<DoctorFinding>,
}

// --- Cache types ---

#[derive(Debug)]
pub struct CacheStatsReport {
    pub cache_root: PathBuf,
    pub total_bytes: u64,
    pub package_count: u64,
    pub tarball_count: u64,
    pub tarball_bytes: u64,
    pub unpacked_count: u64,
    pub unpacked_bytes: u64,
    pub file_cas_count: u64,
    pub file_cas_bytes: u64,
}

#[derive(Debug)]
pub struct CacheGcReport {
    pub removed: u64,
    pub freed_bytes: u64,
    pub dry_run: bool,
}

// --- Audit types ---

#[derive(Debug, Clone)]
pub struct AuditVulnerability {
    pub id: String,
    pub summary: String,
    pub severity: String,
    pub package: String,
    pub version: String,
    pub fixed: String,
}

#[derive(Debug)]
pub struct AuditReport {
    pub scanned_packages: u64,
    pub vulnerabilities: Vec<AuditVulnerability>,
    pub total: u64,
    pub critical: u64,
    pub high: u64,
    pub medium: u64,
    pub low: u64,
    pub risk_level: String,
}

// --- Benchmark types ---

#[derive(Debug, Clone)]
pub struct BenchmarkTiming {
    pub median_ms: u64,
    pub min_ms: u64,
    pub max_ms: u64,
    pub mean_ms: u64,
}

#[derive(Debug, Clone)]
pub struct BenchmarkResult {
    pub name: String,
    pub cold: BenchmarkTiming,
    pub warm: BenchmarkTiming,
}

#[derive(Debug)]
pub struct BenchmarkReport {
    pub platform: String,
    pub arch: String,
    pub cpus: u64,
    pub results: Vec<BenchmarkResult>,
}

// --- Hooks types ---

#[derive(Debug)]
pub struct HooksInstallResult {
    pub hooks_installed: u64,
    pub from_config: bool,
    pub hooks: Vec<(String, String)>,
}

// --- Env types ---

#[derive(Debug)]
pub struct EnvInfo {
    pub node_version: String,
    pub npm_version: String,
    pub better_version: String,
    pub platform: String,
    pub arch: String,
    pub project_name: Option<String>,
    pub project_version: Option<String>,
    pub engines: Option<String>,
}

#[derive(Debug)]
pub struct EnvCheckEntry {
    pub tool: String,
    pub current: String,
    pub required: String,
    pub satisfied: bool,
}

#[derive(Debug)]
pub struct EnvCheckResult {
    pub checks: Vec<EnvCheckEntry>,
    pub all_ok: bool,
}

// --- Init types ---

#[derive(Debug)]
pub struct InitResult {
    pub files_created: Vec<String>,
    pub template: Option<String>,
}

// --- Npmrc types ---

pub struct NpmrcConfig {
    pub default_registry: String,
    pub scoped_registries: Vec<(String, String)>,
    pub auth_tokens: Vec<(String, String)>,
}

impl Default for NpmrcConfig {
    fn default() -> Self {
        Self {
            default_registry: "https://registry.npmjs.org/".to_string(),
            scoped_registries: Vec::new(),
            auth_tokens: Vec::new(),
        }
    }
}

// --- Script policy types ---

pub struct ScriptPolicy {
    pub default_policy: String,
    pub allowed_packages: Vec<String>,
    pub blocked_packages: Vec<String>,
    pub allowed_script_types: Vec<String>,
    pub trusted_scopes: Vec<String>,
}

pub struct ScriptScanEntry {
    pub name: String,
    pub version: String,
    pub scripts: Vec<(String, String)>,
    pub policy: String,
    pub reason: String,
}

pub struct ScriptScanResult {
    pub packages: Vec<ScriptScanEntry>,
    pub total_with_scripts: u64,
    pub allowed: u64,
    pub blocked: u64,
}

// --- Policy engine types ---

pub struct PolicyRule {
    pub id: String,
    pub severity: String,
    pub description: String,
    pub max_duplicates: Option<u64>,
    pub max_depth: Option<u64>,
    pub banned_packages: Vec<String>,
    // v2 fields
    pub max_install_size_mb: Option<u64>,
    pub min_maintainers: Option<u64>,
    pub min_publish_age_days: Option<u64>,
    pub require_source: Option<bool>,
    pub max_direct_deps: Option<u64>,
}

pub struct PolicyWaiver {
    pub rule: String,
    pub package: String,
}

pub struct PolicyConfig {
    pub threshold: i32,
    pub rules: Vec<PolicyRule>,
    pub waivers: Vec<PolicyWaiver>,
}

pub struct PolicyViolation {
    pub rule: String,
    pub severity: String,
    pub package: String,
    pub reason: String,
}

pub struct PolicyCheckResult {
    pub score: i32,
    pub threshold: i32,
    pub pass: bool,
    pub violations: Vec<PolicyViolation>,
    pub errors: u64,
    pub warnings: u64,
    pub waived: u64,
}

// --- Lock metadata types ---

pub struct LockFingerprint {
    pub platform: String,
    pub arch: String,
    pub node_major: u64,
    pub pm: String,
}

pub struct LockMetadata {
    pub key: String,
    pub lockfile_file: String,
    pub lockfile_hash: String,
    pub fingerprint: LockFingerprint,
}

pub struct LockVerifyResult {
    pub ok: bool,
    pub key_matches: bool,
    pub lockfile_matches: bool,
    pub expected: Option<LockMetadata>,
    pub current: LockMetadata,
}

// --- Workspace types ---

pub struct WorkspacePackage {
    pub name: String,
    pub version: String,
    pub dir: PathBuf,
    pub relative_dir: String,
    pub workspace_deps: Vec<String>,
    pub scripts: Vec<(String, String)>,
}

pub struct WorkspaceInfo {
    pub workspace_type: String,
    pub packages: Vec<WorkspacePackage>,
}

pub struct WorkspaceGraphResult {
    pub sorted: Vec<String>,
    pub levels: Vec<Vec<String>>,
    pub cycles: Vec<Vec<String>>,
}

pub struct WorkspaceChangedResult {
    pub since_ref: String,
    pub changed_files: u64,
    pub changed_packages: Vec<String>,
    pub affected_packages: Vec<String>,
}

pub struct WorkspaceRunResult {
    pub command: String,
    pub total: u64,
    pub success: u64,
    pub failure: u64,
    pub results: Vec<(String, i32, u64)>,
}

// --- SBOM types ---

pub struct SbomComponent {
    pub name: String,
    pub version: String,
    pub license: String,
    pub purl: String,
    pub integrity: String,
}

pub struct SbomReport {
    pub format: String,
    pub components: Vec<SbomComponent>,
    pub project_name: String,
    pub project_version: String,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_layout_from_arg_hoist() {
        assert_eq!(NodeLayout::from_arg("hoist"), Some(NodeLayout::Hoist));
        assert_eq!(NodeLayout::from_arg("hoisted"), Some(NodeLayout::Hoist));
        assert_eq!(NodeLayout::from_arg("flat"), Some(NodeLayout::Hoist));
        assert_eq!(NodeLayout::from_arg("strict"), Some(NodeLayout::Strict));
        assert_eq!(NodeLayout::from_arg("pnpm"), Some(NodeLayout::Strict));
        assert_eq!(NodeLayout::from_arg("unknown"), None);
    }

    #[test]
    fn node_layout_as_str() {
        assert_eq!(NodeLayout::Hoist.as_str(), "hoist");
        assert_eq!(NodeLayout::Strict.as_str(), "strict");
    }

    #[test]
    fn link_strategy_from_arg() {
        assert!(matches!(LinkStrategy::from_arg("auto"), Some(LinkStrategy::Auto)));
        assert!(matches!(LinkStrategy::from_arg("hardlink"), Some(LinkStrategy::Hardlink)));
        assert!(matches!(LinkStrategy::from_arg("copy"), Some(LinkStrategy::Copy)));
        assert!(LinkStrategy::from_arg("invalid").is_none());
    }

    #[test]
    fn materialize_profile_from_arg() {
        assert!(matches!(MaterializeProfile::from_arg("auto"), Some(MaterializeProfile::Auto)));
        assert!(matches!(MaterializeProfile::from_arg("io-heavy"), Some(MaterializeProfile::IoHeavy)));
        assert!(matches!(MaterializeProfile::from_arg("small-files"), Some(MaterializeProfile::SmallFiles)));
        assert!(MaterializeProfile::from_arg("bogus").is_none());
    }

    #[test]
    fn link_strategy_as_str() {
        assert_eq!(LinkStrategy::Auto.as_str(), "auto");
        assert_eq!(LinkStrategy::Hardlink.as_str(), "hardlink");
        assert_eq!(LinkStrategy::Copy.as_str(), "copy");
    }

    #[test]
    fn materialize_profile_as_str() {
        assert_eq!(MaterializeProfile::Auto.as_str(), "auto");
        assert_eq!(MaterializeProfile::IoHeavy.as_str(), "io-heavy");
        assert_eq!(MaterializeProfile::SmallFiles.as_str(), "small-files");
    }

    #[test]
    fn materialize_counters_snapshot_reflects_values() {
        use std::sync::atomic::Ordering;
        let c = MaterializeCounters::default();
        c.files.store(10, Ordering::Relaxed);
        c.files_linked.store(7, Ordering::Relaxed);
        c.files_copied.store(3, Ordering::Relaxed);
        let snap = c.snapshot();
        assert_eq!(snap.files, 10);
        assert_eq!(snap.files_linked, 7);
        assert_eq!(snap.files_copied, 3);
    }

    #[test]
    fn cas_layout_new_uses_cache_dir() {
        let base = std::path::Path::new("/tmp/my-cache");
        let layout = CasLayout::new(base);
        assert!(layout.tarballs_dir.starts_with(base));
        assert!(layout.unpacked_dir.starts_with(base));
        assert!(layout.tmp_dir.starts_with(base));
    }

    #[test]
    fn npmrc_config_default_registry() {
        let cfg = NpmrcConfig::default();
        assert!(cfg.default_registry.contains("npmjs.org"));
        assert!(cfg.scoped_registries.is_empty());
        assert!(cfg.auth_tokens.is_empty());
    }

    #[test]
    fn node_layout_isolated_alias() {
        assert_eq!(NodeLayout::from_arg("isolated"), Some(NodeLayout::Strict));
    }
}
