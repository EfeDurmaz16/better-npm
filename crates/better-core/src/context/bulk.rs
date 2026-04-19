use super::generate_context;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Result of a bulk context-generation run.
#[derive(Debug, serde::Serialize)]
pub struct BulkContextResult {
    /// Packages for which context was newly generated.
    pub generated: usize,
    /// Packages whose context was already cached (skipped).
    pub cached: usize,
    /// Packages that failed with an error message.
    pub failed: Vec<(String, String)>,
    /// Wall-clock milliseconds for the entire operation.
    pub total_ms: u64,
    /// Directory where context files were written.
    pub output_dir: String,
}

/// A single unit of context-generation work.
struct WorkItem {
    ecosystem: String,
    name: String,
    version: String,
    package_root: PathBuf,
    cache_path: PathBuf,
}

/// Generate context for every package installed in the project.
///
/// Reads the installed package list from `node_modules/` (npm) and `.venv/`
/// (Python) inside `project_root`.  Context files are written to
/// `cache_root/context/{ecosystem}/{name}@{version}.md`.
///
/// When `force` is false, packages with an existing cache file are skipped.
/// Generation runs in parallel via rayon.
pub fn generate_all_context(
    project_root: &Path,
    cache_root: &Path,
    force: bool,
) -> Result<BulkContextResult, String> {
    let start = Instant::now();
    let output_dir = cache_root.join("context");

    let mut work_items: Vec<WorkItem> = Vec::new();
    let mut cached = 0usize;

    // --- npm packages (node_modules) ----------------------------------------
    let nm = project_root.join("node_modules");
    if nm.exists() {
        for entry in collect_npm_packages(&nm) {
            let cp = context_cache_path(&output_dir, "npm", &entry.0, &entry.1);
            if !force && cp.exists() {
                cached += 1;
            } else {
                work_items.push(WorkItem {
                    ecosystem: "npm".to_string(),
                    name: entry.0.clone(),
                    version: entry.1.clone(),
                    package_root: nm.join(&entry.0),
                    cache_path: cp,
                });
            }
        }
    }

    // --- Python packages (site-packages) ------------------------------------
    let venv_sp = find_venv_site_packages(project_root);
    if let Some(sp) = venv_sp {
        for entry in collect_python_packages(&sp) {
            let cp = context_cache_path(&output_dir, "python", &entry.0, &entry.1);
            if !force && cp.exists() {
                cached += 1;
            } else {
                work_items.push(WorkItem {
                    ecosystem: "python".to_string(),
                    name: entry.0.clone(),
                    version: entry.1.clone(),
                    package_root: sp.join(&entry.0),
                    cache_path: cp,
                });
            }
        }
    }

    // --- Parallel generation (rayon) ----------------------------------------
    use rayon::prelude::*;

    let results: Vec<Result<(), (String, String)>> = work_items
        .par_iter()
        .map(|item| {
            // generate_context(project_root, package_name, ecosystem)
            // For installed packages, pass package_root as the project_root so
            // the generator can find node_modules/<name> or site-packages/<name>.
            let eco = item.ecosystem.as_str();
            let ctx = generate_context(&item.package_root.parent().unwrap_or(&item.package_root), &item.name, Some(eco))
                .map_err(|e| (item.name.clone(), e))?;

            // Write markdown to cache
            if let Some(parent) = item.cache_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| (item.name.clone(), e.to_string()))?;
            }
            std::fs::write(&item.cache_path, ctx.markdown.as_bytes())
                .map_err(|e| (item.name.clone(), e.to_string()))?;
            Ok(())
        })
        .collect();

    let mut generated = 0usize;
    let mut failed: Vec<(String, String)> = Vec::new();
    for r in results {
        match r {
            Ok(_) => generated += 1,
            Err(e) => failed.push(e),
        }
    }

    Ok(BulkContextResult {
        generated,
        cached,
        failed,
        total_ms: start.elapsed().as_millis() as u64,
        output_dir: output_dir.to_string_lossy().into_owned(),
    })
}

// ---------------------------------------------------------------------------
// Package discovery helpers
// ---------------------------------------------------------------------------

fn context_cache_path(output_dir: &Path, ecosystem: &str, name: &str, version: &str) -> PathBuf {
    output_dir
        .join(ecosystem)
        .join(format!("{}@{}.md", name, version))
}

/// Enumerate npm packages from node_modules: returns (name, version) pairs.
fn collect_npm_packages(node_modules: &Path) -> Vec<(String, String)> {
    let mut pkgs = Vec::new();
    let Ok(entries) = std::fs::read_dir(node_modules) else {
        return pkgs;
    };

    for entry in entries.flatten() {
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy();

        if name.starts_with('.') {
            continue;
        }

        if name.starts_with('@') {
            // Scoped package: descend one more level
            if let Ok(sub) = std::fs::read_dir(entry.path()) {
                for sub_entry in sub.flatten() {
                    let sub_name = sub_entry.file_name().to_string_lossy().into_owned();
                    let full_name = format!("{}/{}", name, sub_name);
                    if let Some(ver) = read_pkg_version(&sub_entry.path()) {
                        pkgs.push((full_name, ver));
                    }
                }
            }
        } else if let Some(ver) = read_pkg_version(&entry.path()) {
            pkgs.push((name.into_owned(), ver));
        }
    }

    pkgs
}

fn read_pkg_version(pkg_dir: &Path) -> Option<String> {
    let pj = pkg_dir.join("package.json");
    let content = std::fs::read_to_string(&pj).ok()?;
    // Quick scan for "version" field without full parse
    let key = "\"version\"";
    let pos = content.find(key)?;
    let after = &content[pos + key.len()..];
    let colon = after.find(':')?;
    let val = after[colon + 1..].trim_start();
    if val.starts_with('"') {
        let end = val[1..].find('"')?;
        Some(val[1..end + 1].to_string())
    } else {
        None
    }
}

/// Find the site-packages directory in .venv.
fn find_venv_site_packages(project_root: &Path) -> Option<PathBuf> {
    let lib = project_root.join(".venv").join("lib");
    if !lib.exists() {
        return None;
    }
    for entry in std::fs::read_dir(&lib).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("python") {
            let sp = entry.path().join("site-packages");
            if sp.exists() {
                return Some(sp);
            }
        }
    }
    None
}

/// Enumerate Python packages by scanning for .dist-info directories.
fn collect_python_packages(site_packages: &Path) -> Vec<(String, String)> {
    let mut pkgs = Vec::new();
    let Ok(entries) = std::fs::read_dir(site_packages) else {
        return pkgs;
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".dist-info") {
            // "{name}-{version}.dist-info"
            let stem = name.trim_end_matches(".dist-info");
            if let Some(dash) = stem.rfind('-') {
                let pkg_name = stem[..dash].replace('-', "_").to_lowercase();
                let version = stem[dash + 1..].to_string();
                if !pkg_name.is_empty() && !version.is_empty() {
                    pkgs.push((pkg_name, version));
                }
            }
        }
    }
    pkgs
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_cache_path_npm() {
        let dir = std::path::PathBuf::from("/cache");
        let p = context_cache_path(&dir, "npm", "lodash", "4.17.21");
        assert_eq!(p, std::path::PathBuf::from("/cache/npm/lodash@4.17.21.md"));
    }

    #[test]
    fn context_cache_path_python() {
        let dir = std::path::PathBuf::from("/cache");
        let p = context_cache_path(&dir, "python", "requests", "2.31.0");
        assert_eq!(p, std::path::PathBuf::from("/cache/python/requests@2.31.0.md"));
    }

    #[test]
    fn collect_python_packages_finds_dist_info() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("requests-2.31.0.dist-info")).unwrap();
        std::fs::create_dir(tmp.path().join("flask-3.0.0.dist-info")).unwrap();
        std::fs::create_dir(tmp.path().join("not_a_package")).unwrap();

        let pkgs = collect_python_packages(tmp.path());
        assert_eq!(pkgs.len(), 2);
        assert!(pkgs.iter().any(|(n, _)| n == "requests"));
        assert!(pkgs.iter().any(|(n, _)| n == "flask"));
    }

    #[test]
    fn collect_npm_packages_reads_package_json() {
        let tmp = tempfile::tempdir().unwrap();
        let pkg_dir = tmp.path().join("lodash");
        std::fs::create_dir(&pkg_dir).unwrap();
        std::fs::write(
            pkg_dir.join("package.json"),
            r#"{"name":"lodash","version":"4.17.21"}"#,
        )
        .unwrap();

        let pkgs = collect_npm_packages(tmp.path());
        assert_eq!(pkgs.len(), 1);
        assert_eq!(pkgs[0].0, "lodash");
        assert_eq!(pkgs[0].1, "4.17.21");
    }

    #[test]
    fn collect_npm_packages_skips_dot_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(".cache")).unwrap();
        let pkgs = collect_npm_packages(tmp.path());
        assert!(pkgs.is_empty());
    }

    #[test]
    fn generate_all_context_no_node_modules_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache");
        let result = generate_all_context(tmp.path(), &cache, false).unwrap();
        assert_eq!(result.generated, 0);
        assert_eq!(result.cached, 0);
        assert!(result.failed.is_empty());
    }
}
