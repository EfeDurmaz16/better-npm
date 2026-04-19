use std::collections::HashSet;
use std::path::Path;

use super::{
    Ecosystem, EngineError, EngineErrorKind, FetchResult, LockGraph, OutdatedPackage,
    PackageEngine, ResolvedNode, Vulnerability,
};

pub struct CargoEngine;

impl PackageEngine for CargoEngine {
    fn name(&self) -> &str {
        "cargo"
    }

    fn manifest_files(&self) -> &[&str] {
        &["Cargo.toml"]
    }

    fn detect(&self, project_root: &Path) -> bool {
        project_root.join("Cargo.toml").exists()
    }

    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError> {
        let lockfile = project_root.join("Cargo.lock");
        if !lockfile.exists() {
            return Ok(LockGraph {
                packages: vec![],
                edges: vec![],
            });
        }
        parse_cargo_lock(&lockfile)
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
        // Cargo manages its own global store — nothing to materialize here.
        Ok(())
    }

    fn audit(&self, graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
        audit_cargo_packages(graph)
    }

    fn outdated(&self, project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
        check_cargo_outdated(project_root)
    }
}

// ---------------------------------------------------------------------------
// Cargo.lock parser (TOML v3 line-by-line)
// ---------------------------------------------------------------------------

/// Parse `Cargo.lock` (TOML v3 `[[package]]` format) into a `LockGraph`.
///
/// We avoid pulling in a full TOML parser here and instead do a lightweight
/// line-oriented scan — sufficient for the well-structured Cargo.lock format.
fn parse_cargo_lock(lockfile: &Path) -> Result<LockGraph, EngineError> {
    let content = std::fs::read_to_string(lockfile).map_err(|e| EngineError {
        message: e.to_string(),
        kind: EngineErrorKind::LockfileNotFound,
    })?;

    // Each stanza: name, version, optional checksum
    struct Stanza {
        name: String,
        version: String,
        checksum: Option<String>,
    }

    let mut stanzas: Vec<Stanza> = Vec::new();
    let mut current: Option<Stanza> = None;

    for line in content.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            if let Some(s) = current.take() {
                if !s.name.is_empty() {
                    stanzas.push(s);
                }
            }
            current = Some(Stanza {
                name: String::new(),
                version: String::new(),
                checksum: None,
            });
        } else if let Some(ref mut s) = current {
            if let Some(v) = strip_toml_str(line, "name") {
                s.name = v;
            } else if let Some(v) = strip_toml_str(line, "version") {
                s.version = v;
            } else if let Some(v) = strip_toml_str(line, "checksum") {
                s.checksum = Some(v);
            }
        }
    }
    // Flush the final stanza
    if let Some(s) = current {
        if !s.name.is_empty() {
            stanzas.push(s);
        }
    }

    let packages: Vec<ResolvedNode> = stanzas
        .into_iter()
        .map(|s| ResolvedNode {
            name: s.name,
            version: s.version,
            integrity: s.checksum,
            resolved_url: None,
            ecosystem: Ecosystem::Cargo,
        })
        .collect();

    Ok(LockGraph {
        packages,
        edges: vec![],
    })
}

/// Extract the string value from a TOML line of the form `key = "value"`.
fn strip_toml_str(line: &str, key: &str) -> Option<String> {
    // Accept both `key = "value"` and `key = 'value'`
    for quote in &['"', '\''] {
        let prefix = format!("{} = {}", key, quote);
        if line.starts_with(&prefix) && line.ends_with(*quote) && line.len() > prefix.len() {
            return Some(line[prefix.len()..line.len() - 1].to_string());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Audit via OSV.dev batch API
// ---------------------------------------------------------------------------

/// Query the OSV.dev batch API for known vulnerabilities in the resolved
/// crates.io packages.
fn audit_cargo_packages(graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
    if graph.packages.is_empty() {
        return Ok(vec![]);
    }

    // Build the OSV querybatch JSON payload.
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
            r#"{{"package":{{"name":"{}","ecosystem":"crates.io"}},"version":"{}"}}"#,
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
        // Lightweight extraction: split on `"id":` and grab the quoted value.
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

// ---------------------------------------------------------------------------
// Outdated check via crates.io API
// ---------------------------------------------------------------------------

/// Compare each `[dependencies]` entry in `Cargo.toml` against the latest
/// version published on crates.io.
fn check_cargo_outdated(project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
    let manifest = project_root.join("Cargo.toml");
    if !manifest.exists() {
        return Err(EngineError {
            message: "Cargo.toml not found".to_string(),
            kind: EngineErrorKind::ManifestNotFound,
        });
    }

    let content = std::fs::read_to_string(&manifest).map_err(|e| EngineError {
        message: e.to_string(),
        kind: EngineErrorKind::ManifestNotFound,
    })?;

    let deps = parse_manifest_deps(&content);

    let client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| EngineError {
            message: e.to_string(),
            kind: EngineErrorKind::NetworkError,
        })?;

    let mut outdated = Vec::new();

    // Limit to 20 crates to avoid hammering the API in large workspaces.
    for (name, current) in deps.iter().take(20) {
        let url = format!("https://crates.io/api/v1/crates/{}", name);
        if let Ok(resp) = client
            .get(&url)
            .header("User-Agent", "better-package-manager/0.1")
            .send()
        {
            if let Ok(text) = resp.text() {
                if let Some(latest) = text
                    .split("\"newest_version\":")
                    .nth(1)
                    .and_then(|s| s.split('"').nth(1))
                {
                    if latest != current.as_str() {
                        outdated.push(OutdatedPackage {
                            name: name.clone(),
                            current: current.clone(),
                            latest: latest.to_string(),
                            update_type: classify_update(current, latest),
                        });
                    }
                }
            }
        }
    }

    Ok(outdated)
}

/// Parse `[dependencies]`, `[dev-dependencies]`, and `[build-dependencies]`
/// sections from a `Cargo.toml` string, returning `(name, version)` pairs.
fn parse_manifest_deps(content: &str) -> Vec<(String, String)> {
    let dep_headers = ["[dependencies]", "[dev-dependencies]", "[build-dependencies]"];
    let mut deps: Vec<(String, String)> = Vec::new();
    let mut in_deps = false;

    for line in content.lines() {
        let line = line.trim();

        // Check for a dependency section header.
        if dep_headers.contains(&line) {
            in_deps = true;
            continue;
        }
        // Any other section header ends the dependency block.
        if line.starts_with('[') {
            in_deps = false;
            continue;
        }

        if !in_deps || line.is_empty() || line.starts_with('#') {
            continue;
        }

        // `name = "version"` — simple string form
        // `name = { version = "1.0", ... }` — table form
        if let Some(eq_pos) = line.find('=') {
            let name = line[..eq_pos].trim().to_string();
            if name.is_empty() {
                continue;
            }
            let val = line[eq_pos + 1..].trim();

            let version = if val.starts_with('"') && val.ends_with('"') && val.len() >= 2 {
                // `"^1.2.3"` — strip semver range prefixes
                val[1..val.len() - 1]
                    .trim_start_matches('^')
                    .trim_start_matches('~')
                    .to_string()
            } else if val.contains("version") {
                // Inline table: `{ version = "1.0", features = [...] }`
                val.split("version")
                    .nth(1)
                    .and_then(|s| s.split('"').nth(1))
                    .unwrap_or("")
                    .trim_start_matches('^')
                    .trim_start_matches('~')
                    .to_string()
            } else {
                continue;
            };

            if !version.is_empty() && version != "*" {
                deps.push((name, version));
            }
        }
    }

    deps
}

/// Classify a version bump as `"major"`, `"minor"`, or `"patch"`.
fn classify_update(current: &str, latest: &str) -> String {
    let cur: Vec<&str> = current.splitn(3, '.').collect();
    let lat: Vec<&str> = latest.splitn(3, '.').collect();

    if cur.first() != lat.first() {
        "major".to_string()
    } else if cur.get(1) != lat.get(1) {
        "minor".to_string()
    } else {
        "patch".to_string()
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
    fn name_is_cargo() {
        assert_eq!(CargoEngine.name(), "cargo");
    }

    #[test]
    fn detect_false_without_cargo_toml() {
        let tmp = std::env::temp_dir().join("cargo-engine-test-nofile");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!CargoEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_true_with_cargo_toml() {
        let tmp = std::env::temp_dir().join("cargo-engine-test-hasfile");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("Cargo.toml"), "[package]\nname = \"test\"\n").unwrap();
        assert!(CargoEngine.detect(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_missing_cargo_lock_returns_empty() {
        let tmp = std::env::temp_dir().join("cargo-engine-test-nolock");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("Cargo.toml"), "[package]\nname = \"test\"\n").unwrap();
        let graph = CargoEngine.resolve(&tmp).unwrap();
        assert!(graph.packages.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn strip_toml_str_parses_double_quoted() {
        assert_eq!(strip_toml_str("name = \"my-crate\"", "name"), Some("my-crate".into()));
        assert_eq!(strip_toml_str("version = \"1.2.3\"", "version"), Some("1.2.3".into()));
    }

    #[test]
    fn strip_toml_str_returns_none_for_wrong_key() {
        assert!(strip_toml_str("other = \"value\"", "name").is_none());
    }

    #[test]
    fn classify_update_major_version_bump() {
        assert_eq!(classify_update("1.0.0", "2.0.0"), "major");
    }

    #[test]
    fn classify_update_minor_version_bump() {
        assert_eq!(classify_update("1.0.0", "1.1.0"), "minor");
    }

    #[test]
    fn classify_update_patch_version_bump() {
        assert_eq!(classify_update("1.0.0", "1.0.1"), "patch");
    }

    #[test]
    fn parse_manifest_deps_simple_string_form() {
        let toml = "[dependencies]\nlodash = \"4.17.21\"\n";
        let deps = parse_manifest_deps(toml);
        assert!(deps.iter().any(|(n, v)| n == "lodash" && v == "4.17.21"));
    }

    #[test]
    fn parse_manifest_deps_strips_caret() {
        let toml = "[dependencies]\nexpress = \"^4.18.2\"\n";
        let deps = parse_manifest_deps(toml);
        assert!(deps.iter().any(|(n, v)| n == "express" && v == "4.18.2"));
    }

    #[test]
    fn parse_cargo_lock_parses_single_package() {
        let tmp = std::env::temp_dir().join("cargo-parse-lock-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let content = "[[package]]\nname = \"serde\"\nversion = \"1.0.190\"\nchecksum = \"abc123\"\n";
        std::fs::write(tmp.join("Cargo.lock"), content).unwrap();
        let graph = parse_cargo_lock(&tmp.join("Cargo.lock")).unwrap();
        assert_eq!(graph.packages.len(), 1);
        assert_eq!(graph.packages[0].name, "serde");
        assert_eq!(graph.packages[0].version, "1.0.190");
        assert_eq!(graph.packages[0].integrity.as_deref(), Some("abc123"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
