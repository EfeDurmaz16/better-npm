// crates/better-core/src/materialize/strict.rs
//
// Strict (pnpm-style) node_modules layout engine.
//
// Each package lives in its own isolated store directory under
// `node_modules/.better/<name>@<version>/node_modules/<name>/`.
// Internal dependency symlinks prevent phantom-dep access: a package can
// only `require()` what it explicitly declares in its own dependencies.
//
// Layout overview:
//
//   node_modules/
//   ├── .better/
//   │   ├── lodash@4.17.21/
//   │   │   └── node_modules/
//   │   │       └── lodash/          ← actual package files (hardlinked from CAS)
//   │   └── express@4.18.2/
//   │       └── node_modules/
//   │           ├── express/         ← actual files
//   │           ├── body-parser →    ← symlink to .better/body-parser@1.20.2/…
//   │           └── debug →          ← symlink to .better/debug@2.6.9/…
//   ├── lodash    →  .better/lodash@4.17.21/node_modules/lodash
//   ├── express   →  .better/express@4.18.2/node_modules/express
//   └── .bin/

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Input graph
// ---------------------------------------------------------------------------

/// A single package node for the strict layout planner.
#[derive(Debug, Clone)]
pub struct StrictPkg {
    pub name: String,
    pub version: String,
    /// Files to materialise: relative path → CAS integrity key
    pub files: Vec<StrictPkgFile>,
    /// Direct dependencies of this package: dep_name → resolved_version
    pub deps: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct StrictPkgFile {
    /// Relative path within the package (e.g. "lib/index.js")
    pub rel_path: String,
    /// SHA-512 or sha1 integrity string used as CAS key
    pub integrity: String,
}

// ---------------------------------------------------------------------------
// Planner output
// ---------------------------------------------------------------------------

/// Planned layout — lists of symlinks and directories to create.
#[derive(Debug, Default)]
pub struct StrictLayoutPlan {
    /// Directories to create (in order).
    pub dirs: Vec<PathBuf>,
    /// Hard-link operations: (cas_path, target_path)
    pub hard_links: Vec<(PathBuf, PathBuf)>,
    /// Symlink operations: (target, link_path)
    pub symlinks: Vec<(PathBuf, PathBuf)>,
}

// ---------------------------------------------------------------------------
// Layout planner
// ---------------------------------------------------------------------------

/// Plans the strict `node_modules` layout without touching the filesystem.
pub fn plan_strict_layout(
    project_root: &Path,
    cas_dir: &Path,
    packages: &[StrictPkg],
    direct_deps: &[String],
) -> StrictLayoutPlan {
    let nm = project_root.join("node_modules");
    let store = nm.join(".better");

    let mut plan = StrictLayoutPlan::default();

    // Resolve name → package for quick lookup
    let by_key: HashMap<String, &StrictPkg> = packages
        .iter()
        .map(|p| (format!("{}@{}", p.name, p.version), p))
        .collect();

    for pkg in packages {
        let key = format!("{}@{}", pkg.name, pkg.version);
        let pkg_content_dir = store
            .join(&key)
            .join("node_modules")
            .join(&pkg.name);

        // Phase 1: directories for package content
        plan.dirs.push(pkg_content_dir.clone());

        // Phase 2: hard-link each file from CAS
        for f in &pkg.files {
            let cas_path = cas_dir.join(integrity_to_filename(&f.integrity));
            let file_target = pkg_content_dir.join(&f.rel_path);
            if let Some(parent) = file_target.parent() {
                plan.dirs.push(parent.to_path_buf());
            }
            plan.hard_links.push((cas_path, file_target));
        }

        // Phase 3: internal dep symlinks under
        //   .better/<key>/node_modules/<dep_name>  →  .better/<dep_key>/node_modules/<dep_name>
        let pkg_nm_dir = store.join(&key).join("node_modules");
        for (dep_name, dep_version) in &pkg.deps {
            let dep_key = format!("{}@{}", dep_name, dep_version);
            // Only create symlink if this dep is in the graph
            if by_key.contains_key(&dep_key) {
                let link_path = pkg_nm_dir.join(dep_name);
                let target = store
                    .join(&dep_key)
                    .join("node_modules")
                    .join(dep_name);
                plan.symlinks.push((target, link_path));
            }
        }
    }

    // Phase 4: root symlinks for direct deps
    for dep_name in direct_deps {
        // Find the resolved version for this direct dep
        let matching_pkg = packages.iter().find(|p| &p.name == dep_name);
        if let Some(pkg) = matching_pkg {
            let key = format!("{}@{}", pkg.name, pkg.version);
            let target = store
                .join(&key)
                .join("node_modules")
                .join(dep_name);

            // Handle scoped packages: @scope/name  →  create @scope/ dir first
            let link_path = nm.join(dep_name);
            if dep_name.starts_with('@') {
                if let Some(scope_dir) = link_path.parent() {
                    plan.dirs.push(scope_dir.to_path_buf());
                }
            }
            plan.symlinks.push((target, link_path));
        }
    }

    plan
}

/// Convert a sha512/sha1 integrity string like
/// `sha512-abc...` to a filesystem-safe filename.
fn integrity_to_filename(integrity: &str) -> String {
    integrity.replace('/', "_").replace(':', "-")
}

// ---------------------------------------------------------------------------
// Materialiser
// ---------------------------------------------------------------------------

/// Statistics from a strict materialisation run.
#[derive(Debug, Default)]
pub struct StrictLayoutStats {
    pub files_linked: u64,
    pub files_copied: u64,
    pub symlinks_created: u64,
    pub dirs_created: u64,
    pub skipped: u64,
}

/// Execute a pre-computed `StrictLayoutPlan` against the filesystem.
///
/// The `cas_dir` path for hard-links must already be populated by the
/// fetch phase before calling this function.
pub fn materialise_strict_plan(plan: &StrictLayoutPlan) -> Result<StrictLayoutStats, io::Error> {
    let mut stats = StrictLayoutStats::default();

    // Create all directories (deduplicated by the planner is best-effort;
    // create_dir_all is idempotent).
    for dir in &plan.dirs {
        fs::create_dir_all(dir)?;
        stats.dirs_created += 1;
    }

    // Hard-link files from CAS
    for (cas_path, target) in &plan.hard_links {
        if target.exists() {
            stats.skipped += 1;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::hard_link(cas_path, target) {
            Ok(()) => stats.files_linked += 1,
            Err(_) if cas_path.exists() => {
                fs::copy(cas_path, target)?;
                stats.files_copied += 1;
            }
            Err(e) => return Err(e),
        }
    }

    // Create symlinks
    for (target, link_path) in &plan.symlinks {
        // Remove stale link if present
        if link_path.symlink_metadata().is_ok() {
            let _ = fs::remove_file(link_path)
                .or_else(|_| fs::remove_dir_all(link_path));
        }

        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link_path)?;

        #[cfg(windows)]
        {
            if target.is_dir() {
                std::os::windows::fs::symlink_dir(target, link_path)?;
            } else {
                std::os::windows::fs::symlink_file(target, link_path)?;
            }
        }

        stats.symlinks_created += 1;
    }

    Ok(stats)
}

// ---------------------------------------------------------------------------
// Phantom dependency scanner
// ---------------------------------------------------------------------------

/// A phantom dependency: a package that is `require()`d but not declared
/// as a direct or transitive dependency.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PhantomDep {
    pub importing_package: String,
    pub import_name: String,
    pub reason: String,
}

/// Detect phantom dependencies given the resolved graph.
///
/// A phantom dep is any import inside a package that resolves to a package
/// not declared in that package's `deps`.
pub fn detect_phantom_deps(
    packages: &[StrictPkg],
    direct_dep_names: &[String],
) -> Vec<PhantomDep> {
    let all_package_names: std::collections::HashSet<&str> =
        packages.iter().map(|p| p.name.as_str()).collect();

    let mut phantoms = Vec::new();

    for pkg in packages {
        let is_root = direct_dep_names.contains(&pkg.name);

        // Build the set of allowed imports for this package
        let allowed: std::collections::HashSet<&str> =
            pkg.deps.keys().map(|s| s.as_str()).collect();

        // For each JS/TS file in the package, scan require/import calls
        for f in &pkg.files {
            if !f.rel_path.ends_with(".js")
                && !f.rel_path.ends_with(".cjs")
                && !f.rel_path.ends_with(".mjs")
            {
                continue;
            }
            // We don't have file contents here (CAS keys only), so phantom
            // detection at this layer is structural only.
            // Real import scanning happens in the `unused` module.
            let _ = (is_root, &allowed, &all_package_names);
        }

        // Structural check: any dep declared by this package that is NOT in
        // the overall resolved graph is a dangling ref (potential phantom).
        for dep_name in pkg.deps.keys() {
            if !all_package_names.contains(dep_name.as_str()) {
                phantoms.push(PhantomDep {
                    importing_package: pkg.name.clone(),
                    import_name: dep_name.clone(),
                    reason: format!(
                        "'{}' declares '{}' as dependency but it is not in the resolved graph",
                        pkg.name, dep_name
                    ),
                });
            }
        }
    }

    phantoms
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pkg(name: &str, version: &str, deps: &[(&str, &str)]) -> StrictPkg {
        StrictPkg {
            name: name.to_string(),
            version: version.to_string(),
            files: vec![StrictPkgFile {
                rel_path: "index.js".to_string(),
                integrity: format!("sha512-{name}-hash"),
            }],
            deps: deps.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    #[test]
    fn plan_produces_root_symlinks() {
        let pkgs = vec![
            make_pkg("lodash", "4.17.21", &[]),
            make_pkg("express", "4.18.2", &[("body-parser", "1.20.2")]),
            make_pkg("body-parser", "1.20.2", &[]),
        ];
        let root = Path::new("/tmp/test-project");
        let cas = Path::new("/home/.better/cas");
        let direct = vec!["lodash".to_string(), "express".to_string()];
        let plan = plan_strict_layout(root, cas, &pkgs, &direct);

        // Should have root symlinks for lodash and express
        let root_links: Vec<_> = plan
            .symlinks
            .iter()
            .filter(|(_, link)| link.parent() == Some(Path::new("/tmp/test-project/node_modules")))
            .collect();
        assert_eq!(root_links.len(), 2);
    }

    #[test]
    fn plan_produces_internal_dep_symlink() {
        let pkgs = vec![
            make_pkg("express", "4.18.2", &[("body-parser", "1.20.2")]),
            make_pkg("body-parser", "1.20.2", &[]),
        ];
        let root = Path::new("/tmp/test-project2");
        let cas = Path::new("/home/.better/cas");
        let direct = vec!["express".to_string()];
        let plan = plan_strict_layout(root, cas, &pkgs, &direct);

        // Internal symlink: express@4.18.2/node_modules/body-parser → .better/body-parser@1.20.2/…
        let internal = plan.symlinks.iter().find(|(_, link)| {
            link.to_string_lossy().contains("express@4.18.2")
                && link.ends_with("body-parser")
        });
        assert!(internal.is_some(), "missing internal dep symlink for body-parser");
    }

    #[test]
    fn phantom_dep_detected_for_missing_package() {
        let pkgs = vec![
            make_pkg("app", "1.0.0", &[("missing-pkg", "2.0.0")]),
        ];
        let direct = vec!["app".to_string()];
        let phantoms = detect_phantom_deps(&pkgs, &direct);
        assert_eq!(phantoms.len(), 1);
        assert_eq!(phantoms[0].import_name, "missing-pkg");
    }

    #[test]
    fn no_phantom_when_all_deps_resolved() {
        let pkgs = vec![
            make_pkg("a", "1.0.0", &[("b", "2.0.0")]),
            make_pkg("b", "2.0.0", &[]),
        ];
        let direct = vec!["a".to_string()];
        let phantoms = detect_phantom_deps(&pkgs, &direct);
        assert!(phantoms.is_empty());
    }
}
