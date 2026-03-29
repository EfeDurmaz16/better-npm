use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::lockfile::{LockPackage, LockfileWriter, LockfileWriteResult};

/// A parsed better.lock.json sidecar for merge operations.
#[derive(Debug, Clone)]
pub struct LockSidecar {
    pub version: u64,
    pub packages: BTreeMap<String, SidecarPackage>, // key = "name@version"
}

/// A single package from the JSON sidecar.
#[derive(Debug, Clone)]
pub struct SidecarPackage {
    pub name: String,
    pub version: String,
    pub resolved: String,
    pub integrity: String,
    pub dependencies: BTreeMap<String, String>, // dep_name -> version_range
}

/// Result of a three-way merge operation.
#[derive(Debug)]
pub struct LockMergeResult {
    pub ok: bool,
    pub added: Vec<String>,     // packages added (present in theirs but not base)
    pub removed: Vec<String>,   // packages removed (present in base but not ours+theirs)
    pub conflicts: Vec<String>, // packages where ours and theirs both changed differently
    pub total_packages: u32,
    pub write_result: Option<LockfileWriteResult>,
}

/// Parse a better.lock.json sidecar file into a LockSidecar.
pub fn parse_lock_sidecar(path: &Path) -> Result<LockSidecar, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    parse_lock_sidecar_str(&content)
}

/// Parse a better.lock.json sidecar from a string.
pub fn parse_lock_sidecar_str(json: &str) -> Result<LockSidecar, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("Invalid JSON in lock sidecar: {}", e))?;

    let version = value.get("version")
        .and_then(|v| v.as_u64())
        .unwrap_or(1);

    let packages_obj = value.get("packages")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "Missing 'packages' object in lock sidecar".to_string())?;

    let mut packages = BTreeMap::new();

    for (key, pkg_val) in packages_obj {
        let pkg_obj = pkg_val.as_object()
            .ok_or_else(|| format!("Package '{}' is not an object", key))?;

        let pkg_version = pkg_obj.get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let resolved = pkg_obj.get("resolved")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let integrity = pkg_obj.get("integrity")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Extract name from key "name@version"
        let name = if let Some(at_pos) = key.rfind('@') {
            if at_pos > 0 { key[..at_pos].to_string() } else { key.clone() }
        } else {
            key.clone()
        };

        let mut dependencies = BTreeMap::new();
        if let Some(deps_obj) = pkg_obj.get("dependencies").and_then(|v| v.as_object()) {
            for (dep_name, dep_ver) in deps_obj {
                if let Some(ver_str) = dep_ver.as_str() {
                    dependencies.insert(dep_name.clone(), ver_str.to_string());
                }
            }
        }

        packages.insert(key.clone(), SidecarPackage {
            name,
            version: pkg_version,
            resolved,
            integrity,
            dependencies,
        });
    }

    Ok(LockSidecar { version, packages })
}

/// Perform a three-way merge of better.lock.json sidecars.
///
/// Strategy:
/// - Packages in ours but not base = added by ours (keep)
/// - Packages in theirs but not base = added by theirs (keep)
/// - Packages in base but not ours = removed by ours (remove)
/// - Packages in base but not theirs = removed by theirs (remove)
/// - Packages changed in both ours and theirs differently = conflict (ours wins, reported)
/// - Packages changed only in ours or only in theirs = take the changed version
pub fn merge_lock_sidecars(
    base: &LockSidecar,
    ours: &LockSidecar,
    theirs: &LockSidecar,
) -> (LockSidecar, Vec<String>, Vec<String>, Vec<String>) {
    let mut merged = BTreeMap::new();
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut conflicts = Vec::new();

    // Collect all package keys from all three sides
    let mut all_keys: BTreeMap<&str, ()> = BTreeMap::new();
    for key in base.packages.keys() {
        all_keys.insert(key.as_str(), ());
    }
    for key in ours.packages.keys() {
        all_keys.insert(key.as_str(), ());
    }
    for key in theirs.packages.keys() {
        all_keys.insert(key.as_str(), ());
    }

    for &key in all_keys.keys() {
        let in_base = base.packages.get(key);
        let in_ours = ours.packages.get(key);
        let in_theirs = theirs.packages.get(key);

        match (in_base, in_ours, in_theirs) {
            // In all three — check for changes
            (Some(b), Some(o), Some(t)) => {
                let ours_changed = o.integrity != b.integrity || o.version != b.version;
                let theirs_changed = t.integrity != b.integrity || t.version != b.version;

                if !ours_changed && !theirs_changed {
                    // No changes, keep base (use ours as canonical)
                    merged.insert(key.to_string(), o.clone());
                } else if ours_changed && !theirs_changed {
                    // Only ours changed
                    merged.insert(key.to_string(), o.clone());
                } else if !ours_changed && theirs_changed {
                    // Only theirs changed
                    merged.insert(key.to_string(), t.clone());
                } else {
                    // Both changed
                    if o.integrity == t.integrity && o.version == t.version {
                        // Same change on both sides
                        merged.insert(key.to_string(), o.clone());
                    } else {
                        // True conflict: ours wins, but report it
                        merged.insert(key.to_string(), o.clone());
                        conflicts.push(key.to_string());
                    }
                }
            }

            // In base and ours, but not theirs = theirs removed it
            (Some(_), Some(_), None) => {
                removed.push(key.to_string());
                // Don't include — theirs intentionally removed it
            }

            // In base and theirs, but not ours = ours removed it
            (Some(_), None, Some(_)) => {
                removed.push(key.to_string());
                // Don't include — ours intentionally removed it
            }

            // Only in base = both removed it
            (Some(_), None, None) => {
                removed.push(key.to_string());
            }

            // Not in base, in ours = ours added it
            (None, Some(o), None) => {
                added.push(key.to_string());
                merged.insert(key.to_string(), o.clone());
            }

            // Not in base, in theirs = theirs added it
            (None, None, Some(t)) => {
                added.push(key.to_string());
                merged.insert(key.to_string(), t.clone());
            }

            // Not in base, in both = both added (check for conflict)
            (None, Some(o), Some(t)) => {
                added.push(key.to_string());
                if o.integrity == t.integrity && o.version == t.version {
                    merged.insert(key.to_string(), o.clone());
                } else {
                    // Both added different versions — ours wins
                    merged.insert(key.to_string(), o.clone());
                    conflicts.push(key.to_string());
                }
            }

            // Not anywhere — shouldn't happen
            (None, None, None) => {}
        }
    }

    let result = LockSidecar {
        version: ours.version.max(theirs.version),
        packages: merged,
    };

    (result, added, removed, conflicts)
}

/// Convert a LockSidecar back to LockPackage entries for the writer.
fn sidecar_to_lock_packages(sidecar: &LockSidecar) -> Vec<LockPackage> {
    sidecar.packages.values().map(|pkg| {
        let dependencies: Vec<String> = pkg.dependencies.iter()
            .map(|(name, ver)| format!("{}@{}", name, ver))
            .collect();

        LockPackage {
            name: pkg.name.clone(),
            version: pkg.version.clone(),
            integrity: pkg.integrity.clone(),
            resolved: pkg.resolved.clone(),
            dependencies,
        }
    }).collect()
}

/// Run a three-way merge on lockfile sidecars and write the result.
///
/// Arguments are paths to the three JSON sidecar files:
/// - base: common ancestor
/// - ours: current branch's version
/// - theirs: incoming branch's version
///
/// Writes merged better.lock + better.lock.json to the output directory.
pub fn merge_lockfiles(
    base_path: &Path,
    ours_path: &Path,
    theirs_path: &Path,
    output_dir: &Path,
) -> Result<LockMergeResult, String> {
    let base = parse_lock_sidecar(base_path)?;
    let ours = parse_lock_sidecar(ours_path)?;
    let theirs = parse_lock_sidecar(theirs_path)?;

    let (merged, added, removed, conflicts) = merge_lock_sidecars(&base, &ours, &theirs);

    // Convert merged sidecar to lock packages
    let packages = sidecar_to_lock_packages(&merged);

    // Write the merged lockfile
    let mut writer = LockfileWriter::new();
    for pkg in &packages {
        writer.add_package(pkg.clone());
    }

    let write_result = writer.write_both(output_dir)?;

    Ok(LockMergeResult {
        ok: conflicts.is_empty(),
        added,
        removed,
        conflicts,
        total_packages: write_result.package_count,
        write_result: Some(write_result),
    })
}

/// Git merge driver entry point.
///
/// Called by git with: better-core lock merge-driver %O %A %B
/// where %O = base, %A = ours (also the output), %B = theirs.
///
/// The merge driver operates on better.lock.json files.
/// After merging, it regenerates both better.lock.json (in place at %A)
/// and better.lock (in the same directory as %A).
///
/// Returns 0 on clean merge, 1 on conflict.
pub fn run_merge_driver(
    base_path: &Path,
    ours_path: &Path,
    theirs_path: &Path,
) -> Result<LockMergeResult, String> {
    let base = parse_lock_sidecar(base_path)?;
    let ours = parse_lock_sidecar(ours_path)?;
    let theirs = parse_lock_sidecar(theirs_path)?;

    let (merged, added, removed, conflicts) = merge_lock_sidecars(&base, &ours, &theirs);

    // Convert merged sidecar to lock packages and write
    let packages = sidecar_to_lock_packages(&merged);

    let mut writer = LockfileWriter::new();
    for pkg in &packages {
        writer.add_package(pkg.clone());
    }

    // The output is written to ours_path's parent directory (the project root)
    let output_dir = ours_path.parent()
        .ok_or_else(|| "Cannot determine output directory from ours path".to_string())?;

    let write_result = writer.write_both(output_dir)?;

    Ok(LockMergeResult {
        ok: conflicts.is_empty(),
        added,
        removed,
        conflicts,
        total_packages: write_result.package_count,
        write_result: Some(write_result),
    })
}

/// Generate .gitattributes content for the merge driver.
pub fn gitattributes_entry() -> &'static str {
    "better.lock.json merge=better-lock\n"
}

/// Generate .git/config merge driver configuration.
pub fn git_merge_driver_config() -> &'static str {
    "[merge \"better-lock\"]\n\tname = better.lock three-way merge driver\n\tdriver = better-core lock merge-driver %O %A %B\n"
}

/// Install the merge driver into the project's .gitattributes and .git/config.
pub fn install_merge_driver(project_root: &Path) -> Result<MergeDriverInstallResult, String> {
    let mut files_modified = Vec::new();

    // 1. Update .gitattributes
    let gitattributes_path = project_root.join(".gitattributes");
    let entry = gitattributes_entry();
    let existing = fs::read_to_string(&gitattributes_path).unwrap_or_default();

    if !existing.contains("better.lock.json merge=better-lock") {
        let mut content = existing;
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(entry);
        fs::write(&gitattributes_path, &content)
            .map_err(|e| format!("Failed to write .gitattributes: {}", e))?;
        files_modified.push(".gitattributes".to_string());
    }

    // 2. Update .git/config (if .git exists)
    let git_config_path = project_root.join(".git").join("config");
    if git_config_path.exists() {
        let existing_config = fs::read_to_string(&git_config_path).unwrap_or_default();
        if !existing_config.contains("[merge \"better-lock\"]") {
            let mut config = existing_config;
            if !config.is_empty() && !config.ends_with('\n') {
                config.push('\n');
            }
            config.push_str(git_merge_driver_config());
            fs::write(&git_config_path, &config)
                .map_err(|e| format!("Failed to write .git/config: {}", e))?;
            files_modified.push(".git/config".to_string());
        }
    }

    Ok(MergeDriverInstallResult {
        installed: !files_modified.is_empty(),
        files_modified,
    })
}

/// Result of installing the merge driver.
#[derive(Debug)]
pub struct MergeDriverInstallResult {
    pub installed: bool,
    pub files_modified: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_sidecar(packages: &[(&str, &str, &str)]) -> LockSidecar {
        let mut map = BTreeMap::new();
        for &(name, version, integrity) in packages {
            let key = format!("{}@{}", name, version);
            map.insert(key, SidecarPackage {
                name: name.to_string(),
                version: version.to_string(),
                resolved: format!("https://registry.npmjs.org/{}/-/{}-{}.tgz", name, name, version),
                integrity: integrity.to_string(),
                dependencies: BTreeMap::new(),
            });
        }
        LockSidecar { version: 1, packages: map }
    }

    #[test]
    fn test_no_changes() {
        let base = make_sidecar(&[("lodash", "4.17.21", "sha512-aaa")]);
        let ours = make_sidecar(&[("lodash", "4.17.21", "sha512-aaa")]);
        let theirs = make_sidecar(&[("lodash", "4.17.21", "sha512-aaa")]);

        let (merged, added, removed, conflicts) = merge_lock_sidecars(&base, &ours, &theirs);
        assert_eq!(merged.packages.len(), 1);
        assert!(added.is_empty());
        assert!(removed.is_empty());
        assert!(conflicts.is_empty());
    }

    #[test]
    fn test_ours_adds_package() {
        let base = make_sidecar(&[("lodash", "4.17.21", "sha512-aaa")]);
        let ours = make_sidecar(&[
            ("lodash", "4.17.21", "sha512-aaa"),
            ("express", "4.18.2", "sha512-bbb"),
        ]);
        let theirs = make_sidecar(&[("lodash", "4.17.21", "sha512-aaa")]);

        let (merged, added, removed, conflicts) = merge_lock_sidecars(&base, &ours, &theirs);
        assert_eq!(merged.packages.len(), 2);
        assert_eq!(added, vec!["express@4.18.2"]);
        assert!(removed.is_empty());
        assert!(conflicts.is_empty());
    }

    #[test]
    fn test_theirs_adds_package() {
        let base = make_sidecar(&[("lodash", "4.17.21", "sha512-aaa")]);
        let ours = make_sidecar(&[("lodash", "4.17.21", "sha512-aaa")]);
        let theirs = make_sidecar(&[
            ("lodash", "4.17.21", "sha512-aaa"),
            ("react", "18.2.0", "sha512-ccc"),
        ]);

        let (merged, added, removed, conflicts) = merge_lock_sidecars(&base, &ours, &theirs);
        assert_eq!(merged.packages.len(), 2);
        assert_eq!(added, vec!["react@18.2.0"]);
        assert!(removed.is_empty());
        assert!(conflicts.is_empty());
    }

    #[test]
    fn test_both_add_different_packages() {
        let base = make_sidecar(&[("lodash", "4.17.21", "sha512-aaa")]);
        let ours = make_sidecar(&[
            ("lodash", "4.17.21", "sha512-aaa"),
            ("express", "4.18.2", "sha512-bbb"),
        ]);
        let theirs = make_sidecar(&[
            ("lodash", "4.17.21", "sha512-aaa"),
            ("react", "18.2.0", "sha512-ccc"),
        ]);

        let (merged, added, _removed, conflicts) = merge_lock_sidecars(&base, &ours, &theirs);
        assert_eq!(merged.packages.len(), 3);
        assert!(added.contains(&"express@4.18.2".to_string()));
        assert!(added.contains(&"react@18.2.0".to_string()));
        assert!(conflicts.is_empty());
    }

    #[test]
    fn test_theirs_removes_package() {
        let base = make_sidecar(&[
            ("lodash", "4.17.21", "sha512-aaa"),
            ("express", "4.18.2", "sha512-bbb"),
        ]);
        let ours = make_sidecar(&[
            ("lodash", "4.17.21", "sha512-aaa"),
            ("express", "4.18.2", "sha512-bbb"),
        ]);
        let theirs = make_sidecar(&[("lodash", "4.17.21", "sha512-aaa")]);

        let (merged, _added, removed, conflicts) = merge_lock_sidecars(&base, &ours, &theirs);
        assert_eq!(merged.packages.len(), 1);
        assert!(removed.contains(&"express@4.18.2".to_string()));
        assert!(conflicts.is_empty());
    }

    #[test]
    fn test_ours_updates_theirs_doesnt() {
        let base = make_sidecar(&[("lodash", "4.17.20", "sha512-old")]);
        let ours = make_sidecar(&[("lodash", "4.17.21", "sha512-new")]);
        let theirs = make_sidecar(&[("lodash", "4.17.20", "sha512-old")]);

        let (merged, _, _, conflicts) = merge_lock_sidecars(&base, &ours, &theirs);
        assert!(conflicts.is_empty());
        // Note: the key changed because version changed. The old key is "removed" and new is "added"
        // But since the merge operates on keys (name@version), updating a version means:
        // - base has lodash@4.17.20, ours doesn't have it -> removed by ours
        // - ours has lodash@4.17.21, base doesn't have it -> added by ours
        // This is correct behavior for lockfiles.
        assert!(merged.packages.contains_key("lodash@4.17.21"));
        assert!(!merged.packages.contains_key("lodash@4.17.20"));
    }

    #[test]
    fn test_conflict_both_update_differently() {
        let base = make_sidecar(&[("lodash", "4.17.20", "sha512-old")]);
        let ours = make_sidecar(&[("lodash", "4.17.20", "sha512-ours")]);
        let theirs = make_sidecar(&[("lodash", "4.17.20", "sha512-theirs")]);

        let (merged, _, _, conflicts) = merge_lock_sidecars(&base, &ours, &theirs);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0], "lodash@4.17.20");
        // Ours wins on conflict
        let pkg = merged.packages.get("lodash@4.17.20").unwrap();
        assert_eq!(pkg.integrity, "sha512-ours");
    }

    #[test]
    fn test_parse_sidecar_json() {
        let json = r#"{
            "version": 1,
            "generated": "2026-03-29T00:00:00Z",
            "packages": {
                "lodash@4.17.21": {
                    "version": "4.17.21",
                    "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
                    "integrity": "sha512-aaa",
                    "dependencies": {
                        "dep-a": "^1.0.0"
                    }
                },
                "express@4.18.2": {
                    "version": "4.18.2",
                    "resolved": "https://registry.npmjs.org/express/-/express-4.18.2.tgz",
                    "integrity": "sha512-bbb"
                }
            },
            "fingerprint": "sha256:abc123"
        }"#;

        let sidecar = parse_lock_sidecar_str(json).unwrap();
        assert_eq!(sidecar.version, 1);
        assert_eq!(sidecar.packages.len(), 2);

        let lodash = sidecar.packages.get("lodash@4.17.21").unwrap();
        assert_eq!(lodash.name, "lodash");
        assert_eq!(lodash.version, "4.17.21");
        assert_eq!(lodash.integrity, "sha512-aaa");
        assert_eq!(lodash.dependencies.len(), 1);
        assert_eq!(lodash.dependencies.get("dep-a").unwrap(), "^1.0.0");

        let express = sidecar.packages.get("express@4.18.2").unwrap();
        assert_eq!(express.name, "express");
        assert!(express.dependencies.is_empty());
    }

    #[test]
    fn test_merge_and_write_roundtrip() {
        let base = make_sidecar(&[
            ("lodash", "4.17.21", "sha512-aaa"),
        ]);
        let ours = make_sidecar(&[
            ("lodash", "4.17.21", "sha512-aaa"),
            ("express", "4.18.2", "sha512-bbb"),
        ]);
        let theirs = make_sidecar(&[
            ("lodash", "4.17.21", "sha512-aaa"),
            ("react", "18.2.0", "sha512-ccc"),
        ]);

        let (merged, _, _, _) = merge_lock_sidecars(&base, &ours, &theirs);
        let packages = sidecar_to_lock_packages(&merged);

        let mut writer = LockfileWriter::new();
        for pkg in &packages {
            writer.add_package(pkg.clone());
        }

        let dir = std::env::temp_dir().join("better-lock-merge-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let result = writer.write_both(&dir).unwrap();
        assert_eq!(result.package_count, 3);

        // Verify the JSON sidecar is valid and can be re-parsed
        let reparsed = parse_lock_sidecar(&dir.join("better.lock.json")).unwrap();
        assert_eq!(reparsed.packages.len(), 3);
        assert!(reparsed.packages.contains_key("lodash@4.17.21"));
        assert!(reparsed.packages.contains_key("express@4.18.2"));
        assert!(reparsed.packages.contains_key("react@18.2.0"));

        let _ = fs::remove_dir_all(&dir);
    }
}
