use std::path::Path;

use super::{
    EngineError, EngineErrorKind, Ecosystem, FetchResult as EngineFetchResult,
    LockGraph, OutdatedPackage, PackageEngine, ResolvedNode, Vulnerability,
};

/// npm / Node.js package engine.
///
/// Delegates to the existing functions in `fetch.rs`, `audit.rs`,
/// `outdated.rs`, etc. so the trait is a thin adapter layer over the
/// battle-tested code that already ships.
pub struct NpmEngine;

impl PackageEngine for NpmEngine {
    fn name(&self) -> &str {
        "npm"
    }

    fn manifest_files(&self) -> &[&str] {
        &["package.json"]
    }

    fn detect(&self, project_root: &Path) -> bool {
        project_root.join("package.json").exists()
    }

    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError> {
        let lockfile = project_root.join("package-lock.json");
        if !lockfile.exists() {
            return Err(EngineError {
                message: format!("No package-lock.json found in {}", project_root.display()),
                kind: EngineErrorKind::LockfileNotFound,
            });
        }

        let result = crate::resolve_from_lockfile(&lockfile).map_err(|e| EngineError {
            message: e,
            kind: EngineErrorKind::ResolutionFailed,
        })?;

        let packages: Vec<ResolvedNode> = result
            .packages
            .iter()
            .map(|p| ResolvedNode {
                name: p.name.clone(),
                version: p.version.clone(),
                integrity: Some(p.integrity.clone()),
                resolved_url: Some(p.resolved_url.clone()),
                ecosystem: Ecosystem::Npm,
            })
            .collect();

        Ok(LockGraph {
            packages,
            edges: Vec::new(), // Edge resolution requires deeper lockfile parsing; deferred.
        })
    }

    fn fetch(
        &self,
        graph: &LockGraph,
        cache_dir: &Path,
    ) -> Result<Vec<EngineFetchResult>, EngineError> {
        // Build npm-native ResolvedPackage list from the graph.
        // The existing fetch_packages expects the npm-specific types from
        // types.rs, so we reconstruct them.
        let npm_packages: Vec<crate::types::ResolvedPackage> = graph
            .packages
            .iter()
            .map(|node| crate::types::ResolvedPackage {
                name: node.name.clone(),
                version: node.version.clone(),
                rel_path: format!("node_modules/{}", node.name),
                resolved_url: node.resolved_url.clone().unwrap_or_default(),
                integrity: node.integrity.clone().unwrap_or_default(),
            })
            .collect();

        let npmrc = crate::parse_npmrc(cache_dir.parent().unwrap_or(cache_dir));

        let result =
            crate::fetch_packages(&npm_packages, cache_dir, Some(&npmrc)).map_err(|e| {
                EngineError {
                    message: e,
                    kind: EngineErrorKind::FetchFailed,
                }
            })?;

        Ok(vec![EngineFetchResult {
            name: "npm-batch".to_string(),
            version: String::new(),
            cached: result.packages_cached > 0 && result.packages_fetched == 0,
            bytes_downloaded: result.bytes_downloaded,
        }])
    }

    fn materialize(
        &self,
        _packages: &[EngineFetchResult],
        _target: &Path,
    ) -> Result<(), EngineError> {
        // Materialization for npm is handled by the install pipeline in
        // main.rs (clonefile → file-CAS → fallback materialize_tree).
        // This is intentionally a no-op stub; the full install flow is
        // orchestrated at the CLI layer until we refactor it behind
        // this trait completely.
        Ok(())
    }

    fn audit(&self, graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
        // The existing run_audit reads from the lockfile directly.
        // We build a temporary lockfile-like view or just call the
        // audit with a dummy path — but the real function needs a
        // lockfile path. For now, we convert our graph into the
        // info that the OSV API needs.
        //
        // This is a bridge: the proper approach is to make audit
        // work from the LockGraph directly. For now we return an
        // empty list (audit is available via the CLI command which
        // calls run_audit directly).
        let _ = graph;
        Ok(Vec::new())
    }

    fn outdated(&self, project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
        let lockfile = project_root.join("package-lock.json");
        if !lockfile.exists() {
            return Err(EngineError {
                message: "No package-lock.json found".to_string(),
                kind: EngineErrorKind::LockfileNotFound,
            });
        }

        let report =
            crate::check_outdated(project_root, &lockfile).map_err(|e| EngineError {
                message: e,
                kind: EngineErrorKind::ResolutionFailed,
            })?;

        Ok(report
            .packages
            .into_iter()
            .map(|entry| OutdatedPackage {
                name: entry.name,
                current: entry.current,
                latest: entry.latest,
                update_type: entry.update_type,
            })
            .collect())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::PackageEngine;

    #[test]
    fn name_is_npm() {
        assert_eq!(NpmEngine.name(), "npm");
    }

    #[test]
    fn manifest_files_contains_package_json() {
        assert!(NpmEngine.manifest_files().contains(&"package.json"));
    }

    #[test]
    fn detect_false_without_package_json() {
        let tmp = std::env::temp_dir().join("npm-engine-test-nopkg");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!NpmEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_true_with_package_json() {
        let tmp = std::env::temp_dir().join("npm-engine-test-haspkg");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), r#"{"name":"test"}"#).unwrap();
        assert!(NpmEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_missing_lockfile_errors() {
        let tmp = std::env::temp_dir().join("npm-engine-test-nolock");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), r#"{"name":"test"}"#).unwrap();
        let result = NpmEngine.resolve(&tmp);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
