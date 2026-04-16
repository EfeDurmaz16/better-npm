// crates/better-core/src/lazy.rs
// Lazy node_modules: resolve + fetch to CAS but skip materialisation.
// Writes a .better-lazy.json manifest so tools can query package locations
// without a full node_modules tree on disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::types::ResolvedPackage;
use crate::fetch::unpacked_path;
use crate::types::CasLayout;

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/// Written to `<project_root>/.better-lazy.json` when `--lazy` is used.
#[derive(Debug, Serialize, Deserialize)]
pub struct LazyManifest {
    pub version: u32,
    pub created_at: String,
    pub cache_root: String,
    pub packages: Vec<LazyPackageEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LazyPackageEntry {
    /// Package name (e.g. "lodash")
    pub name: String,
    /// Resolved version string
    pub version: String,
    /// Relative path under project root (e.g. "node_modules/lodash")
    pub rel_path: String,
    /// Absolute path to the unpacked package in CAS
    pub cas_path: String,
    /// ssri integrity string (sha512-...)
    pub integrity: String,
    /// Whether the package has lifecycle scripts (best-effort; false if unknown)
    pub has_scripts: bool,
    /// Bin entries: { bin_name -> rel_path_in_package }
    pub bin: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Produce a simple ISO-8601-like timestamp without pulling in `chrono`.
fn iso_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Produce YYYY-MM-DDTHH:MM:SSZ by integer arithmetic
    let mut s = secs;
    let sec = s % 60; s /= 60;
    let min = s % 60; s /= 60;
    let hour = s % 24; s /= 24;
    // Days since epoch → calendar date (Gregorian, good enough for tooling)
    let (year, month, day) = epoch_days_to_date(s);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, hour, min, sec)
}

fn epoch_days_to_date(mut days: u64) -> (u64, u64, u64) {
    // Rata Die algorithm (approximate, handles 1970–2200)
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Derive the CAS unpacked path for a package given its integrity string.
fn cas_path_for_pkg(integrity: &str, cache_root: &Path) -> PathBuf {
    // Parse algo/hex from ssri format "sha512-<base64>"
    let layout = CasLayout {
        tarballs_dir: cache_root.join("tarballs"),
        unpacked_dir: cache_root.join("unpacked"),
        tmp_dir: cache_root.join("tmp"),
    };
    if let Some(rest) = integrity.strip_prefix("sha512-") {
        // base64 → hex
        use sha2::{Digest, Sha256};
        // We use the integrity string itself as a stable key (sha256 of it)
        let mut h = Sha256::new();
        h.update(rest.as_bytes());
        let hex = format!("{:x}", h.finalize());
        unpacked_path(&layout, "sha512", &hex)
    } else if let Some(rest) = integrity.strip_prefix("sha1-") {
        let layout2 = CasLayout {
            tarballs_dir: cache_root.join("tarballs"),
            unpacked_dir: cache_root.join("unpacked"),
            tmp_dir: cache_root.join("tmp"),
        };
        unpacked_path(&layout2, "sha1", rest)
    } else {
        // Fallback: derive from integrity string hash
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(integrity.as_bytes());
        let hex = format!("{:x}", h.finalize());
        unpacked_path(&layout, "sha512", &hex)
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Write a `.better-lazy.json` manifest for the given resolved packages.
///
/// Returns the path to the written manifest.
pub fn write_lazy_manifest(
    project_root: &Path,
    packages: &[ResolvedPackage],
    cache_root: &Path,
) -> Result<PathBuf, String> {
    let manifest_path = project_root.join(".better-lazy.json");

    let entries: Vec<LazyPackageEntry> = packages
        .iter()
        .map(|pkg| {
            let cas_path = cas_path_for_pkg(&pkg.integrity, cache_root);
            LazyPackageEntry {
                name: pkg.name.clone(),
                version: pkg.version.clone(),
                rel_path: pkg.rel_path.clone(),
                cas_path: cas_path.to_string_lossy().into_owned(),
                integrity: pkg.integrity.clone(),
                has_scripts: false, // detect from CAS package.json in a future pass
                bin: HashMap::new(),
            }
        })
        .collect();

    let manifest = LazyManifest {
        version: 1,
        created_at: iso_timestamp(),
        cache_root: cache_root.to_string_lossy().into_owned(),
        packages: entries,
    };

    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("serialize lazy manifest: {}", e))?;
    std::fs::write(&manifest_path, json)
        .map_err(|e| format!("write lazy manifest: {}", e))?;

    Ok(manifest_path)
}

/// Read an existing `.better-lazy.json` manifest.
pub fn read_lazy_manifest(project_root: &Path) -> Result<LazyManifest, String> {
    let path = project_root.join(".better-lazy.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("read lazy manifest: {}", e))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("parse lazy manifest: {}", e))
}

/// Materialise a single package from lazy mode on demand.
///
/// Copies the package from its CAS location into `target_dir/<rel_path>`.
pub fn materialise_lazy_package(
    entry: &LazyPackageEntry,
    project_root: &Path,
) -> Result<(), String> {
    let target = project_root.join(&entry.rel_path);
    let src = Path::new(&entry.cas_path);
    if !src.exists() {
        return Err(format!(
            "lazy: CAS path not found for {} — run `better install` to re-fetch",
            entry.name
        ));
    }
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("lazy: create dir {}: {}", target.display(), e))?;
    if !crate::try_clonefile_dir(src, &target) {
        copy_dir(src, &target)
            .map_err(|e| format!("lazy: materialise {} failed: {}", entry.name, e))?;
    }
    Ok(())
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src)
        .map_err(|e| format!("readdir {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let dest_path = dst.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            std::fs::create_dir_all(&dest_path).map_err(|e| e.to_string())?;
            copy_dir(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path)
                .map(|_| ())
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_iso_timestamp_format() {
        let ts = iso_timestamp();
        // Should be YYYY-MM-DDTHH:MM:SSZ (20 chars)
        assert_eq!(ts.len(), 20, "timestamp: {}", ts);
        assert!(ts.ends_with('Z'));
        assert!(ts.contains('T'));
    }

    #[test]
    fn test_write_and_read_lazy_manifest() {
        let dir = std::env::temp_dir().join(format!("lazy_test_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let cache = dir.join("cache");
        fs::create_dir_all(&cache).unwrap();

        let pkgs = vec![
            crate::types::ResolvedPackage {
                name: "lodash".into(),
                version: "4.17.21".into(),
                rel_path: "node_modules/lodash".into(),
                resolved_url: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz".into(),
                integrity: "sha512-abc123".into(),
            },
        ];

        let manifest_path = write_lazy_manifest(&dir, &pkgs, &cache).unwrap();
        assert!(manifest_path.exists());

        let manifest = read_lazy_manifest(&dir).unwrap();
        assert_eq!(manifest.version, 1);
        assert_eq!(manifest.packages.len(), 1);
        assert_eq!(manifest.packages[0].name, "lodash");
        assert_eq!(manifest.packages[0].version, "4.17.21");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn test_lazy_manifest_json_structure() {
        let dir = std::env::temp_dir().join(format!("lazy_json_test_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let cache = dir.join("cache");
        fs::create_dir_all(&cache).unwrap();

        let pkgs: Vec<crate::types::ResolvedPackage> = vec![];
        write_lazy_manifest(&dir, &pkgs, &cache).unwrap();

        let content = fs::read_to_string(dir.join(".better-lazy.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(v["version"], 1);
        assert!(v["packages"].is_array());
        assert!(v["created_at"].as_str().unwrap().ends_with('Z'));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn test_epoch_days_to_date_unix_epoch() {
        // Day 0 = 1970-01-01
        let (y, m, d) = epoch_days_to_date(0);
        assert_eq!(y, 1970);
        assert_eq!(m, 1);
        assert_eq!(d, 1);
    }

    #[test]
    fn test_epoch_days_to_date_known_date() {
        // 2024-01-01 = 19723 days since epoch
        let (y, m, d) = epoch_days_to_date(19723);
        assert_eq!(y, 2024);
        assert_eq!(m, 1);
        assert_eq!(d, 1);
    }

    #[test]
    fn test_lazy_package_entry_serde_roundtrip() {
        let entry = LazyPackageEntry {
            name: "lodash".into(),
            version: "4.17.21".into(),
            rel_path: "node_modules/lodash".into(),
            cas_path: "/cache/unpacked/sha512/abc123/package".into(),
            integrity: "sha512-abc123".into(),
            has_scripts: false,
            bin: HashMap::new(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        let back: LazyPackageEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "lodash");
        assert_eq!(back.version, "4.17.21");
        assert!(!back.has_scripts);
    }

    #[test]
    fn test_cas_path_for_pkg_sha512() {
        let cache = std::path::Path::new("/cache");
        let path = cas_path_for_pkg("sha512-somebase64hash==", cache);
        // Should be under /cache/unpacked/sha512/
        assert!(path.to_string_lossy().contains("unpacked"));
        assert!(path.to_string_lossy().contains("sha512"));
    }

    #[test]
    fn test_cas_path_for_pkg_sha1() {
        let cache = std::path::Path::new("/cache");
        let path = cas_path_for_pkg("sha1-abc123", cache);
        assert!(path.to_string_lossy().contains("sha1"));
    }

    #[test]
    fn test_read_lazy_manifest_missing_file_returns_err() {
        let result = read_lazy_manifest(std::path::Path::new("/nonexistent-lazy-dir"));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("read lazy manifest"));
    }
}
