use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::types::*;
use crate::{
    cas_key_from_integrity, extract_json_object_pairs,
    ingest_to_file_cas, materialize_tree, try_clonefile_dir, unpacked_path,
    remove_path_if_exists,
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
    file_cas_root: &Path,
    link_strategy: LinkStrategy,
) -> Result<StrictMaterializeStats, String> {
    let mut stats = StrictMaterializeStats::default();

    let node_modules = project_root.join("node_modules");
    let store_dir = node_modules.join(".better");
    let _ = fs::create_dir_all(&store_dir);

    // Build name@version -> ResolvedPackage lookup
    let mut by_key: HashMap<String, &ResolvedPackage> = HashMap::new();
    // Also build name -> key for direct dep lookup
    let mut name_to_key: HashMap<String, String> = HashMap::new();

    for pkg in packages {
        let key = format!("{}@{}", pkg.name, pkg.version);
        by_key.insert(key.clone(), pkg);
        // For packages with the same name, prefer the top-level one (shortest rel_path)
        let existing = name_to_key.get(&pkg.name);
        if existing.is_none() || pkg.rel_path.len() < by_key[existing.unwrap()].rel_path.len() {
            name_to_key.insert(pkg.name.clone(), key);
        }
    }

    // Phase 1: Materialize each package into the store
    for pkg in packages {
        let key = format!("{}@{}", pkg.name, pkg.version);
        let pkg_real_dir = store_dir
            .join(&key)
            .join("node_modules")
            .join(&pkg.name);

        // Skip if already materialized
        if pkg_real_dir.join("package.json").exists() {
            stats.packages += 1;
            continue;
        }

        let _ = fs::create_dir_all(&pkg_real_dir);
        stats.directories += 1;

        // Try to get files from CAS or extract from tarball
        let materialized = if let Some((algo, hex)) = cas_key_from_integrity(&pkg.integrity) {
            let unpacked = unpacked_path(cas_layout, &algo, &hex);
            let src_dir = unpacked.join("package");
            if src_dir.exists() {
                // Ingest to file CAS for dedup
                let _ = ingest_to_file_cas(file_cas_root, &algo, &hex, &src_dir);

                // Try clonefile first (macOS APFS)
                if try_clonefile_dir(&src_dir, &pkg_real_dir) {
                    true
                } else {
                    // Fallback to materialize_tree
                    match materialize_tree(&src_dir, &pkg_real_dir, link_strategy, 4, MaterializeProfile::Auto) {
                        Ok(report) => {
                            stats.files_linked += report.stats.files_linked;
                            stats.files_copied += report.stats.files_copied;
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
    // For each package in the store, read its package.json and create symlinks
    // to its declared dependencies.
    for pkg in packages {
        let key = format!("{}@{}", pkg.name, pkg.version);
        let pkg_nm = store_dir.join(&key).join("node_modules");
        let pkg_real_dir = pkg_nm.join(&pkg.name);

        let declared_deps = read_declared_deps(&pkg_real_dir);

        for dep_name in &declared_deps {
            let link_path = pkg_nm.join(dep_name);

            // Don't overwrite the real package directory itself
            if link_path == pkg_real_dir {
                continue;
            }

            // Skip if already exists (could be a real dir or existing symlink)
            if link_path.symlink_metadata().is_ok() {
                continue;
            }

            // Find the resolved version of this dependency
            // Use the rel_path hierarchy to determine which version applies
            let dep_key = find_dep_version(dep_name, pkg, packages);

            if let Some(dep_key) = dep_key {
                let target = store_dir
                    .join(&dep_key)
                    .join("node_modules")
                    .join(dep_name);

                // Handle scoped packages: create @scope/ dir first
                if dep_name.contains('/') {
                    if let Some(parent) = link_path.parent() {
                        let _ = fs::create_dir_all(parent);
                        stats.directories += 1;
                    }
                }

                // Create relative symlink
                let rel_target = pathdiff_relative(&link_path, &target);
                #[cfg(unix)]
                {
                    if let Err(_) = std::os::unix::fs::symlink(&rel_target, &link_path) {
                        // Try absolute as fallback
                        let _ = std::os::unix::fs::symlink(&target, &link_path);
                    }
                }
                #[cfg(windows)]
                {
                    let _ = std::os::windows::fs::symlink_dir(&target, &link_path);
                }
                stats.internal_symlinks += 1;
            }
        }
    }

    // Phase 3: Create root-level symlinks for direct dependencies
    let direct_deps = read_direct_deps(project_root);

    for dep_name in &direct_deps {
        if let Some(key) = name_to_key.get(dep_name) {
            let link_path = node_modules.join(dep_name);
            let target = store_dir
                .join(key)
                .join("node_modules")
                .join(dep_name);

            // Handle scoped packages
            if dep_name.contains('/') {
                if let Some(parent) = link_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
            }

            // Remove existing entry
            let _ = remove_path_if_exists(&link_path);

            // Create relative symlink
            let rel_target = pathdiff_relative(&link_path, &target);
            #[cfg(unix)]
            {
                if let Err(_) = std::os::unix::fs::symlink(&rel_target, &link_path) {
                    let _ = std::os::unix::fs::symlink(&target, &link_path);
                }
            }
            #[cfg(windows)]
            {
                let _ = std::os::windows::fs::symlink_dir(&target, &link_path);
            }
            stats.root_symlinks += 1;
        }
    }

    Ok(stats)
}

/// Find the resolved version key for a dependency of a given package.
/// Uses npm's nested resolution algorithm: look for the dep in the package's own
/// node_modules first, then walk up to find the hoisted version.
fn find_dep_version(
    dep_name: &str,
    parent_pkg: &ResolvedPackage,
    all_packages: &[ResolvedPackage],
) -> Option<String> {
    // In npm's package-lock.json, dependencies are placed at specific paths.
    // If parent is at node_modules/express and dep is debug,
    // npm would place debug at node_modules/express/node_modules/debug (nested)
    // or at node_modules/debug (hoisted).

    // First: check for a nested version under the parent's path
    let parent_base = &parent_pkg.rel_path; // e.g. "node_modules/express"
    let nested_path = format!("{}/node_modules/{}", parent_base, dep_name);

    for pkg in all_packages {
        if pkg.rel_path == nested_path && pkg.name == dep_name {
            return Some(format!("{}@{}", pkg.name, pkg.version));
        }
    }

    // Second: walk up the parent path to find hoisted versions
    // e.g. from node_modules/a/node_modules/b, try node_modules/a/node_modules/{dep}, then node_modules/{dep}
    let mut search_path = parent_base.to_string();
    loop {
        // Go up one node_modules level
        if let Some(pos) = search_path.rfind("/node_modules/") {
            search_path = search_path[..pos].to_string();
            let candidate = format!("{}/node_modules/{}", search_path, dep_name);
            for pkg in all_packages {
                if pkg.rel_path == candidate && pkg.name == dep_name {
                    return Some(format!("{}@{}", pkg.name, pkg.version));
                }
            }
        } else {
            break;
        }
    }

    // Final: check top-level
    let top_level = format!("node_modules/{}", dep_name);
    for pkg in all_packages {
        if pkg.rel_path == top_level && pkg.name == dep_name {
            return Some(format!("{}@{}", pkg.name, pkg.version));
        }
    }

    // Fallback: find any package with this name (use first match)
    for pkg in all_packages {
        if pkg.name == dep_name {
            return Some(format!("{}@{}", pkg.name, pkg.version));
        }
    }

    None
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

    #[test]
    fn test_pathdiff_relative() {
        let from = Path::new("/project/node_modules/express");
        let to = Path::new("/project/node_modules/.better/express@4.18.2/node_modules/express");
        let result = pathdiff_relative(from, to);
        assert_eq!(result, PathBuf::from(".better/express@4.18.2/node_modules/express"));
    }

    #[test]
    fn test_pathdiff_internal_link() {
        let from = Path::new("/project/node_modules/.better/express@4.18.2/node_modules/debug");
        let to = Path::new("/project/node_modules/.better/debug@2.6.9/node_modules/debug");
        let result = pathdiff_relative(from, to);
        assert_eq!(result, PathBuf::from("../../debug@2.6.9/node_modules/debug"));
    }

    #[test]
    fn test_find_dep_version_hoisted() {
        let packages = vec![
            ResolvedPackage {
                name: "express".into(),
                version: "4.18.2".into(),
                rel_path: "node_modules/express".into(),
                resolved_url: "".into(),
                integrity: "".into(),
            },
            ResolvedPackage {
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
                name: "express".into(),
                version: "4.18.2".into(),
                rel_path: "node_modules/express".into(),
                resolved_url: "".into(),
                integrity: "".into(),
            },
            ResolvedPackage {
                name: "debug".into(),
                version: "4.3.4".into(),
                rel_path: "node_modules/debug".into(),
                resolved_url: "".into(),
                integrity: "".into(),
            },
            ResolvedPackage {
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
}
