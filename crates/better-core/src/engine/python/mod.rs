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
            });
        }

        Ok(results)
    }

    fn materialize(
        &self,
        _packages: &[EngineFetchResult],
        _target: &Path,
    ) -> Result<(), EngineError> {
        // Materialization into venv site-packages is deferred to the venv task.
        Ok(())
    }

    fn audit(&self, _graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
        // Python audit via OSV/PyPI advisory DB — deferred.
        Ok(Vec::new())
    }

    fn outdated(&self, project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
        // Parse manifest, compare with latest PyPI versions — deferred.
        let _ = project_root;
        Ok(Vec::new())
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
