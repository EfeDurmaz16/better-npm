// crates/better-core/src/diff.rs
//
// Dependency diff between two snapshots (v1.2 Task 100).
//
// `better diff HEAD~1` computes added / removed / updated packages and
// provides a SecurityImpact summary.  The caller is responsible for
// loading the two lockfile snapshots into `HashMap<String, (String, String)>`
// (name → (version, ecosystem)).

use std::collections::HashMap;

use serde::Serialize;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DepDiff {
    pub added: Vec<DepChange>,
    pub removed: Vec<DepChange>,
    pub updated: Vec<DepUpdate>,
    pub unchanged: usize,
    pub security_impact: SecurityImpact,
}

#[derive(Debug, Clone, Serialize)]
pub struct DepChange {
    pub name: String,
    pub version: String,
    pub ecosystem: String,
    pub license: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DepUpdate {
    pub name: String,
    pub from_version: String,
    pub to_version: String,
    pub ecosystem: String,
    pub change_type: UpdateType,
    pub new_vulns: Vec<String>,
    pub fixed_vulns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateType {
    Major,
    Minor,
    Patch,
    PreRelease,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecurityImpact {
    pub new_vulnerabilities: usize,
    pub fixed_vulnerabilities: usize,
    pub new_high_risk_packages: Vec<String>,
    pub removed_maintainers: Vec<String>,
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/// Compute diff between two dependency snapshots.
///
/// `before` / `after`: `name → (version, ecosystem)`.
///
/// Returns a `DepDiff` with added, removed, updated, and unchanged counts,
/// plus a `SecurityImpact` summary (vuln counts are filled in by the caller;
/// here they default to 0 since we don't have OSV data).
pub fn compute_dep_diff(
    before: &HashMap<String, (String, String)>,
    after: &HashMap<String, (String, String)>,
) -> DepDiff {
    let mut added: Vec<DepChange> = Vec::new();
    let mut removed: Vec<DepChange> = Vec::new();
    let mut updated: Vec<DepUpdate> = Vec::new();
    let mut unchanged = 0usize;

    // Packages in `after`
    for (name, (after_ver, eco)) in after {
        match before.get(name) {
            None => {
                // New package
                added.push(DepChange {
                    name: name.clone(),
                    version: after_ver.clone(),
                    ecosystem: eco.clone(),
                    license: String::new(),
                    size_bytes: 0,
                });
            }
            Some((before_ver, _)) if before_ver != after_ver => {
                // Version changed
                updated.push(DepUpdate {
                    name: name.clone(),
                    from_version: before_ver.clone(),
                    to_version: after_ver.clone(),
                    ecosystem: eco.clone(),
                    change_type: classify_update(before_ver, after_ver),
                    new_vulns: vec![],
                    fixed_vulns: vec![],
                });
            }
            _ => {
                unchanged += 1;
            }
        }
    }

    // Packages in `before` but not in `after` (removed)
    for (name, (ver, eco)) in before {
        if !after.contains_key(name) {
            removed.push(DepChange {
                name: name.clone(),
                version: ver.clone(),
                ecosystem: eco.clone(),
                license: String::new(),
                size_bytes: 0,
            });
        }
    }

    // Sort for deterministic output
    added.sort_by(|a, b| a.name.cmp(&b.name));
    removed.sort_by(|a, b| a.name.cmp(&b.name));
    updated.sort_by(|a, b| a.name.cmp(&b.name));

    DepDiff {
        added,
        removed,
        updated,
        unchanged,
        security_impact: SecurityImpact {
            new_vulnerabilities: 0,
            fixed_vulnerabilities: 0,
            new_high_risk_packages: vec![],
            removed_maintainers: vec![],
        },
    }
}

// ---------------------------------------------------------------------------
// Version classifier (no external crate)
// ---------------------------------------------------------------------------

fn classify_update(from: &str, to: &str) -> UpdateType {
    let from_parts = parse_ver(from);
    let to_parts   = parse_ver(to);

    if from_parts.is_none() || to_parts.is_none() {
        return UpdateType::PreRelease;
    }
    let (fm, fmin, fp) = from_parts.unwrap();
    let (tm, tmin, tp) = to_parts.unwrap();

    if tm > fm { UpdateType::Major }
    else if tmin > fmin { UpdateType::Minor }
    else if tp > fp { UpdateType::Patch }
    else { UpdateType::PreRelease }
}

/// Parse `major.minor.patch` into a `(u64, u64, u64)` tuple.
fn parse_ver(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim_start_matches(|c: char| !c.is_ascii_digit());
    // Strip pre-release suffix (e.g. "1.2.3-alpha")
    let base = v.split('-').next().unwrap_or(v);
    let parts: Vec<&str> = base.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    let major = parts[0].parse::<u64>().ok()?;
    let minor = parts[1].parse::<u64>().ok()?;
    let patch = parts[2].parse::<u64>().ok()?;
    Some((major, minor, patch))
}

/// Parse a simple `package-lock.json` v3 into a dependency snapshot.
///
/// Returns a `HashMap<name, (version, "npm")>` for the `packages` map.
pub fn parse_lock_snapshot(lock_json: &str) -> HashMap<String, (String, String)> {
    let mut result = HashMap::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(lock_json) else {
        return result;
    };
    let Some(pkgs) = v.get("packages").and_then(|p| p.as_object()) else {
        return result;
    };
    for (path, info) in pkgs {
        if path.is_empty() { continue; } // root entry
        let name = if path.starts_with("node_modules/") {
            path[13..].to_string()
        } else {
            path.clone()
        };
        let version = info.get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !version.is_empty() {
            result.insert(name, (version, "npm".to_string()));
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(entries: &[(&str, &str, &str)]) -> HashMap<String, (String, String)> {
        entries.iter().map(|(n, v, e)| {
            (n.to_string(), (v.to_string(), e.to_string()))
        }).collect()
    }

    #[test]
    fn added_detected() {
        let before = snap(&[("express", "4.18.0", "npm")]);
        let after  = snap(&[("express", "4.18.0", "npm"), ("lodash", "4.17.21", "npm")]);
        let diff = compute_dep_diff(&before, &after);
        assert_eq!(diff.added.len(), 1);
        assert_eq!(diff.added[0].name, "lodash");
        assert_eq!(diff.removed.len(), 0);
    }

    #[test]
    fn removed_detected() {
        let before = snap(&[("express", "4.18.0", "npm"), ("moment", "2.29.4", "npm")]);
        let after  = snap(&[("express", "4.18.0", "npm")]);
        let diff = compute_dep_diff(&before, &after);
        assert_eq!(diff.removed.len(), 1);
        assert_eq!(diff.removed[0].name, "moment");
    }

    #[test]
    fn updated_classified_correctly() {
        let before = snap(&[
            ("a", "1.0.0", "npm"),
            ("b", "1.2.0", "npm"),
            ("c", "1.2.3", "npm"),
        ]);
        let after = snap(&[
            ("a", "2.0.0", "npm"),  // major
            ("b", "1.3.0", "npm"),  // minor
            ("c", "1.2.4", "npm"),  // patch
        ]);
        let diff = compute_dep_diff(&before, &after);
        assert_eq!(diff.updated.len(), 3);
        let a = diff.updated.iter().find(|u| u.name == "a").unwrap();
        assert_eq!(a.change_type, UpdateType::Major);
        let b = diff.updated.iter().find(|u| u.name == "b").unwrap();
        assert_eq!(b.change_type, UpdateType::Minor);
        let c = diff.updated.iter().find(|u| u.name == "c").unwrap();
        assert_eq!(c.change_type, UpdateType::Patch);
    }

    #[test]
    fn unchanged_counted() {
        let before = snap(&[("a", "1.0.0", "npm"), ("b", "2.0.0", "npm")]);
        let after  = snap(&[("a", "1.0.0", "npm"), ("b", "2.0.0", "npm")]);
        let diff = compute_dep_diff(&before, &after);
        assert_eq!(diff.unchanged, 2);
        assert!(diff.added.is_empty());
        assert!(diff.removed.is_empty());
        assert!(diff.updated.is_empty());
    }

    #[test]
    fn classify_update_fn() {
        assert_eq!(classify_update("1.0.0", "2.0.0"), UpdateType::Major);
        assert_eq!(classify_update("1.0.0", "1.1.0"), UpdateType::Minor);
        assert_eq!(classify_update("1.0.0", "1.0.1"), UpdateType::Patch);
        assert_eq!(classify_update("1.0.0-alpha", "1.0.0-beta"), UpdateType::PreRelease);
    }

    #[test]
    fn parse_lock_snapshot_extracts_packages() {
        let lock = r#"{
            "lockfileVersion": 3,
            "packages": {
                "": { "name": "myapp" },
                "node_modules/express": { "version": "4.18.2" },
                "node_modules/lodash": { "version": "4.17.21" }
            }
        }"#;
        let snap = parse_lock_snapshot(lock);
        assert_eq!(snap.get("express").unwrap().0, "4.18.2");
        assert_eq!(snap.get("lodash").unwrap().0, "4.17.21");
        assert!(!snap.contains_key(""));
    }

    #[test]
    fn empty_snapshots_produce_empty_diff() {
        let diff = compute_dep_diff(&HashMap::new(), &HashMap::new());
        assert!(diff.added.is_empty());
        assert!(diff.removed.is_empty());
        assert!(diff.updated.is_empty());
        assert_eq!(diff.unchanged, 0);
    }
}
