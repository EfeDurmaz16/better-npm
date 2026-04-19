use std::path::Path;
use super::{PackageEngine, LockGraph, ResolvedNode, FetchResult, Vulnerability, OutdatedPackage, EngineError, EngineErrorKind, Ecosystem};

pub struct PhpEngine;

impl PackageEngine for PhpEngine {
    fn name(&self) -> &str { "php" }
    fn manifest_files(&self) -> &[&str] { &["composer.json"] }
    fn detect(&self, project_root: &Path) -> bool { project_root.join("composer.json").exists() }

    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError> {
        let lockfile = project_root.join("composer.lock");
        if !lockfile.exists() { return Ok(LockGraph { packages: vec![], edges: vec![] }); }
        let content = std::fs::read_to_string(&lockfile)
            .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::LockfileNotFound })?;
        let v: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::ResolutionFailed })?;
        let mut packages = Vec::new();
        let empty = vec![];
        for pkg in v["packages"].as_array().unwrap_or(&empty).iter()
            .chain(v["packages-dev"].as_array().unwrap_or(&empty).iter()) {
            let name = pkg["name"].as_str().unwrap_or("").to_string();
            let version = pkg["version"].as_str().unwrap_or("").trim_start_matches('v').to_string();
            if !name.is_empty() {
                packages.push(ResolvedNode { name, version, integrity: None, resolved_url: None, ecosystem: Ecosystem::Php });
            }
        }
        Ok(LockGraph { packages, edges: vec![] })
    }

    fn fetch(&self, graph: &LockGraph, _: &Path) -> Result<Vec<FetchResult>, EngineError> {
        Ok(graph.packages.iter().map(|p| FetchResult { name: p.name.clone(), version: p.version.clone(), cached: true, bytes_downloaded: 0, artifact_path: None }).collect())
    }

    fn materialize(&self, _: &[FetchResult], _: &Path) -> Result<(), EngineError> { Ok(()) }

    fn audit(&self, graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
        if graph.packages.is_empty() { return Ok(vec![]); }
        let mut body = String::from(r#"{"queries":["#);
        let mut first = true;
        for pkg in &graph.packages {
            if !first { body.push(','); }
            first = false;
            body.push_str(&format!(r#"{{"package":{{"name":"{}","ecosystem":"Packagist"}},"version":"{}"}}"#, pkg.name, pkg.version));
        }
        body.push_str("]}");
        let client = reqwest::blocking::Client::builder().use_rustls_tls().timeout(std::time::Duration::from_secs(30)).build()
            .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::NetworkError })?;
        let resp = client.post("https://api.osv.dev/v1/querybatch").header("Content-Type","application/json").body(body).send()
            .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::NetworkError })?
            .text().map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::NetworkError })?;
        let mut vulns = Vec::new();
        if resp.contains("\"id\"") {
            for id in resp.split("\"id\":").skip(1).filter_map(|s| s.split('"').nth(1)) {
                vulns.push(Vulnerability { id: id.to_string(), summary: "See https://osv.dev".to_string(), severity: "UNKNOWN".to_string(), package: "unknown".to_string(), version: "unknown".to_string(), fixed_in: None });
            }
        }
        Ok(vulns)
    }

    fn outdated(&self, _: &Path) -> Result<Vec<OutdatedPackage>, EngineError> { Ok(vec![]) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::PackageEngine;

    #[test]
    fn name_is_php() {
        assert_eq!(PhpEngine.name(), "php");
    }

    #[test]
    fn detect_false_without_composer_json() {
        let tmp = std::env::temp_dir().join("php-engine-test-nofile");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!PhpEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_true_with_composer_json() {
        let tmp = std::env::temp_dir().join("php-engine-test-hasfile");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("composer.json"), r#"{"name":"test/pkg"}"#).unwrap();
        assert!(PhpEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_no_composer_lock_returns_empty() {
        let tmp = std::env::temp_dir().join("php-engine-test-nolock");
        std::fs::create_dir_all(&tmp).unwrap();
        let graph = PhpEngine.resolve(&tmp).unwrap();
        assert!(graph.packages.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
