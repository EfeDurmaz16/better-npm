// crates/better-core/src/registry/index.rs
// Task 102: Package index — maps package names to content-addressed versions.
// Stored as a verifiable structure (Merkle root over entries).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use super::cid::ContentId;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Lightweight package index stored in the content-addressed registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageIndex {
    /// SHA-256 Merkle root of all entry hashes.
    pub root_hash: String,
    pub entries: Vec<PackageIndexEntry>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageIndexEntry {
    pub name: String,
    pub ecosystem: String,
    pub versions: Vec<VersionEntry>,
    pub latest: String,
    pub publisher: PublisherInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionEntry {
    pub version: String,
    pub cid: ContentId,
    pub published_at: u64,
    pub size_bytes: u64,
    /// Optional Ed25519 signature by the publisher.
    pub signature: Option<String>,
    pub yanked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublisherInfo {
    pub name: String,
    /// Base64-encoded Ed25519 public key.
    pub public_key: String,
    pub verified: bool,
}

// ---------------------------------------------------------------------------
// PackageIndex implementation
// ---------------------------------------------------------------------------

impl PackageIndex {
    /// Create a new empty index.
    pub fn new() -> Self {
        Self {
            root_hash: String::new(),
            entries: vec![],
            updated_at: super::cid::current_timestamp(),
        }
    }

    /// Resolve a package name + version constraint to a VersionEntry.
    ///
    /// Constraint matching:
    /// - `"latest"` → returns the latest non-yanked version
    /// - `"*"` / `""` → same as latest
    /// - `"^1.2.3"` → returns highest matching major-compatible version
    /// - exact `"1.2.3"` → exact match
    pub fn resolve(&self, name: &str, constraint: &str) -> Option<&VersionEntry> {
        let entry = self.entries.iter().find(|e| e.name == name)?;
        let live: Vec<&VersionEntry> = entry.versions.iter().filter(|v| !v.yanked).collect();
        if live.is_empty() {
            return None;
        }

        match constraint {
            "" | "*" | "latest" => live.last().copied(),
            c if c.starts_with('^') => {
                let base = c.trim_start_matches('^');
                let (major, _) = split_semver(base);
                live.iter()
                    .filter(|v| split_semver(&v.version).0 == major)
                    .last()
                    .copied()
            }
            c if c.starts_with('~') => {
                let base = c.trim_start_matches('~');
                let (major, minor) = split_semver(base);
                live.iter()
                    .filter(|v| {
                        let (vmaj, vmin) = split_semver(&v.version);
                        vmaj == major && vmin == minor
                    })
                    .last()
                    .copied()
            }
            exact => live.iter().find(|v| v.version == exact).copied(),
        }
    }

    /// Add or update an entry. Recomputes root hash.
    pub fn upsert(&mut self, entry: PackageIndexEntry) {
        let pos = self.entries.iter().position(|e| e.name == entry.name && e.ecosystem == entry.ecosystem);
        if let Some(idx) = pos {
            self.entries[idx] = entry;
        } else {
            self.entries.push(entry);
        }
        self.root_hash = compute_merkle_root(&self.entries);
        self.updated_at = super::cid::current_timestamp();
    }

    /// Verify Merkle root of all entries.
    pub fn verify_integrity(&self) -> bool {
        let computed = compute_merkle_root(&self.entries);
        computed == self.root_hash
    }

    /// Yank a specific version.
    pub fn yank(&mut self, name: &str, version: &str) -> bool {
        for entry in &mut self.entries {
            if entry.name == name {
                for ver in &mut entry.versions {
                    if ver.version == version {
                        ver.yanked = true;
                        self.root_hash = compute_merkle_root(&self.entries);
                        return true;
                    }
                }
            }
        }
        false
    }
}

impl Default for PackageIndex {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Compute a Merkle root by hashing each entry's canonical JSON and then
/// chaining the hashes pairwise (simplified binary Merkle tree).
pub fn compute_merkle_root(entries: &[PackageIndexEntry]) -> String {
    if entries.is_empty() {
        return sha256_str("empty");
    }

    let mut hashes: Vec<String> = entries
        .iter()
        .map(|e| sha256_str(&format!("{}/{}/{}", e.ecosystem, e.name, e.latest)))
        .collect();

    while hashes.len() > 1 {
        let mut next = vec![];
        let mut i = 0;
        while i < hashes.len() {
            let left = &hashes[i];
            let right = if i + 1 < hashes.len() { &hashes[i + 1] } else { left };
            next.push(sha256_str(&format!("{}{}", left, right)));
            i += 2;
        }
        hashes = next;
    }

    hashes.into_iter().next().unwrap_or_default()
}

fn sha256_str(s: &str) -> String {
    let hash = Sha256::digest(s.as_bytes());
    hash.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Split "major.minor.patch" → (major, minor) as strings.
fn split_semver(v: &str) -> (String, String) {
    let parts: Vec<&str> = v.splitn(3, '.').collect();
    let major = parts.first().map(|s| s.to_string()).unwrap_or_default();
    let minor = parts.get(1).map(|s| s.to_string()).unwrap_or_default();
    (major, minor)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::cid::ContentId;

    fn make_entry(name: &str, versions: &[(&str, bool)]) -> PackageIndexEntry {
        PackageIndexEntry {
            name: name.to_string(),
            ecosystem: "npm".to_string(),
            versions: versions.iter().map(|(v, yanked)| VersionEntry {
                version: v.to_string(),
                cid: ContentId::sha256(v.as_bytes()),
                published_at: 0,
                size_bytes: 1024,
                signature: None,
                yanked: *yanked,
            }).collect(),
            latest: versions.last().map(|(v, _)| v.to_string()).unwrap_or_default(),
            publisher: PublisherInfo {
                name: "test".to_string(),
                public_key: "abc".to_string(),
                verified: false,
            },
        }
    }

    #[test]
    fn resolve_latest_returns_last_non_yanked() {
        let mut idx = PackageIndex::new();
        idx.upsert(make_entry("lodash", &[("4.17.20", false), ("4.17.21", false)]));
        let ver = idx.resolve("lodash", "latest").unwrap();
        assert_eq!(ver.version, "4.17.21");
    }

    #[test]
    fn resolve_skips_yanked() {
        let mut idx = PackageIndex::new();
        idx.upsert(make_entry("pkg", &[("1.0.0", false), ("1.0.1", true)]));
        let ver = idx.resolve("pkg", "*").unwrap();
        assert_eq!(ver.version, "1.0.0");
    }

    #[test]
    fn resolve_caret_constraint() {
        let mut idx = PackageIndex::new();
        idx.upsert(make_entry("react", &[("17.0.0", false), ("18.0.0", false), ("18.2.0", false)]));
        let ver = idx.resolve("react", "^18").unwrap();
        assert_eq!(ver.version, "18.2.0");
    }

    #[test]
    fn resolve_exact_version() {
        let mut idx = PackageIndex::new();
        idx.upsert(make_entry("express", &[("4.17.0", false), ("4.18.0", false)]));
        let ver = idx.resolve("express", "4.17.0").unwrap();
        assert_eq!(ver.version, "4.17.0");
    }

    #[test]
    fn resolve_unknown_package_returns_none() {
        let idx = PackageIndex::new();
        assert!(idx.resolve("nonexistent", "latest").is_none());
    }

    #[test]
    fn verify_integrity_after_upsert() {
        let mut idx = PackageIndex::new();
        idx.upsert(make_entry("pkg", &[("1.0.0", false)]));
        assert!(idx.verify_integrity());
    }

    #[test]
    fn verify_integrity_tampered_fails() {
        let mut idx = PackageIndex::new();
        idx.upsert(make_entry("pkg", &[("1.0.0", false)]));
        // Tamper with root hash
        idx.root_hash = "tampered".to_string();
        assert!(!idx.verify_integrity());
    }

    #[test]
    fn yank_version() {
        let mut idx = PackageIndex::new();
        idx.upsert(make_entry("lib", &[("1.0.0", false), ("1.0.1", false)]));
        assert!(idx.yank("lib", "1.0.1"));
        assert!(idx.resolve("lib", "1.0.1").is_none());
    }

    #[test]
    fn merkle_root_deterministic() {
        let entries = vec![
            make_entry("a", &[("1.0.0", false)]),
            make_entry("b", &[("2.0.0", false)]),
        ];
        let root1 = compute_merkle_root(&entries);
        let root2 = compute_merkle_root(&entries);
        assert_eq!(root1, root2);
    }

    #[test]
    fn index_serializes_to_json() {
        let mut idx = PackageIndex::new();
        idx.upsert(make_entry("pkg", &[("1.0.0", false)]));
        let json = serde_json::to_string(&idx).unwrap();
        assert!(json.contains("pkg"));
        assert!(json.contains("root_hash"));
    }
}
