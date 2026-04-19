pub mod extract;
pub mod fetch;
pub mod manifest;
pub mod migrate;
pub mod pypi;
pub mod requirements;
pub mod resolver;
pub mod specifier;
pub mod version;
pub mod wheel;

use std::path::Path;

use super::{
    EngineError, EngineErrorKind, Ecosystem, FetchResult as EngineFetchResult,
    LockGraph, OutdatedPackage, PackageEngine, ResolvedNode, Vulnerability,
};

/// Python package engine.
///
/// Implements the `PackageEngine` trait for PyPI packages.
/// Supports pyproject.toml (PEP 621) and requirements.txt manifests.
pub struct PythonEngine;

impl PythonEngine {
    pub fn new() -> Self {
        Self
    }
}

impl PackageEngine for PythonEngine {
    fn name(&self) -> &str {
        "python"
    }

    fn manifest_files(&self) -> &[&str] {
        &["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"]
    }

    fn detect(&self, project_root: &Path) -> bool {
        project_root.join("pyproject.toml").exists()
            || project_root.join("requirements.txt").exists()
            || project_root.join("setup.py").exists()
            || project_root.join("setup.cfg").exists()
    }

    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError> {
        // Determine manifest type and parse dependencies
        let deps = if project_root.join("pyproject.toml").exists() {
            let manifest = manifest::PyProjectManifest::parse_file(
                &project_root.join("pyproject.toml"),
            )
            .map_err(|e| EngineError {
                message: e,
                kind: EngineErrorKind::ManifestNotFound,
            })?;
            manifest.dependencies
        } else if project_root.join("requirements.txt").exists() {
            let req_file = requirements::RequirementsFile::parse_file(
                &project_root.join("requirements.txt"),
            )
            .map_err(|e| EngineError {
                message: e,
                kind: EngineErrorKind::ManifestNotFound,
            })?;
            req_file.packages
        } else {
            return Err(EngineError {
                message: "No Python manifest found (pyproject.toml or requirements.txt)"
                    .to_string(),
                kind: EngineErrorKind::ManifestNotFound,
            });
        };

        // Resolve using the backtracking resolver
        let env = manifest::MarkerEnvironment::detect("3.12");
        let mut res = resolver::Resolver::new(env);
        let result = res.resolve(&deps).map_err(|e| EngineError {
            message: format!("{:?}", e),
            kind: EngineErrorKind::ResolutionFailed,
        })?;

        let packages: Vec<ResolvedNode> = result
            .packages
            .iter()
            .map(|p| ResolvedNode {
                name: p.name.clone(),
                version: p.version.normalize(),
                integrity: Some(format!("sha256-{}", p.sha256)),
                resolved_url: Some(p.download_url.clone()),
                ecosystem: Ecosystem::Python,
            })
            .collect();

        Ok(LockGraph {
            packages,
            edges: Vec::new(),
        })
    }

    fn fetch(
        &self,
        graph: &LockGraph,
        cache_dir: &Path,
    ) -> Result<Vec<EngineFetchResult>, EngineError> {
        let cas_root = cache_dir.join("cas");
        let _platform = wheel::PlatformTags::detect("3.12");
        let mut results = Vec::new();

        for node in &graph.packages {
            if node.ecosystem != Ecosystem::Python {
                continue;
            }
            let sha256 = node
                .integrity
                .as_ref()
                .and_then(|i| i.strip_prefix("sha256-"))
                .unwrap_or("");
            let url = node.resolved_url.as_deref().unwrap_or("");

            if sha256.is_empty() || url.is_empty() {
                continue;
            }

            let filename = url.rsplit('/').next().unwrap_or("unknown");
            let release_file = pypi::ReleaseFile {
                filename: filename.to_string(),
                url: url.to_string(),
                size: 0,
                digests: pypi::FileDigests {
                    sha256: sha256.to_string(),
                    md5: None,
                },
                requires_python: None,
                packagetype: if filename.ends_with(".whl") {
                    pypi::PackageType::BdistWheel
                } else {
                    pypi::PackageType::Sdist
                },
                python_version: None,
                yanked: false,
                yanked_reason: None,
            };

            let cached = fetch::cas_hit(&cas_root, sha256);
            let artifact_path = fetch::pypi_cas_path(&cas_root, sha256);
            let bytes = if !cached {
                match fetch::download_and_verify(&release_file, &cas_root) {
                    Ok(_) => release_file.size,
                    Err(e) => {
                        return Err(EngineError {
                            message: e,
                            kind: EngineErrorKind::FetchFailed,
                        });
                    }
                }
            } else {
                0
            };

            results.push(EngineFetchResult {
                name: node.name.clone(),
                version: node.version.clone(),
                cached,
                bytes_downloaded: bytes,
                artifact_path: Some(artifact_path),
            });
        }

        Ok(results)
    }

    fn materialize(
        &self,
        packages: &[EngineFetchResult],
        target: &Path,
    ) -> Result<(), EngineError> {
        let venv_dir = target.join(".venv");
        if !venv_dir.exists() {
            // No .venv present — skip silent; `better install` creates it separately.
            return Ok(());
        }

        // Determine site-packages by finding lib/python*/site-packages under .venv
        let site_packages = find_site_packages(&venv_dir).map_err(|e| EngineError {
            kind: EngineErrorKind::ManifestNotFound,
            message: e,
        })?;
        let bin_dir = if cfg!(windows) {
            venv_dir.join("Scripts")
        } else {
            venv_dir.join("bin")
        };

        for pkg in packages {
            let artifact = match &pkg.artifact_path {
                Some(p) => p.clone(),
                None => continue, // no CAS path recorded — skip
            };

            if !artifact.exists() {
                continue; // CAS miss after fetch — shouldn't happen but be defensive
            }

            let filename = artifact
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            if filename.ends_with(".whl") || artifact.extension().map_or(false, |e| e == "whl") {
                // The CAS stores the raw file bytes; the filename comes from the URL
                extract::extract_wheel(&artifact, &site_packages, &bin_dir).map_err(|e| EngineError {
                    kind: EngineErrorKind::FetchFailed,
                    message: format!("failed to extract {} wheel: {}", pkg.name, e),
                })?;
            }
            // sdist / other artifact types: skip for now (require build toolchain)
        }

        Ok(())
    }

    fn audit(&self, graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
        // Query OSV.dev batch API for PyPI vulnerabilities.
        let py_packages: Vec<_> = graph
            .packages
            .iter()
            .filter(|p| p.ecosystem == Ecosystem::Python)
            .collect();

        if py_packages.is_empty() {
            return Ok(Vec::new());
        }

        // Build OSV batch query JSON
        let mut queries = String::new();
        queries.push('[');
        for (i, pkg) in py_packages.iter().enumerate() {
            if i > 0 {
                queries.push(',');
            }
            queries.push_str(&format!(
                r#"{{"package":{{"name":"{}","ecosystem":"PyPI"}},"version":"{}"}}"#,
                pkg.name, pkg.version
            ));
        }
        queries.push(']');
        let body = format!(r#"{{"queries":{}}}"#, queries);

        let resp = reqwest::blocking::Client::new()
            .post("https://api.osv.dev/v1/querybatch")
            .header("Content-Type", "application/json")
            .body(body)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .map_err(|e| EngineError {
                kind: EngineErrorKind::NetworkError,
                message: format!("OSV query failed: {}", e),
            })?;

        let text = resp.text().map_err(|e| EngineError {
            kind: EngineErrorKind::NetworkError,
            message: format!("OSV response read failed: {}", e),
        })?;

        // Parse response and build Vulnerability list
        parse_osv_batch_response(&text, &py_packages)
    }

    fn outdated(&self, project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
        // Read the installed manifest to get the current set of dependencies.
        let deps = if project_root.join("pyproject.toml").exists() {
            let manifest =
                manifest::PyProjectManifest::parse_file(&project_root.join("pyproject.toml"))
                    .map_err(|e| EngineError {
                        kind: EngineErrorKind::ManifestNotFound,
                        message: e,
                    })?;
            manifest.dependencies
        } else if project_root.join("requirements.txt").exists() {
            let rf = requirements::RequirementsFile::parse_file(
                &project_root.join("requirements.txt"),
            )
            .map_err(|e| EngineError {
                kind: EngineErrorKind::ManifestNotFound,
                message: e,
            })?;
            rf.packages
        } else {
            return Ok(Vec::new());
        };

        // For each dependency, fetch the latest version from PyPI and compare.
        let mut outdated = Vec::new();
        for dep in &deps {
            let info = match pypi::fetch_package_info(&dep.name) {
                Ok(i) => i,
                Err(_) => continue, // network issues — skip this package
            };

            let latest = match info.versions.iter().filter(|v| !v.is_prerelease()).max() {
                Some(v) => v.normalize(),
                None => continue,
            };

            // Determine current installed version from the constraint (best-effort: ==)
            let current = dep.constraint.specifiers.iter().find_map(|s| {
                use crate::engine::python::specifier::VersionOp;
                if matches!(s.op, VersionOp::Equal) && !s.wildcard {
                    Some(s.version.normalize())
                } else {
                    None
                }
            });

            let current = match current {
                Some(c) => c,
                None => continue, // can't determine installed version from constraint alone
            };

            if current != latest {
                outdated.push(OutdatedPackage {
                    name: dep.name.clone(),
                    current,
                    latest,
                    update_type: "unknown".to_string(),
                });
            }
        }

        Ok(outdated)
    }

    /// Run a command in the Python virtual environment.
    ///
    /// Looks for `.venv/bin/<command>` first, then falls back to PATH.
    /// Loads `.env` if present. Activates the venv by setting VIRTUAL_ENV
    /// and prepending `.venv/bin` to PATH.
    fn run(&self, command: &str, args: &[String], project_root: &Path) -> Result<i32, EngineError> {
        let venv_dir = project_root.join(".venv");

        // Build env vars: activate venv if it exists
        let mut extra_env: Vec<(String, String)> = Vec::new();
        let cmd_path = if venv_dir.exists() {
            let bin_dir = venv_dir.join("bin");
            // Set VIRTUAL_ENV so Python picks up the venv
            extra_env.push(("VIRTUAL_ENV".to_string(), venv_dir.display().to_string()));
            // Prepend venv bin to PATH
            let current_path = std::env::var("PATH").unwrap_or_default();
            extra_env.push(("PATH".to_string(), format!("{}:{}", bin_dir.display(), current_path)));
            // Try venv bin first
            let venv_cmd = bin_dir.join(command);
            if venv_cmd.exists() {
                venv_cmd.display().to_string()
            } else {
                command.to_string()
            }
        } else {
            command.to_string()
        };

        // Load .env file
        let dotenv_vars = load_dotenv(project_root);
        extra_env.extend(dotenv_vars);

        let status = std::process::Command::new(&cmd_path)
            .args(args)
            .current_dir(project_root)
            .envs(extra_env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .status()
            .map_err(|e| EngineError {
                kind: EngineErrorKind::FetchFailed,
                message: format!("failed to run '{}': {}", command, e),
            })?;

        Ok(status.code().unwrap_or(1))
    }
}

/// Parse a `.env` file into key=value pairs.
/// Find the `site-packages` directory inside a virtualenv.
///
/// Looks for `.venv/lib/python3.X/site-packages` and returns the first one
/// found.  Falls back to creating `lib/site-packages` if nothing is found.
fn find_site_packages(venv_dir: &Path) -> Result<std::path::PathBuf, String> {
    let lib_dir = venv_dir.join("lib");
    if lib_dir.exists() {
        if let Ok(read) = std::fs::read_dir(&lib_dir) {
            for entry in read.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("python") {
                    let sp = entry.path().join("site-packages");
                    if sp.exists() || std::fs::create_dir_all(&sp).is_ok() {
                        return Ok(sp);
                    }
                }
            }
        }
    }
    // Fallback: use a flat site-packages directly under .venv/lib
    let fallback = lib_dir.join("site-packages");
    std::fs::create_dir_all(&fallback)
        .map_err(|e| format!("failed to create site-packages: {}", e))?;
    Ok(fallback)
}

/// Parse an OSV.dev `/v1/querybatch` JSON response into `Vulnerability` entries.
fn parse_osv_batch_response(
    text: &str,
    packages: &[&super::ResolvedNode],
) -> Result<Vec<Vulnerability>, EngineError> {
    // OSV response shape:
    // { "results": [ { "vulns": [ { "id": "...", "summary": "...", "severity": [...] } ] }, … ] }
    let mut vulns: Vec<Vulnerability> = Vec::new();

    let results_start = match text.find("\"results\"") {
        Some(i) => i,
        None => return Ok(vulns),
    };

    // Walk through each result entry (one per query)
    let results_json = &text[results_start..];
    let mut pkg_idx = 0usize;
    let mut remaining = results_json;

    while let Some(vuln_start) = remaining.find("\"vulns\"") {
        let vuln_section = &remaining[vuln_start..];
        // Find all "id" fields in this vuln array
        let bracket_start = match vuln_section.find('[') {
            Some(i) => i,
            None => break,
        };
        let array_json = &vuln_section[bracket_start..];
        let bracket_end = find_matching_bracket(array_json).unwrap_or(array_json.len());
        let array = &array_json[..bracket_end];

        let pkg_name = packages.get(pkg_idx).map(|p| p.name.as_str()).unwrap_or("unknown");
        let pkg_ver = packages.get(pkg_idx).map(|p| p.version.as_str()).unwrap_or("");

        // Extract IDs and summaries from the array
        let mut search = array;
        while let Some(id_pos) = search.find("\"id\"") {
            let after = &search[id_pos + 4..];
            if let Some(colon) = after.find(':') {
                let val_part = after[colon + 1..].trim_start();
                if val_part.starts_with('"') {
                    let end = val_part[1..].find('"').unwrap_or(val_part.len() - 1);
                    let id = &val_part[1..end + 1];

                    // Extract summary (best-effort)
                    let summary = extract_json_string(search, "summary").unwrap_or_default();
                    let severity = extract_json_string(search, "severity").unwrap_or_else(|| "UNKNOWN".to_string());

                    vulns.push(Vulnerability {
                        id: id.to_string(),
                        summary,
                        severity,
                        package: pkg_name.to_string(),
                        version: pkg_ver.to_string(),
                        fixed_in: None,
                    });

                    search = &search[id_pos + id.len()..];
                    continue;
                }
            }
            search = &search[id_pos + 4..];
        }

        pkg_idx += 1;
        remaining = &remaining[vuln_start + 6..];
    }

    Ok(vulns)
}

/// Extract a JSON string field value (simple, non-recursive).
fn extract_json_string(haystack: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let pos = haystack.find(&needle)?;
    let after = &haystack[pos + needle.len()..];
    let colon = after.find(':')?;
    let val = after[colon + 1..].trim_start();
    if !val.starts_with('"') {
        return None;
    }
    let end = val[1..].find('"')?;
    Some(val[1..end + 1].to_string())
}

/// Find the position of the matching closing bracket for a JSON array starting with '['.
fn find_matching_bracket(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (i, c) in s.char_indices() {
        if escape { escape = false; continue; }
        if c == '\\' && in_string { escape = true; continue; }
        if c == '"' { in_string = !in_string; continue; }
        if in_string { continue; }
        match c {
            '[' | '{' => depth += 1,
            ']' | '}' => {
                depth -= 1;
                if depth == 0 { return Some(i + 1); }
            }
            _ => {}
        }
    }
    None
}

fn load_dotenv(project_root: &Path) -> Vec<(String, String)> {
    let path = project_root.join(".env");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    content
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
        .filter_map(|l| {
            let (k, v) = l.split_once('=')?;
            let k = k.trim().to_string();
            let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
            Some((k, v))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::PackageEngine;

    #[test]
    fn name_is_python() {
        assert_eq!(PythonEngine::new().name(), "python");
    }

    #[test]
    fn manifest_files_contains_pyproject_toml() {
        assert!(PythonEngine::new().manifest_files().contains(&"pyproject.toml"));
    }

    #[test]
    fn manifest_files_contains_requirements_txt() {
        assert!(PythonEngine::new().manifest_files().contains(&"requirements.txt"));
    }

    #[test]
    fn detect_false_without_any_manifest() {
        let tmp = std::env::temp_dir().join("python-engine-test-nofile");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!PythonEngine::new().detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_true_with_requirements_txt() {
        let tmp = std::env::temp_dir().join("python-engine-test-req");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("requirements.txt"), "flask>=2.0\n").unwrap();
        assert!(PythonEngine::new().detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_true_with_pyproject_toml() {
        let tmp = std::env::temp_dir().join("python-engine-test-pyproject");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("pyproject.toml"), "[project]\nname = \"myapp\"\n").unwrap();
        assert!(PythonEngine::new().detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn materialize_returns_ok() {
        let tmp = std::env::temp_dir().join("python-engine-test-mat");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(PythonEngine::new().materialize(&[], &tmp).is_ok());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn audit_returns_empty_vec() {
        let graph = LockGraph { packages: vec![], edges: vec![] };
        assert!(PythonEngine::new().audit(&graph).unwrap().is_empty());
    }
}
