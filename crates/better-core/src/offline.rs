// crates/better-core/src/offline.rs
//
// Offline mode support (Task 76 / v0.9).
//
// Enables `better install --offline` which installs entirely from the local
// Content-Addressable Store (CAS) without hitting the network.
// Also provides `better cache prefetch` to pre-populate CAS for offline use.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

// ---------------------------------------------------------------------------
// CAS availability check
// ---------------------------------------------------------------------------

/// Result of checking CAS coverage for a set of packages.
#[derive(Debug, Serialize)]
pub struct CasAvailability {
    pub total: usize,
    pub available: usize,
    pub missing_count: usize,
    /// Package keys ("name@version") not found in CAS
    pub missing: Vec<String>,
    pub can_install_offline: bool,
}

/// A package entry for CAS checking.
#[derive(Debug, Clone)]
pub struct PkgRef {
    pub name: String,
    pub version: String,
    pub integrity: String, // sha512-xxx  or sha1-xxx
    pub ecosystem: Ecosystem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ecosystem {
    Npm,
    Python,
    Cargo,
    Go,
}

impl Ecosystem {
    pub fn cas_subdir(&self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Python => "pypi",
            Self::Cargo => "crates",
            Self::Go => "go",
        }
    }
}

/// Check which packages in `packages` are already in the CAS at `cas_root`.
pub fn check_cas_availability(
    cas_root: &Path,
    packages: &[PkgRef],
) -> CasAvailability {
    let mut available = 0usize;
    let mut missing: Vec<String> = Vec::new();

    for pkg in packages {
        let key = format!("{}@{}", pkg.name, pkg.version);
        if cas_has_package(cas_root, pkg) {
            available += 1;
        } else {
            missing.push(key);
        }
    }

    let total = packages.len();
    CasAvailability {
        total,
        available,
        missing_count: missing.len(),
        can_install_offline: missing.is_empty(),
        missing,
    }
}

/// Check if a specific package is present in the CAS.
///
/// For npm packages we look for a tarball file named by the integrity hash.
/// For other ecosystems we look in the appropriate subdirectory.
fn cas_has_package(cas_root: &Path, pkg: &PkgRef) -> bool {
    let subdir = cas_root.join(pkg.ecosystem.cas_subdir());

    // Primary check: integrity-based path
    if !pkg.integrity.is_empty() {
        let filename = integrity_to_filename(&pkg.integrity);
        if subdir.join(&filename).exists() {
            return true;
        }
    }

    // Fallback: name@version directory exists
    let name_ver = format!("{}-{}", sanitise_name(&pkg.name), pkg.version);
    subdir.join(&name_ver).exists()
        || subdir.join(format!("{}.tar.gz", name_ver)).exists()
}

fn integrity_to_filename(integrity: &str) -> String {
    integrity.replace('/', "_").replace(':', "-")
}

fn sanitise_name(name: &str) -> String {
    name.replace('/', "__").replace('@', "")
}

// ---------------------------------------------------------------------------
// CAS stats
// ---------------------------------------------------------------------------

/// Statistics about the current CAS contents.
#[derive(Debug, Serialize)]
pub struct CasStats {
    pub total_files: u64,
    pub total_bytes: u64,
    pub by_ecosystem: HashMap<String, u64>,
}

/// Scan the CAS at `cas_root` and return usage statistics.
pub fn cas_stats(cas_root: &Path) -> CasStats {
    let mut stats = CasStats {
        total_files: 0,
        total_bytes: 0,
        by_ecosystem: HashMap::new(),
    };

    let subdirs = ["npm", "pypi", "crates", "go", "other"];
    for sub in subdirs {
        let dir = cas_root.join(sub);
        if !dir.exists() {
            continue;
        }
        let mut eco_bytes = 0u64;
        let mut eco_files = 0u64;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        eco_bytes += meta.len();
                        eco_files += 1;
                    }
                }
            }
        }
        stats.total_bytes += eco_bytes;
        stats.total_files += eco_files;
        if eco_files > 0 {
            stats.by_ecosystem.insert(sub.to_string(), eco_bytes);
        }
    }

    stats
}

// ---------------------------------------------------------------------------
// Cache prefetch planning
// ---------------------------------------------------------------------------

/// Result of a prefetch run.
#[derive(Debug, Serialize)]
pub struct PrefetchResult {
    pub packages_checked: usize,
    pub already_cached: usize,
    pub needed: usize,
    /// Keys that could not be fetched
    pub failed: Vec<String>,
    pub ecosystems: Vec<String>,
}

/// Plan which packages need to be fetched into CAS.
/// Returns the subset of `packages` that are not yet in CAS.
pub fn plan_prefetch<'a>(
    cas_root: &Path,
    packages: &'a [PkgRef],
) -> Vec<&'a PkgRef> {
    packages
        .iter()
        .filter(|pkg| !cas_has_package(cas_root, pkg))
        .collect()
}

// ---------------------------------------------------------------------------
// Offline install validation
// ---------------------------------------------------------------------------

/// Validate that all `packages` are available in CAS; return an error
/// listing missing packages if any are absent.
pub fn validate_offline_install(
    cas_root: &Path,
    packages: &[PkgRef],
) -> Result<(), OfflineError> {
    let avail = check_cas_availability(cas_root, packages);
    if avail.can_install_offline {
        Ok(())
    } else {
        Err(OfflineError::MissingPackages(avail.missing))
    }
}

#[derive(Debug)]
pub enum OfflineError {
    /// One or more packages not in CAS. Contains their "name@version" keys.
    MissingPackages(Vec<String>),
    /// I/O error accessing CAS
    Io(std::io::Error),
}

impl std::fmt::Display for OfflineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingPackages(pkgs) => {
                write!(
                    f,
                    "Offline install failed: {} package(s) not in CAS: {}",
                    pkgs.len(),
                    pkgs.join(", ")
                )
            }
            Self::Io(e) => write!(f, "CAS I/O error: {}", e),
        }
    }
}

/// Returns the default CAS root path (`~/.better/cas`).
pub fn default_cas_root() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".better").join("cas"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("USERPROFILE").ok().map(PathBuf::from))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_pkg(name: &str, version: &str, integrity: &str) -> PkgRef {
        PkgRef {
            name: name.to_string(),
            version: version.to_string(),
            integrity: integrity.to_string(),
            ecosystem: Ecosystem::Npm,
        }
    }

    fn write_file(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"fake data").unwrap();
    }

    #[test]
    fn all_missing_when_cas_empty() {
        let tmp = std::env::temp_dir().join("better-cas-test-empty");
        let pkgs = vec![make_pkg("lodash", "4.17.21", "sha512-abc")];
        let avail = check_cas_availability(&tmp, &pkgs);
        assert_eq!(avail.available, 0);
        assert_eq!(avail.missing_count, 1);
        assert!(!avail.can_install_offline);
    }

    #[test]
    fn integrity_file_hit() {
        let tmp = std::env::temp_dir().join("better-cas-test-hit");
        let cas_file = tmp.join("npm").join("sha512-abc_def");
        write_file(&cas_file);
        let pkgs = vec![make_pkg("lodash", "4.17.21", "sha512-abc/def")];
        let avail = check_cas_availability(&tmp, &pkgs);
        assert_eq!(avail.available, 1);
        assert!(avail.can_install_offline);
        // cleanup
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_offline_errors_on_missing() {
        let tmp = std::env::temp_dir().join("better-cas-test-validate");
        let pkgs = vec![make_pkg("missing-pkg", "1.0.0", "sha512-nope")];
        let result = validate_offline_install(&tmp, &pkgs);
        assert!(matches!(result, Err(OfflineError::MissingPackages(_))));
    }

    #[test]
    fn plan_prefetch_filters_cached() {
        let tmp = std::env::temp_dir().join("better-cas-test-plan");
        // Pre-cache one package
        let cas_file = tmp.join("npm").join("sha512-cached");
        write_file(&cas_file);

        let pkgs = vec![
            make_pkg("cached-pkg", "1.0.0", "sha512-cached"),
            make_pkg("new-pkg", "2.0.0", "sha512-new"),
        ];
        let needed = plan_prefetch(&tmp, &pkgs);
        assert_eq!(needed.len(), 1);
        assert_eq!(needed[0].name, "new-pkg");
        let _ = fs::remove_dir_all(&tmp);
    }
}
