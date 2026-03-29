use super::*;
use std::path::Path;

/// Generate context for all installed packages in parallel.
pub fn generate_all(
    project_root: &Path,
    cache_root: &Path,
    force: bool,
) -> Result<BulkContextResult, String> {
    let start = std::time::Instant::now();

    let mut work_items: Vec<WorkItem> = Vec::new();
    let mut cached_count = 0usize;

    // Scan node_modules for npm packages
    let nm_dir = project_root.join("node_modules");
    if nm_dir.exists() {
        if let Ok(packages) = crate::list_packages_in_node_modules(&nm_dir) {
            for pkg_path in &packages {
                if let Some((name, version)) = crate::read_package_identity(pkg_path) {
                    let cp = cache::cache_path("npm", &name, &version);
                    if !force && cp.exists() {
                        cached_count += 1;
                        continue;
                    }
                    work_items.push(WorkItem {
                        ecosystem: "npm".to_string(),
                        name,
                        version,
                        package_root: pkg_path.clone(),
                        cache_path: cp,
                    });
                }
            }
        }
    }

    // Scan Python venv site-packages
    let venv_lib = project_root.join(".venv/lib");
    if venv_lib.exists() {
        if let Ok(entries) = std::fs::read_dir(&venv_lib) {
            for entry in entries.flatten() {
                let sp = entry.path().join("site-packages");
                if !sp.exists() {
                    continue;
                }
                if let Ok(pkgs) = std::fs::read_dir(&sp) {
                    for pkg_entry in pkgs.flatten() {
                        let pkg_path = pkg_entry.path();
                        if !pkg_path.is_dir() {
                            continue;
                        }
                        let name = pkg_entry.file_name().to_string_lossy().to_string();
                        if name.starts_with('_') || name.ends_with(".dist-info") || name.ends_with(".egg-info") {
                            continue;
                        }
                        let version = python::read_python_version(&pkg_path)
                            .unwrap_or_else(|| "0.0.0".to_string());
                        let cp = cache::cache_path("python", &name, &version);
                        if !force && cp.exists() {
                            cached_count += 1;
                            continue;
                        }
                        work_items.push(WorkItem {
                            ecosystem: "python".to_string(),
                            name,
                            version,
                            package_root: pkg_path,
                            cache_path: cp,
                        });
                    }
                }
            }
        }
    }

    // Generate in parallel using rayon
    use rayon::prelude::*;
    let results: Vec<Result<String, (String, String)>> = work_items
        .par_iter()
        .map(|item| {
            let result = match item.ecosystem.as_str() {
                "npm" => js::extract_js_context(&item.package_root, &item.name, &item.version),
                "python" => python::extract_python_context(&item.package_root, &item.name, &item.version),
                _ => Err(format!("unsupported ecosystem: {}", item.ecosystem)),
            };

            match result {
                Ok(ctx) => {
                    // Write to cache
                    cache::write_cached(
                        &item.ecosystem,
                        &item.name,
                        &item.version,
                        &ctx.markdown,
                        false,
                    )
                    .ok();
                    Ok(item.name.clone())
                }
                Err(e) => Err((item.name.clone(), e)),
            }
        })
        .collect();

    let generated = results.iter().filter(|r| r.is_ok()).count();
    let failed: Vec<(String, String)> = results
        .into_iter()
        .filter_map(|r| r.err())
        .collect();

    // Also create .better/context/ directory in project
    let project_context_dir = project_root.join(".better").join("context");
    std::fs::create_dir_all(&project_context_dir).ok();

    Ok(BulkContextResult {
        generated,
        cached: cached_count,
        failed,
        total_ms: start.elapsed().as_millis() as u64,
        output_dir: project_context_dir.to_string_lossy().to_string(),
    })
}

struct WorkItem {
    ecosystem: String,
    name: String,
    version: String,
    package_root: std::path::PathBuf,
    cache_path: std::path::PathBuf,
}
