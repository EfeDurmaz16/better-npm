use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::types::*;
use crate::{
    cas_key_from_integrity, extract_json_object_pairs, materialize_tree, remove_path_if_exists,
    try_clonefile_dir, unpacked_path,
};

/// Read a package.json and extract declared dependency names.
fn read_declared_deps(pkg_dir: &Path) -> Vec<String> {
    let pkg_json = pkg_dir.join("package.json");
    let content = match fs::read_to_string(&pkg_json) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut deps = Vec::new();
    if let Ok(pairs) = extract_json_object_pairs(&content, "dependencies") {
        for (name, _) in pairs {
            deps.push(name);
        }
    }
    deps
}

/// Read a project's package.json to get direct dependency names.
pub fn read_direct_deps(project_root: &Path) -> Vec<String> {
    let pkg_json = project_root.join("package.json");
    let content = match fs::read_to_string(&pkg_json) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut deps = Vec::new();
    for section in &["dependencies", "devDependencies", "optionalDependencies"] {
        if let Ok(pairs) = extract_json_object_pairs(&content, section) {
            for (name, _) in pairs {
                if !deps.contains(&name) {
                    deps.push(name);
                }
            }
        }
    }
    deps
}

/// Materialize packages in strict (isolated) layout.
///
/// Layout:
/// ```text
/// node_modules/
///   .better/
///     {name}@{version}/
///       node_modules/
///         {name}/          <-- actual files (hardlinked from CAS or copied)
///         {dep_name} ->    symlink to ../../{dep_name}@{dep_ver}/node_modules/{dep_name}
///   {name} ->              symlink to .better/{name}@{version}/node_modules/{name}
///   .bin/
/// ```
pub fn materialize_strict(
    packages: &[ResolvedPackage],
    project_root: &Path,
    cas_layout: &CasLayout,
    _file_cas_root: &Path,
    link_strategy: LinkStrategy,
) -> Result<StrictMaterializeStats, String> {
    crate::validate_package_paths(packages)?;
    let mut stats = StrictMaterializeStats::default();

    let node_modules = project_root.join("node_modules");
    let store_dir = node_modules.join(".better");
    crate::create_materialize_dir(&node_modules, &store_dir)?;

    let locations: BTreeMap<_, _> = packages
        .iter()
        .enumerate()
        .map(|(index, pkg)| (pkg.rel_path.as_str(), index))
        .collect();
    let keys = store_keys(packages);
    // Phase 1: Materialize each package into the store
    for (index, pkg) in packages.iter().enumerate() {
        let key = &keys[index];
        let pkg_real_dir = store_dir.join(&key).join("node_modules").join(&pkg.name);

        crate::create_materialize_dir(&node_modules, &pkg_real_dir)?;

        stats.directories += 1;

        // Try to get files from CAS or extract from tarball
        let materialized = if let Some((algo, hex)) = cas_key_from_integrity(&pkg.integrity) {
            let unpacked = unpacked_path(cas_layout, &algo, &hex);
            let src_dir = unpacked.join("package");
            if src_dir.exists() {
                // Try clonefile first (macOS APFS)
                if matches!(link_strategy, LinkStrategy::Auto)
                    && try_clonefile_dir(&src_dir, &pkg_real_dir)
                {
                    true
                } else {
                    // Fallback to materialize_tree
                    match materialize_tree(
                        &src_dir,
                        &pkg_real_dir,
                        link_strategy,
                        4,
                        MaterializeProfile::Auto,
                    ) {
                        Ok(report) => {
                            stats.files_linked += report.stats.files_linked;
                            stats.files_copied += report.stats.files_copied;
                            stats.files_reused += report.stats.files_reused;
                            stats.symlinks_reused += report.stats.symlinks_reused;
                            stats.package_symlinks += report.stats.symlinks;
                            stats.directories += report.stats.directories;
                            true
                        }
                        Err(_) => false,
                    }
                }
            } else {
                false
            }
        } else {
            false
        };

        if !materialized {
            return Err(format!("Failed to materialize {} into store", key));
        }

        stats.packages += 1;
    }

    // Phase 2: Create internal dependency symlinks
    // Resolve lockfile declarations through the shared location index.
    for (index, pkg) in packages.iter().enumerate() {
        let key = &keys[index];
        let pkg_nm = store_dir.join(&key).join("node_modules");
        let pkg_real_dir = pkg_nm.join(&pkg.name);

        let mut declared_deps: BTreeMap<String, bool> = pkg
            .selection
            .dependencies
            .keys()
            .chain(pkg.selection.optional_dependencies.keys())
            .map(|name| (name.clone(), false))
            .collect();
        for name in pkg.selection.peer_dependencies.keys() {
            declared_deps.entry(name.clone()).or_insert(true);
        }
        // Legacy callers can supply packages without lockfile dependency metadata.
        if declared_deps.is_empty() {
            declared_deps.extend(
                read_declared_deps(&pkg_real_dir)
                    .into_iter()
                    .map(|name| (name, false)),
            );
        }

        for (dep_name, peer) in &declared_deps {
            let link_path = pkg_nm.join(dep_name);

            // Don't overwrite the real package directory itself
            if link_path == pkg_real_dir {
                continue;
            }

            let dep_index = crate::platform_selection::lookup_target(
                &pkg.rel_path,
                dep_name,
                *peer,
                &locations,
            );

            if let Some(dep_index) = dep_index {
                let target = store_dir.join(&keys[dep_index]).join("node_modules")
                    .join(&packages[dep_index].name);

                // Handle scoped packages: create @scope/ dir first
                if dep_name.contains('/') {
                    if let Some(parent) = link_path.parent() {
                        crate::create_materialize_dir(&node_modules, parent)?;
                        stats.directories += 1;
                    }
                }

                // Create relative symlink
                let rel_target = pathdiff_relative(&link_path, &target);
                if fs::read_link(&link_path).ok().as_ref() == Some(&rel_target) {
                    continue;
                }
                remove_path_if_exists(&link_path)?;
                #[cfg(unix)]
                {
                    std::os::unix::fs::symlink(&rel_target, &link_path)
                        .map_err(|error| format!("Failed to link {}: {}", link_path.display(), error))?;
                }
                #[cfg(windows)]
                {
                    std::os::windows::fs::symlink_dir(&target, &link_path)
                        .map_err(|error| format!("Failed to link {}: {}", link_path.display(), error))?;
                }
                stats.internal_symlinks += 1;
            }
        }
    }

    // Phase 3: Create root-level symlinks for direct dependencies
    let direct_deps = read_direct_deps(project_root);

    for dep_name in &direct_deps {
        if let Some(index) = locations.get(format!("node_modules/{}", dep_name).as_str()) {
            let key = &keys[*index];
            let link_path = node_modules.join(dep_name);
            let target = store_dir.join(key).join("node_modules").join(&packages[*index].name);

            // Handle scoped packages
            if dep_name.contains('/') {
                if let Some(parent) = link_path.parent() {
                    crate::create_materialize_dir(&node_modules, parent)?;
                }
            }

            // Create relative symlink
            let rel_target = pathdiff_relative(&link_path, &target);
            if fs::read_link(&link_path).ok().as_ref() == Some(&rel_target) {
                continue;
            }
            remove_path_if_exists(&link_path)?;
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&rel_target, &link_path)
                    .map_err(|error| format!("Failed to link {}: {}", link_path.display(), error))?;
            }
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_dir(&target, &link_path)
                        .map_err(|error| format!("Failed to link {}: {}", link_path.display(), error))?;
            }
            stats.root_symlinks += 1;
        }
    }

    Ok(stats)
}

/// Distinct lockfile locations can have different dependency/peer contexts even
/// when their package bytes and version match. Never merge their writable trees.
fn store_keys(packages: &[ResolvedPackage]) -> Vec<String> {
    let mut counts = HashMap::new();
    for pkg in packages {
        *counts.entry((&pkg.name, &pkg.version)).or_insert(0usize) += 1;
    }
    packages
        .iter()
        .map(|pkg| {
            let base = format!("{}@{}", pkg.name, pkg.version);
            if counts[&(&pkg.name, &pkg.version)] == 1 {
                return base;
            }
            let mut identity = Sha256::new();
            identity.update(base.as_bytes());
            identity.update([0]);
            identity.update(pkg.rel_path.as_bytes());
            // Keep the whole component bounded even for long valid npm names.
            format!("ctx-{:x}", identity.finalize())
        })
        .collect()
}

#[cfg(test)]
fn find_dep_version(
    dep_name: &str,
    parent_pkg: &ResolvedPackage,
    packages: &[ResolvedPackage],
) -> Option<String> {
    let locations = packages
        .iter()
        .enumerate()
        .map(|(i, p)| (p.rel_path.as_str(), i))
        .collect();
    crate::platform_selection::lookup_target(&parent_pkg.rel_path, dep_name, false, &locations)
        .map(|index| format!("{}@{}", packages[index].name, packages[index].version))
}

/// Compute a relative path from `from` (a file/link path) to `to` (a target path).
/// Both paths should be absolute. The result is relative from `from`'s parent directory.
fn pathdiff_relative(from: &Path, to: &Path) -> PathBuf {
    let from_dir = from.parent().unwrap_or(from);

    // Count how many components differ
    let from_components: Vec<_> = from_dir.components().collect();
    let to_components: Vec<_> = to.components().collect();

    let common = from_components
        .iter()
        .zip(to_components.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let mut result = PathBuf::new();
    for _ in 0..(from_components.len() - common) {
        result.push("..");
    }
    for component in &to_components[common..] {
        result.push(component);
    }

    if result.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(name: &str, location: &str) -> ResolvedPackage {
        ResolvedPackage {
            name: name.into(),
            version: "1".into(),
            rel_path: location.into(),
            integrity: String::new(),
            resolved_url: String::new(),
            selection: Default::default(),
        }
    }

    #[test]
    fn identical_versions_keep_distinct_dependency_contexts() {
        let packages = vec![
            package("a", "node_modules/a"),
            package("a", "node_modules/b/node_modules/a"),
        ];
        let keys = store_keys(&packages);
        assert_ne!(keys[0], keys[1]);
        assert_eq!(keys, store_keys(&packages));
    }

    #[test]
    fn long_duplicate_names_have_bounded_context_components() {
        let name = "a".repeat(210);
        let packages = vec![
            package(&name, &format!("node_modules/{name}")),
            package(&name, &format!("node_modules/parent/node_modules/{name}")),
        ];
        let keys = store_keys(&packages);
        assert_ne!(keys[0], keys[1]);
        let root = tempfile::tempdir().unwrap();
        for key in keys {
            assert_eq!(key.len(), 68);
            fs::create_dir(root.path().join(key)).unwrap();
        }
    }

    #[test]
    fn dependency_in_sibling_subtree_is_not_visible() {
        let packages = vec![
            package("a", "node_modules/a"),
            package("dep", "node_modules/b/node_modules/dep"),
        ];
        assert!(find_dep_version("dep", &packages[0], &packages).is_none());
    }

    #[test]
    fn test_pathdiff_relative() {
        let from = Path::new("/project/node_modules/express");
        let to = Path::new("/project/node_modules/.better/express@4.18.2/node_modules/express");
        let result = pathdiff_relative(from, to);
        assert_eq!(
            result,
            PathBuf::from(".better/express@4.18.2/node_modules/express")
        );
    }

    #[test]
    fn test_pathdiff_internal_link() {
        let from = Path::new("/project/node_modules/.better/express@4.18.2/node_modules/debug");
        let to = Path::new("/project/node_modules/.better/debug@2.6.9/node_modules/debug");
        let result = pathdiff_relative(from, to);
        assert_eq!(
            result,
            PathBuf::from("../../debug@2.6.9/node_modules/debug")
        );
    }

    #[test]
    fn test_find_dep_version_hoisted() {
        let packages = vec![
            ResolvedPackage {
                selection: Default::default(),
                name: "express".into(),
                version: "4.18.2".into(),
                rel_path: "node_modules/express".into(),
                resolved_url: "".into(),
                integrity: "".into(),
            },
            ResolvedPackage {
                selection: Default::default(),
                name: "debug".into(),
                version: "2.6.9".into(),
                rel_path: "node_modules/debug".into(),
                resolved_url: "".into(),
                integrity: "".into(),
            },
        ];
        let result = find_dep_version("debug", &packages[0], &packages);
        assert_eq!(result, Some("debug@2.6.9".into()));
    }

    #[test]
    fn test_find_dep_version_nested() {
        let packages = vec![
            ResolvedPackage {
                selection: Default::default(),
                name: "express".into(),
                version: "4.18.2".into(),
                rel_path: "node_modules/express".into(),
                resolved_url: "".into(),
                integrity: "".into(),
            },
            ResolvedPackage {
                selection: Default::default(),
                name: "debug".into(),
                version: "4.3.4".into(),
                rel_path: "node_modules/debug".into(),
                resolved_url: "".into(),
                integrity: "".into(),
            },
            ResolvedPackage {
                selection: Default::default(),
                name: "debug".into(),
                version: "2.6.9".into(),
                rel_path: "node_modules/express/node_modules/debug".into(),
                resolved_url: "".into(),
                integrity: "".into(),
            },
        ];
        // express should find its nested debug@2.6.9, not the hoisted debug@4.3.4
        let result = find_dep_version("debug", &packages[0], &packages);
        assert_eq!(result, Some("debug@2.6.9".into()));
    }

    #[test]
    fn find_dep_version_missing_returns_none() {
        let packages = vec![ResolvedPackage {
            selection: Default::default(),
            name: "express".into(),
            version: "4.18.2".into(),
            rel_path: "node_modules/express".into(),
            resolved_url: "".into(),
            integrity: "".into(),
        }];
        let result = find_dep_version("nonexistent", &packages[0], &packages);
        assert!(result.is_none());
    }

    #[test]
    fn pathdiff_relative_same_dir_returns_filename() {
        let from = Path::new("/a/b/link");
        let to = Path::new("/a/b/target");
        let result = pathdiff_relative(from, to);
        assert_eq!(result, PathBuf::from("target"));
    }

    #[test]
    fn read_direct_deps_missing_file_returns_empty() {
        let tmp = std::env::temp_dir().join("strict-test-no-pkg");
        std::fs::create_dir_all(&tmp).unwrap();
        let deps = read_direct_deps(&tmp);
        assert!(deps.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_direct_deps_parses_all_sections() {
        let tmp = std::env::temp_dir().join("strict-test-direct-deps");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join("package.json"),
            r#"{"dependencies":{"express":"^4"},"devDependencies":{"jest":"^29"}}"#,
        )
        .unwrap();
        let deps = read_direct_deps(&tmp);
        assert!(deps.contains(&"express".to_string()));
        assert!(deps.contains(&"jest".to_string()));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
