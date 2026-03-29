pub mod version;
pub mod specifier;
pub mod manifest;
pub mod requirements;
pub mod pypi;
pub mod wheel;
pub mod fetch;
pub mod resolver;

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
}
