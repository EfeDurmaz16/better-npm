// crates/better-core/src/engine/swift.rs
// Swift Package Manager engine — parses Package.swift or Package.resolved
// Uses `swift package resolve` when swift CLI is available, else parses .resolved

use std::path::Path;

use super::{
    Ecosystem, EngineError, EngineErrorKind, FetchResult, LockGraph, OutdatedPackage,
    PackageEngine, ResolvedNode, Vulnerability,
};

pub struct SwiftEngine;

impl PackageEngine for SwiftEngine {
    fn name(&self) -> &str {
        "swift"
    }

    fn manifest_files(&self) -> &[&str] {
        &["Package.swift", "Package.resolved"]
    }

    fn detect(&self, project_root: &Path) -> bool {
        project_root.join("Package.swift").exists()
    }

    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError> {
        // Try Package.resolved (v1 and v2 formats)
        let resolved_path = project_root.join("Package.resolved");
        let source_resolved = project_root.join(".package.resolved");

        let resolved_text = if resolved_path.exists() {
            std::fs::read_to_string(&resolved_path).map_err(|e| EngineError {
                message: e.to_string(),
                kind: EngineErrorKind::LockfileNotFound,
            })?
        } else if source_resolved.exists() {
            std::fs::read_to_string(&source_resolved).map_err(|e| EngineError {
                message: e.to_string(),
                kind: EngineErrorKind::LockfileNotFound,
            })?
        } else {
            // Try to generate via swift CLI
            let output = std::process::Command::new("swift")
                .args(["package", "resolve"])
                .current_dir(project_root)
                .output()
                .map_err(|e| EngineError {
                    message: format!("Failed to run swift package resolve: {}", e),
                    kind: EngineErrorKind::ResolutionFailed,
                })?;
            if !output.status.success() {
                return Err(EngineError {
                    message: format!(
                        "swift package resolve failed: {}",
                        String::from_utf8_lossy(&output.stderr)
                    ),
                    kind: EngineErrorKind::ResolutionFailed,
                });
            }
            std::fs::read_to_string(project_root.join("Package.resolved")).map_err(|e| {
                EngineError {
                    message: e.to_string(),
                    kind: EngineErrorKind::LockfileNotFound,
                }
            })?
        };

        let resolved: serde_json::Value =
            serde_json::from_str(&resolved_text).map_err(|e| EngineError {
                message: format!("Failed to parse Package.resolved: {}", e),
                kind: EngineErrorKind::ResolutionFailed,
            })?;

        let mut packages = vec![];

        // Handle both v1 (object.pins) and v2 (pins) formats
        let pins = resolved
            .get("object")
            .and_then(|o| o.get("pins"))
            .or_else(|| resolved.get("pins"))
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default();

        for pin in &pins {
            let name = pin
                .get("package")
                .or_else(|| pin.get("identity"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();

            let url = pin
                .get("repositoryURL")
                .or_else(|| pin.get("location"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let state = pin.get("state").cloned().unwrap_or_default();
            let version = state
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let revision = state
                .get("revision")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            packages.push(ResolvedNode {
                name,
                version: if !version.is_empty() {
                    version
                } else {
                    revision.chars().take(8).collect()
                },
                resolved_url: if url.is_empty() { None } else { Some(url) },
                integrity: None,
                ecosystem: Ecosystem::Swift,
            });
        }

        Ok(LockGraph {
            packages,
            edges: vec![],
        })
    }

    fn fetch(&self, graph: &LockGraph, _cache_dir: &Path) -> Result<Vec<FetchResult>, EngineError> {
        // Swift packages are fetched by the swift CLI into .build/checkouts
        // We just report them as "cached"
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
        // Swift manages its own package cache; nothing to materialize manually
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
                r#"{{"package":{{"name":"{}","ecosystem":"SwiftURL"}},"version":"{}"}}"#,
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
        // Re-read Package.resolved to get both version and repository URL
        let graph = self.resolve(project_root)?;
        if graph.packages.is_empty() {
            return Ok(vec![]);
        }

        let client = reqwest::blocking::Client::builder()
            .use_rustls_tls()
            .timeout(std::time::Duration::from_secs(10))
            .user_agent("better-pkg/1.0")
            .build()
            .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::NetworkError })?;

        let mut outdated = Vec::new();

        for pkg in &graph.packages {
            let current = pkg.version.trim_start_matches('v').to_string();
            // Only check semver versions (skip revision-pinned packages)
            if current.len() <= 8 && !current.contains('.') {
                continue;
            }

            let Some(repo_url) = &pkg.resolved_url else { continue };

            // Extract {owner}/{repo} from GitHub URLs
            let Some(github_path) = extract_github_path(repo_url) else { continue };

            let api_url = format!("https://api.github.com/repos/{}/releases/latest", github_path);
            let resp = match client.get(&api_url).header("Accept", "application/vnd.github+json").send() {
                Ok(r) if r.status().is_success() => r.text().unwrap_or_default(),
                _ => continue,
            };

            // Extract tag_name from JSON response
            let Some(tag) = resp.split("\"tag_name\"").nth(1)
                .and_then(|s| s.split('"').nth(1)) else { continue };

            let latest = tag.trim_start_matches('v').to_string();
            if latest.is_empty() || latest == current { continue; }

            let update_type = classify_semver(&current, &latest);
            outdated.push(OutdatedPackage {
                name: pkg.name.clone(),
                current: current.clone(),
                latest: latest.clone(),
                update_type,
            });
        }

        Ok(outdated)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract `{owner}/{repo}` from a GitHub URL.
/// Handles https://github.com/owner/repo and https://github.com/owner/repo.git
fn extract_github_path(url: &str) -> Option<String> {
    let url = url.trim_end_matches('/').trim_end_matches(".git");
    let idx = url.find("github.com/")?;
    let after = &url[idx + "github.com/".len()..];
    let parts: Vec<&str> = after.splitn(2, '/').collect();
    if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
        Some(format!("{}/{}", parts[0], parts[1]))
    } else {
        None
    }
}

/// Classify a version bump as major/minor/patch/unknown.
fn classify_semver(current: &str, latest: &str) -> String {
    let parse = |v: &str| -> (u64, u64, u64) {
        let mut parts = v.split('.');
        let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        (major, minor, patch)
    };
    let (cm, cmin, _cp) = parse(current);
    let (lm, lmin, _lp) = parse(latest);
    if lm > cm { "major".to_string() }
    else if lmin > cmin { "minor".to_string() }
    else { "patch".to_string() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::PackageEngine;

    #[test]
    fn name_is_swift() {
        assert_eq!(SwiftEngine.name(), "swift");
    }

    #[test]
    fn detect_false_without_package_swift() {
        let tmp = std::env::temp_dir().join("swift-engine-test-nofile");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!SwiftEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_true_with_package_swift() {
        let tmp = std::env::temp_dir().join("swift-engine-test-hasfile");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("Package.swift"), "// swift-tools-version:5.9\n").unwrap();
        assert!(SwiftEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_no_package_resolved_graceful() {
        let tmp = std::env::temp_dir().join("swift-engine-test-nolock");
        std::fs::create_dir_all(&tmp).unwrap();
        // Without Package.resolved, swift CLI is invoked which may not be present.
        // Accept either empty graph (swift missing) or error.
        match SwiftEngine.resolve(&tmp) {
            Ok(graph) => assert!(graph.packages.is_empty()),
            Err(_) => {} // expected when swift CLI is not installed
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_v2_package_resolved_parses_pins() {
        let tmp = std::env::temp_dir().join("swift-engine-test-v2");
        std::fs::create_dir_all(&tmp).unwrap();
        let content = r#"{
          "pins": [
            {
              "identity": "swift-argument-parser",
              "location": "https://github.com/apple/swift-argument-parser",
              "state": { "revision": "abc1234567890", "version": "1.3.0" }
            }
          ],
          "version": 2
        }"#;
        std::fs::write(tmp.join("Package.resolved"), content).unwrap();
        let graph = SwiftEngine.resolve(&tmp).unwrap();
        assert_eq!(graph.packages.len(), 1);
        assert_eq!(graph.packages[0].name, "swift-argument-parser");
        assert_eq!(graph.packages[0].version, "1.3.0");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_v1_package_resolved_parses_pins() {
        let tmp = std::env::temp_dir().join("swift-engine-test-v1");
        std::fs::create_dir_all(&tmp).unwrap();
        let content = r#"{
          "object": {
            "pins": [
              {
                "package": "Alamofire",
                "repositoryURL": "https://github.com/Alamofire/Alamofire.git",
                "state": { "revision": "abc123", "version": "5.8.1" }
              }
            ]
          },
          "version": 1
        }"#;
        std::fs::write(tmp.join("Package.resolved"), content).unwrap();
        let graph = SwiftEngine.resolve(&tmp).unwrap();
        assert_eq!(graph.packages.len(), 1);
        assert_eq!(graph.packages[0].name, "Alamofire");
        assert_eq!(graph.packages[0].version, "5.8.1");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn manifest_files_contains_package_swift() {
        let files = SwiftEngine.manifest_files();
        assert!(files.contains(&"Package.swift"));
        assert!(files.contains(&"Package.resolved"));
    }

    #[test]
    fn materialize_returns_ok() {
        let tmp = std::env::temp_dir().join("swift-engine-mat");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(SwiftEngine.materialize(&[], &tmp).is_ok());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn extract_github_path_standard_url() {
        assert_eq!(
            extract_github_path("https://github.com/apple/swift-argument-parser"),
            Some("apple/swift-argument-parser".to_string())
        );
    }

    #[test]
    fn extract_github_path_git_suffix() {
        assert_eq!(
            extract_github_path("https://github.com/Alamofire/Alamofire.git"),
            Some("Alamofire/Alamofire".to_string())
        );
    }

    #[test]
    fn extract_github_path_trailing_slash() {
        assert_eq!(
            extract_github_path("https://github.com/vapor/vapor/"),
            Some("vapor/vapor".to_string())
        );
    }

    #[test]
    fn extract_github_path_non_github() {
        assert_eq!(extract_github_path("https://gitlab.com/owner/repo"), None);
    }

    #[test]
    fn classify_semver_major_bump() {
        assert_eq!(classify_semver("1.3.0", "2.0.0"), "major");
    }

    #[test]
    fn classify_semver_minor_bump() {
        assert_eq!(classify_semver("1.3.0", "1.4.0"), "minor");
    }

    #[test]
    fn classify_semver_patch_bump() {
        assert_eq!(classify_semver("1.3.0", "1.3.1"), "patch");
    }
}
