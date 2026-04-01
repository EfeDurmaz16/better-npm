use std::collections::HashSet;
use std::path::Path;

use super::{
    Ecosystem, EngineError, EngineErrorKind, FetchResult, LockGraph, OutdatedPackage,
    PackageEngine, ResolvedNode, Vulnerability,
};

pub struct GoEngine;

impl PackageEngine for GoEngine {
    fn name(&self) -> &str {
        "go"
    }

    fn manifest_files(&self) -> &[&str] {
        &["go.mod"]
    }

    fn detect(&self, project_root: &Path) -> bool {
        project_root.join("go.mod").exists()
    }

    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError> {
        let gomod = project_root.join("go.mod");
        if !gomod.exists() {
            return Err(EngineError {
                message: "go.mod not found".into(),
                kind: EngineErrorKind::ManifestNotFound,
            });
        }

        let mut packages = Vec::new();

        // Parse go.mod for require directives
        let content = std::fs::read_to_string(&gomod).map_err(|e| EngineError {
            message: e.to_string(),
            kind: EngineErrorKind::ManifestNotFound,
        })?;

        let mut in_require_block = false;
        for line in content.lines() {
            let line = line.trim();
            if line == "require (" {
                in_require_block = true;
                continue;
            }
            if in_require_block && line == ")" {
                in_require_block = false;
                continue;
            }
            // Single-line: require github.com/foo/bar v1.2.3
            let parts: Vec<&str> = if in_require_block {
                line.split_whitespace().collect()
            } else if line.starts_with("require ") {
                line["require ".len()..].split_whitespace().collect()
            } else {
                continue;
            };

            if parts.len() >= 2 {
                let module_path = parts[0];
                let version = parts[1].trim_start_matches('v');
                // Skip indirect if marked with // indirect but still add it
                packages.push(ResolvedNode {
                    name: module_path.to_string(),
                    version: version.to_string(),
                    integrity: None,
                    resolved_url: Some(format!("https://proxy.golang.org/{}", module_path)),
                    ecosystem: Ecosystem::Go,
                });
            }
        }

        // Enrich with checksums from go.sum if present
        let gosum = project_root.join("go.sum");
        if gosum.exists() {
            if let Ok(sum_content) = std::fs::read_to_string(&gosum) {
                let mut checksums: std::collections::HashMap<String, String> =
                    std::collections::HashMap::new();
                for sum_line in sum_content.lines() {
                    let parts: Vec<&str> = sum_line.splitn(3, ' ').collect();
                    if parts.len() == 3 {
                        let key =
                            format!("{}@{}", parts[0], parts[1].trim_start_matches('v'));
                        checksums.insert(key, parts[2].to_string());
                    }
                }
                for pkg in &mut packages {
                    let key = format!("{}@{}", pkg.name, pkg.version);
                    if let Some(hash) = checksums.get(&key) {
                        pkg.integrity = Some(hash.clone());
                    }
                }
            }
        }

        Ok(LockGraph {
            packages,
            edges: vec![],
        })
    }

    fn fetch(&self, graph: &LockGraph, _cache_dir: &Path) -> Result<Vec<FetchResult>, EngineError> {
        Ok(graph
            .packages
            .iter()
            .map(|p| FetchResult {
                name: p.name.clone(),
                version: p.version.clone(),
                cached: true,
                bytes_downloaded: 0,
            })
            .collect())
    }

    fn materialize(&self, _packages: &[FetchResult], _target: &Path) -> Result<(), EngineError> {
        // Go manages its module cache — we don't materialize
        Ok(())
    }

    fn audit(&self, graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
        audit_go_packages(graph)
    }

    fn outdated(&self, project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
        check_go_outdated(project_root)
    }
}

/// Query OSV.dev for Go module vulnerabilities.
fn audit_go_packages(graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
    if graph.packages.is_empty() {
        return Ok(vec![]);
    }

    let mut body = String::from(r#"{"queries":["#);
    let mut first = true;
    let mut seen: HashSet<String> = HashSet::new();

    for pkg in &graph.packages {
        let key = format!("{}@{}", pkg.name, pkg.version);
        if !seen.insert(key) {
            continue;
        }
        if !first {
            body.push(',');
        }
        first = false;
        body.push_str(&format!(
            r#"{{"package":{{"name":"{}","ecosystem":"Go"}},"version":"{}"}}"#,
            pkg.name, pkg.version
        ));
    }
    body.push_str("]}");

    let client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| EngineError {
            message: e.to_string(),
            kind: EngineErrorKind::NetworkError,
        })?;

    let resp = client
        .post("https://api.osv.dev/v1/querybatch")
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|e| EngineError {
            message: e.to_string(),
            kind: EngineErrorKind::NetworkError,
        })?
        .text()
        .map_err(|e| EngineError {
            message: e.to_string(),
            kind: EngineErrorKind::NetworkError,
        })?;

    let mut vulns = Vec::new();
    if resp.contains("\"id\"") {
        let ids: Vec<&str> = resp
            .split("\"id\":")
            .skip(1)
            .filter_map(|s| s.split('"').nth(1))
            .collect();
        for id in ids {
            vulns.push(Vulnerability {
                id: id.to_string(),
                summary: "See https://osv.dev".to_string(),
                severity: "UNKNOWN".to_string(),
                package: "unknown".to_string(),
                version: "unknown".to_string(),
                fixed_in: None,
            });
        }
    }

    Ok(vulns)
}

/// Query Go proxy to check for newer module versions.
fn check_go_outdated(project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
    let lock_graph = GoEngine.resolve(project_root)?;

    let client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| EngineError {
            message: e.to_string(),
            kind: EngineErrorKind::NetworkError,
        })?;

    let mut outdated = Vec::new();

    for pkg in lock_graph.packages.iter().take(20) {
        // Go proxy: GET https://proxy.golang.org/{module}/@latest
        let url = format!("https://proxy.golang.org/{}/@latest", pkg.name);
        if let Ok(resp) = client.get(&url).send() {
            if let Ok(text) = resp.text() {
                // Response: {"Version":"v1.2.3","Time":"...","Origin":...}
                if let Some(latest) = text
                    .split("\"Version\":\"v")
                    .nth(1)
                    .and_then(|s| s.split('"').next())
                {
                    if latest != pkg.version.as_str() {
                        let cur_major = pkg.version.split('.').next().unwrap_or("0");
                        let lat_major = latest.split('.').next().unwrap_or("0");
                        let cur_minor = pkg.version.split('.').nth(1).unwrap_or("0");
                        let lat_minor = latest.split('.').nth(1).unwrap_or("0");
                        let update_type = if lat_major != cur_major {
                            "major"
                        } else if lat_minor != cur_minor {
                            "minor"
                        } else {
                            "patch"
                        }
                        .to_string();
                        outdated.push(OutdatedPackage {
                            name: pkg.name.clone(),
                            current: pkg.version.clone(),
                            latest: latest.to_string(),
                            update_type,
                        });
                    }
                }
            }
        }
    }

    Ok(outdated)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::PackageEngine;

    #[test]
    fn name_is_go() {
        assert_eq!(GoEngine.name(), "go");
    }

    #[test]
    fn detect_false_without_go_mod() {
        let tmp = std::env::temp_dir().join("go-engine-test-nomod");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!GoEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_true_with_go_mod() {
        let tmp = std::env::temp_dir().join("go-engine-test-hasmod");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("go.mod"), "module example.com/foo\ngo 1.21\n").unwrap();
        assert!(GoEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_parses_require_block() {
        let tmp = std::env::temp_dir().join("go-engine-test-resolve");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("go.mod"), "module example.com/foo\ngo 1.21\nrequire (\n\tgithub.com/stretchr/testify v1.8.4\n)\n").unwrap();
        let graph = GoEngine.resolve(&tmp).unwrap();
        assert_eq!(graph.packages.len(), 1);
        assert_eq!(graph.packages[0].name, "github.com/stretchr/testify");
        assert_eq!(graph.packages[0].version, "1.8.4");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_missing_go_mod_errors() {
        let result = GoEngine.resolve(std::path::Path::new("/nonexistent-go-project-xyz"));
        assert!(result.is_err());
    }
}
