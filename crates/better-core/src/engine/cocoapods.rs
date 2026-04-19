// crates/better-core/src/engine/cocoapods.rs
// CocoaPods compatibility — parses Podfile.lock, queries CocoaPods trunk API

use std::path::Path;

use super::{
    Ecosystem, EngineError, EngineErrorKind, FetchResult, LockGraph, OutdatedPackage,
    PackageEngine, ResolvedNode, Vulnerability,
};

pub struct CocoaPodsEngine;

impl PackageEngine for CocoaPodsEngine {
    fn name(&self) -> &str {
        "cocoapods"
    }

    fn manifest_files(&self) -> &[&str] {
        &["Podfile", "Podfile.lock"]
    }

    fn detect(&self, project_root: &Path) -> bool {
        project_root.join("Podfile").exists()
    }

    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError> {
        let lockfile_path = project_root.join("Podfile.lock");
        if !lockfile_path.exists() {
            return Err(EngineError {
                message: "Podfile.lock not found. Run 'pod install' first.".to_string(),
                kind: EngineErrorKind::LockfileNotFound,
            });
        }

        let content =
            std::fs::read_to_string(&lockfile_path).map_err(|e| EngineError {
                message: e.to_string(),
                kind: EngineErrorKind::LockfileNotFound,
            })?;

        let packages = parse_podfile_lock(&content);

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
                artifact_path: None,
            })
            .collect())
    }

    fn materialize(&self, _packages: &[FetchResult], _target: &Path) -> Result<(), EngineError> {
        // CocoaPods manages its own Pods/ directory via `pod install`
        Ok(())
    }

    fn audit(&self, graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
        if graph.packages.is_empty() {
            return Ok(vec![]);
        }

        let mut body = String::from(r#"{"queries":["#);
        let mut first = true;
        for pkg in &graph.packages {
            if !first {
                body.push(',');
            }
            first = false;
            body.push_str(&format!(
                r#"{{"package":{{"name":"{}","ecosystem":"CocoaPods"}},"version":"{}"}}"#,
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
            for id in resp
                .split("\"id\":")
                .skip(1)
                .filter_map(|s| s.split('"').nth(1))
            {
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

    fn outdated(&self, project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
        let graph = self.resolve(project_root)?;

        let client = reqwest::blocking::Client::builder()
            .use_rustls_tls()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| EngineError {
                message: e.to_string(),
                kind: EngineErrorKind::NetworkError,
            })?;

        let mut outdated = Vec::new();

        for pkg in graph.packages.iter().take(20) {
            if let Some(latest) = fetch_cocoapods_latest(&client, &pkg.name) {
                if latest != pkg.version {
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
                        latest,
                        update_type,
                    });
                }
            }
        }

        Ok(outdated)
    }
}

/// Parse the PODS section of Podfile.lock.
///
/// Format:
/// ```text
/// PODS:
///   - Alamofire (5.8.1)
///   - AFNetworking (4.0.1):
///     - AFNetworking/NSURLSession (= 4.0.1)
/// ```
fn parse_podfile_lock(content: &str) -> Vec<ResolvedNode> {
    let mut in_pods = false;
    let mut packages: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for line in content.lines() {
        if line == "PODS:" {
            in_pods = true;
            continue;
        }
        if in_pods {
            if !line.starts_with(' ') && !line.starts_with('\t') {
                break; // end of PODS section
            }
            // Top-level pods start with exactly two spaces then "- "
            if line.starts_with("  - ") {
                let entry = line.trim_start_matches("  - ");
                // Strip trailing colon for pods that list sub-specs
                let entry = entry.trim_end_matches(':');
                if let Some(paren) = entry.rfind('(') {
                    let name = entry[..paren].trim().to_string();
                    let version = entry[paren + 1..].trim_end_matches(')').trim().to_string();
                    // Ignore sub-specs (containing '/')
                    if !name.contains('/') && !name.is_empty() && !version.is_empty() {
                        packages.insert(name, version);
                    }
                }
            }
        }
    }

    packages
        .into_iter()
        .map(|(name, version)| ResolvedNode {
            name,
            version,
            resolved_url: None,
            integrity: None,
            ecosystem: Ecosystem::CocoaPods,
        })
        .collect()
}

fn fetch_cocoapods_latest(
    client: &reqwest::blocking::Client,
    name: &str,
) -> Option<String> {
    // CocoaPods trunk API: GET https://trunk.cocoapods.org/api/v1/pods/{name}
    let url = format!("https://trunk.cocoapods.org/api/v1/pods/{}", name);
    let text = client.get(&url).send().ok()?.text().ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("versions")?
        .as_array()?
        .last()
        .and_then(|ver| ver.get("name"))
        .and_then(|n| n.as_str())
        .map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_returns_false_no_podfile() {
        let tmp = std::env::temp_dir().join("cocoapods-test-no-detect");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!CocoaPodsEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_returns_true_with_podfile() {
        let tmp = std::env::temp_dir().join("cocoapods-test-detect");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("Podfile"), "platform :ios, '15.0'\n").unwrap();
        assert!(CocoaPodsEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_returns_err_no_podfile_lock() {
        let tmp = std::env::temp_dir().join("cocoapods-test-no-lock");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("Podfile"), "platform :ios, '15.0'\n").unwrap();
        let result = CocoaPodsEngine.resolve(&tmp);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_parses_podfile_lock() {
        let tmp = std::env::temp_dir().join("cocoapods-test-resolve");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("Podfile"), "platform :ios, '15.0'\n").unwrap();
        let lock = "PODS:\n  - Alamofire (5.8.1)\n  - SDWebImage (5.18.1):\n    - SDWebImage/Core (= 5.18.1)\n\nDEPENDENCIES:\n  - Alamofire (~> 5.0)\n";
        std::fs::write(tmp.join("Podfile.lock"), lock).unwrap();
        let graph = CocoaPodsEngine.resolve(&tmp).unwrap();
        assert_eq!(graph.packages.len(), 2);
        let names: Vec<&str> = graph.packages.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"Alamofire"));
        assert!(names.contains(&"SDWebImage"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parse_podfile_lock_ignores_subspecs() {
        let content = "PODS:\n  - Alamofire (5.8.1)\n  - SDWebImage/Core (5.18.1)\n\n";
        let pkgs = parse_podfile_lock(content);
        // SDWebImage/Core is a sub-spec and should be ignored
        assert_eq!(pkgs.len(), 1);
        assert_eq!(pkgs[0].name, "Alamofire");
    }

    #[test]
    fn name_is_cocoapods() {
        assert_eq!(CocoaPodsEngine.name(), "cocoapods");
    }

    #[test]
    fn manifest_files_contains_podfile() {
        let files = CocoaPodsEngine.manifest_files();
        assert!(files.contains(&"Podfile"));
        assert!(files.contains(&"Podfile.lock"));
    }

    #[test]
    fn parse_podfile_lock_empty_content_returns_empty() {
        let pkgs = parse_podfile_lock("");
        assert!(pkgs.is_empty());
    }
}
