// crates/better-core/src/delta.rs
//
// Delta update engine (v0.6 DX feature #26).
//
// On `better install` after a lockfile change, diff the current lockfile
// against a stored snapshot and only re-fetch/re-materialise packages whose
// resolved version or integrity changed.  Unchanged packages get a fast-path
// inode check.  For large monorepos this skips 90%+ of work on a typical
// single-dep update.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

/// A point-in-time snapshot of a resolved lockfile.
/// Stored as `<project>/.better/lockfile-snapshot.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LockSnapshot {
    /// Lockfile hash (sha256 of raw lock content) when this snapshot was saved.
    pub lockfile_hash: String,
    /// Package entries: key = "name@version"
    pub packages: HashMap<String, SnapshotEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotEntry {
    pub version: String,
    pub integrity: String,
    pub resolved: String,
}

// ---------------------------------------------------------------------------
// Delta diff
// ---------------------------------------------------------------------------

/// The kind of change between two snapshots.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeltaKind {
    /// Package not present in base; newly added.
    Added,
    /// Package present in base but not in head; removed.
    Removed,
    /// Package present in both but version/integrity changed.
    Updated,
    /// Package present in both and identical.
    Unchanged,
}

/// A single entry in a delta report.
#[derive(Debug, Clone, Serialize)]
pub struct DeltaEntry {
    pub name: String,
    pub kind: DeltaKind,
    pub old_version: Option<String>,
    pub new_version: Option<String>,
    pub old_integrity: Option<String>,
    pub new_integrity: Option<String>,
}

/// Full delta between two snapshots.
#[derive(Debug, Default, Serialize)]
pub struct LockDelta {
    pub added: Vec<DeltaEntry>,
    pub removed: Vec<DeltaEntry>,
    pub updated: Vec<DeltaEntry>,
    pub unchanged_count: usize,
    pub total_packages: usize,
}

impl LockDelta {
    /// Returns `true` if there are no changes at all.
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.updated.is_empty()
    }

    /// Names of packages that need (re-)fetching/materialising.
    pub fn packages_needing_work(&self) -> Vec<&str> {
        let mut names = Vec::new();
        for e in &self.added { names.push(e.name.as_str()); }
        for e in &self.updated { names.push(e.name.as_str()); }
        names
    }
}

/// Compute the delta between a `base` snapshot and a `head` snapshot.
pub fn diff_snapshots(base: &LockSnapshot, head: &LockSnapshot) -> LockDelta {
    let mut delta = LockDelta::default();

    // Find added and updated
    for (key, head_entry) in &head.packages {
        match base.packages.get(key) {
            None => {
                delta.added.push(DeltaEntry {
                    name: key.clone(),
                    kind: DeltaKind::Added,
                    old_version: None,
                    new_version: Some(head_entry.version.clone()),
                    old_integrity: None,
                    new_integrity: Some(head_entry.integrity.clone()),
                });
            }
            Some(base_entry) => {
                if base_entry.version != head_entry.version
                    || base_entry.integrity != head_entry.integrity
                {
                    delta.updated.push(DeltaEntry {
                        name: key.clone(),
                        kind: DeltaKind::Updated,
                        old_version: Some(base_entry.version.clone()),
                        new_version: Some(head_entry.version.clone()),
                        old_integrity: Some(base_entry.integrity.clone()),
                        new_integrity: Some(head_entry.integrity.clone()),
                    });
                } else {
                    delta.unchanged_count += 1;
                }
            }
        }
    }

    // Find removed
    for (key, base_entry) in &base.packages {
        if !head.packages.contains_key(key) {
            delta.removed.push(DeltaEntry {
                name: key.clone(),
                kind: DeltaKind::Removed,
                old_version: Some(base_entry.version.clone()),
                new_version: None,
                old_integrity: Some(base_entry.integrity.clone()),
                new_integrity: None,
            });
        }
    }

    delta.total_packages = head.packages.len();
    delta
}

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

/// Path of the snapshot file for a given project root.
pub fn snapshot_path(project_root: &Path) -> PathBuf {
    project_root
        .join(".better")
        .join("lockfile-snapshot.json")
}

/// Load the snapshot for `project_root`, or return an empty one.
pub fn load_snapshot(project_root: &Path) -> LockSnapshot {
    let path = snapshot_path(project_root);
    if !path.exists() {
        return LockSnapshot::default();
    }
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => LockSnapshot::default(),
    }
}

/// Persist `snapshot` for `project_root`.
pub fn save_snapshot(project_root: &Path, snapshot: &LockSnapshot) -> Result<(), String> {
    let path = snapshot_path(project_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(snapshot)
        .map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Build a snapshot from a map of `name@version` → (version, integrity, resolved).
pub fn build_snapshot(
    lockfile_hash: &str,
    packages: &HashMap<String, (String, String, String)>,
) -> LockSnapshot {
    LockSnapshot {
        lockfile_hash: lockfile_hash.to_string(),
        packages: packages
            .iter()
            .map(|(key, (ver, integrity, resolved))| {
                (
                    key.clone(),
                    SnapshotEntry {
                        version: ver.clone(),
                        integrity: integrity.clone(),
                        resolved: resolved.clone(),
                    },
                )
            })
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// Fast-path inode check
// ---------------------------------------------------------------------------

/// Verify that `package_dir` in `node_modules` still hard-links to the
/// expected CAS entry (same inode as `cas_path`).
/// Returns `true` if the inode matches → package does not need re-linking.
#[cfg(unix)]
pub fn inode_matches(cas_path: &Path, package_dir: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let check_file = package_dir.join("package.json");
    if !check_file.exists() || !cas_path.exists() {
        return false;
    }
    let cas_meta = match fs::metadata(cas_path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    let pkg_meta = match fs::metadata(&check_file) {
        Ok(m) => m,
        Err(_) => return false,
    };
    // Same inode on same device → hardlinked to the same CAS entry
    cas_meta.dev() == pkg_meta.dev() && cas_meta.ino() == pkg_meta.ino()
}

#[cfg(not(unix))]
pub fn inode_matches(_cas_path: &Path, _package_dir: &Path) -> bool {
    false
}

// ---------------------------------------------------------------------------
// Workspace topology cache (DX feature #27)
// ---------------------------------------------------------------------------

/// Cached workspace DAG entry — one per workspace package.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTopoEntry {
    pub name: String,
    pub path: String,
    pub version: String,
    /// Names of workspace packages this one depends on
    pub local_deps: Vec<String>,
    /// mtime of its package.json when this entry was cached
    pub pkg_json_mtime: u64,
}

/// The full workspace topology cache.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkspaceTopoCache {
    /// Hash of project root path (for cache file naming)
    pub project_hash: String,
    /// Unix mtime of the root package.json
    pub root_mtime: u64,
    pub packages: Vec<WorkspaceTopoEntry>,
}

impl WorkspaceTopoCache {
    pub fn cache_path(cache_dir: &Path, project_hash: &str) -> PathBuf {
        cache_dir
            .join("workspace-topo")
            .join(format!("{}.json", project_hash))
    }

    pub fn load(cache_dir: &Path, project_hash: &str) -> Option<Self> {
        let path = Self::cache_path(cache_dir, project_hash);
        let s = fs::read_to_string(&path).ok()?;
        serde_json::from_str(&s).ok()
    }

    pub fn save(&self, cache_dir: &Path) -> Result<(), String> {
        let path = Self::cache_path(cache_dir, &self.project_hash);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())
    }

    /// Check if the cache is still valid by comparing mtime of the root package.json.
    pub fn is_valid(&self, project_root: &Path) -> bool {
        let root_pkg = project_root.join("package.json");
        match fs::metadata(&root_pkg) {
            Ok(m) => {
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| {
                        t.duration_since(std::time::UNIX_EPOCH).ok()
                    })
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                mtime == self.root_mtime
            }
            Err(_) => false,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(pkgs: &[(&str, &str, &str)]) -> LockSnapshot {
        let packages = pkgs
            .iter()
            .map(|(key, ver, int)| {
                (
                    key.to_string(),
                    SnapshotEntry {
                        version: ver.to_string(),
                        integrity: int.to_string(),
                        resolved: String::new(),
                    },
                )
            })
            .collect();
        LockSnapshot { lockfile_hash: "abc".to_string(), packages }
    }

    #[test]
    fn no_changes_produces_empty_delta() {
        let s = snap(&[("lodash@4.17.21", "4.17.21", "sha512-xxx")]);
        let delta = diff_snapshots(&s, &s);
        assert!(delta.is_empty());
        assert_eq!(delta.unchanged_count, 1);
    }

    #[test]
    fn added_package_detected() {
        let base = snap(&[]);
        let head = snap(&[("lodash@4.17.21", "4.17.21", "sha512-xxx")]);
        let delta = diff_snapshots(&base, &head);
        assert_eq!(delta.added.len(), 1);
        assert_eq!(delta.added[0].name, "lodash@4.17.21");
        assert!(delta.packages_needing_work().contains(&"lodash@4.17.21"));
    }

    #[test]
    fn removed_package_detected() {
        let base = snap(&[("lodash@4.17.21", "4.17.21", "sha512-xxx")]);
        let head = snap(&[]);
        let delta = diff_snapshots(&base, &head);
        assert_eq!(delta.removed.len(), 1);
    }

    #[test]
    fn updated_package_detected() {
        let base = snap(&[("lodash@4.17.20", "4.17.20", "sha512-old")]);
        let head = snap(&[("lodash@4.17.20", "4.17.21", "sha512-new")]);
        let delta = diff_snapshots(&base, &head);
        assert_eq!(delta.updated.len(), 1);
        assert_eq!(delta.updated[0].new_version.as_deref(), Some("4.17.21"));
    }

    #[test]
    fn mixed_delta_counts() {
        let base = snap(&[
            ("a@1.0.0", "1.0.0", "sha512-a"),
            ("b@1.0.0", "1.0.0", "sha512-b"),
        ]);
        let head = snap(&[
            ("a@1.0.0", "1.0.0", "sha512-a"),  // unchanged
            ("c@1.0.0", "1.0.0", "sha512-c"),  // added
        ]);
        let delta = diff_snapshots(&base, &head);
        assert_eq!(delta.added.len(), 1);
        assert_eq!(delta.removed.len(), 1);
        assert_eq!(delta.unchanged_count, 1);
    }

    #[test]
    fn build_snapshot_from_package_map() {
        let mut packages = HashMap::new();
        packages.insert(
            "react@18.0.0".to_string(),
            ("18.0.0".to_string(), "sha512-react".to_string(), "https://r.npmjs.com/react".to_string()),
        );
        let snap = build_snapshot("deadbeef", &packages);
        assert_eq!(snap.lockfile_hash, "deadbeef");
        assert_eq!(snap.packages.len(), 1);
        assert_eq!(snap.packages["react@18.0.0"].version, "18.0.0");
    }

    #[test]
    fn packages_needing_work_includes_updated_and_added() {
        let base = snap(&[("a@1.0.0", "1.0.0", "sha-a")]);
        let head = snap(&[
            ("a@1.0.0", "1.0.1", "sha-a-new"), // updated
            ("b@1.0.0", "1.0.0", "sha-b"),      // added
        ]);
        let delta = diff_snapshots(&base, &head);
        let work = delta.packages_needing_work();
        assert!(work.contains(&"a@1.0.0"));
        assert!(work.contains(&"b@1.0.0"));
    }

    #[test]
    fn integrity_change_detected_as_update() {
        let base = snap(&[("pkg@1.0.0", "1.0.0", "sha512-old")]);
        let head = snap(&[("pkg@1.0.0", "1.0.0", "sha512-new")]);
        let delta = diff_snapshots(&base, &head);
        assert_eq!(delta.updated.len(), 1);
        assert!(delta.updated[0].new_integrity.is_some());
    }
}
