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

    fn outdated(&self, project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
        check_composer_outdated(project_root)
    }
}

/// Compare `require` + `require-dev` entries in `composer.json` against the
/// latest stable release from the Packagist v2 API.
fn check_composer_outdated(project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
    let manifest = project_root.join("composer.json");
    if !manifest.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read_to_string(&manifest)
        .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::ManifestNotFound })?;
    let v: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::ResolutionFailed })?;

    // Collect (name, current_version) from require + require-dev
    let mut deps: Vec<(String, String)> = Vec::new();
    for section in &["require", "require-dev"] {
        if let Some(map) = v[section].as_object() {
            for (name, ver) in map {
                if name == "php" || name.starts_with("ext-") {
                    continue; // skip platform requirements
                }
                let ver_str = ver.as_str().unwrap_or("")
                    .trim_start_matches('^')
                    .trim_start_matches('~')
                    .trim_start_matches(">=")
                    .trim_start_matches("<=")
                    .trim_start_matches('>')
                    .trim_start_matches('<')
                    .trim()
                    .to_string();
                if !ver_str.is_empty() && ver_str != "*" {
                    deps.push((name.clone(), ver_str));
                }
            }
        }
    }

    if deps.is_empty() {
        return Ok(vec![]);
    }

    let client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::NetworkError })?;

    let mut outdated = Vec::new();

    for (name, current) in deps.iter().take(20) {
        // Packagist v2 API: https://repo.packagist.org/p2/{vendor}/{package}.json
        // Name format is "vendor/package"
        let url = format!("https://repo.packagist.org/p2/{}.json", name);
        if let Ok(resp) = client.get(&url).send() {
            if let Ok(text) = resp.text() {
                // packages key → array of versions; first entry is latest stable
                if let Some(latest) = extract_latest_packagist_version(&text, name) {
                    if latest != current.as_str() {
                        let update_type = classify_semver(current, &latest);
                        outdated.push(OutdatedPackage {
                            name: name.clone(),
                            current: current.clone(),
                            latest,
                            update_type,
                        });
                    }
                }
            }
        }
    }
    Ok(outdated)
}

/// Extract the latest non-dev version from a Packagist v2 JSON response.
fn extract_latest_packagist_version(text: &str, name: &str) -> Option<String> {
    // Response format: {"packages":{"vendor/package":[{"version":"1.2.3",...},{...}]}}
    // Versions are ordered newest-first.
    let key = format!("\"{}\":[", name);
    let start = text.find(&key)?;
    let after = &text[start + key.len()..];
    // Scan versions array for first stable release (no -dev, -alpha, -beta, -RC)
    for segment in after.split("\"version\":").skip(1) {
        // segment starts with `"1.2.3",...` so split on `"` gives ["", "1.2.3", ...]
        let ver = segment.split('"').nth(1)?;
        let lower = ver.to_lowercase();
        if !lower.contains("dev") && !lower.contains("alpha") && !lower.contains("beta") && !lower.contains("-rc") {
            return Some(ver.trim_start_matches('v').to_string());
        }
    }
    None
}

/// Very lightweight semver major/minor/patch classifier.
fn classify_semver(current: &str, latest: &str) -> String {
    let cur: Vec<&str> = current.splitn(3, '.').collect();
    let lat: Vec<&str> = latest.splitn(3, '.').collect();
    if cur.first() != lat.first() { "major".to_string() }
    else if cur.get(1) != lat.get(1) { "minor".to_string() }
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

    #[test]
    fn outdated_no_composer_json_returns_empty() {
        let tmp = std::env::temp_dir().join("php-outdated-nofile");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = check_composer_outdated(&tmp).unwrap();
        assert!(result.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn outdated_skips_platform_requirements() {
        let tmp = std::env::temp_dir().join("php-outdated-platform");
        std::fs::create_dir_all(&tmp).unwrap();
        let manifest = r#"{"require":{"php":">=8.0","ext-json":"*"},"require-dev":{}}"#;
        std::fs::write(tmp.join("composer.json"), manifest).unwrap();
        // Only platform deps — network calls are skipped because deps list is empty
        let result = check_composer_outdated(&tmp).unwrap();
        assert!(result.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn classify_semver_major() {
        assert_eq!(classify_semver("1.0.0", "2.0.0"), "major");
    }

    #[test]
    fn classify_semver_minor() {
        assert_eq!(classify_semver("1.0.0", "1.1.0"), "minor");
    }

    #[test]
    fn classify_semver_patch() {
        assert_eq!(classify_semver("1.0.0", "1.0.1"), "patch");
    }

    #[test]
    fn extract_latest_packagist_skips_dev_versions() {
        let json = r#"{"packages":{"vendor/pkg":[{"version":"2.0.0-dev"},{"version":"1.5.0"},{"version":"1.4.0"}]}}"#;
        let result = extract_latest_packagist_version(json, "vendor/pkg");
        assert_eq!(result.as_deref(), Some("1.5.0"));
    }

    #[test]
    fn extract_latest_packagist_returns_none_for_unknown_package() {
        let json = r#"{"packages":{}}"#;
        let result = extract_latest_packagist_version(json, "no/pkg");
        assert!(result.is_none());
    }
}
