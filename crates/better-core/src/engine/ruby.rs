use std::path::Path;
use super::{PackageEngine, LockGraph, ResolvedNode, FetchResult, Vulnerability, OutdatedPackage, EngineError, EngineErrorKind, Ecosystem};

pub struct RubyEngine;

impl PackageEngine for RubyEngine {
    fn name(&self) -> &str { "ruby" }
    fn manifest_files(&self) -> &[&str] { &["Gemfile"] }
    fn detect(&self, project_root: &Path) -> bool {
        project_root.join("Gemfile").exists()
    }

    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError> {
        let lockfile = project_root.join("Gemfile.lock");
        if !lockfile.exists() {
            return Ok(LockGraph { packages: vec![], edges: vec![] });
        }
        parse_gemfile_lock(&lockfile)
    }

    fn fetch(&self, graph: &LockGraph, _cache_dir: &Path) -> Result<Vec<FetchResult>, EngineError> {
        Ok(graph.packages.iter().map(|p| FetchResult {
            name: p.name.clone(), version: p.version.clone(), cached: true, bytes_downloaded: 0
        }).collect())
    }

    fn materialize(&self, _: &[FetchResult], _: &Path) -> Result<(), EngineError> { Ok(()) }

    fn audit(&self, graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
        audit_gems(graph)
    }

    fn outdated(&self, project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
        check_gem_outdated(project_root)
    }
}

fn parse_gemfile_lock(lockfile: &Path) -> Result<LockGraph, EngineError> {
    let content = std::fs::read_to_string(lockfile)
        .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::LockfileNotFound })?;

    let mut packages = Vec::new();
    let mut in_gem_section = false;

    for line in content.lines() {
        if line == "GEM" || line.starts_with("GEM") {
            in_gem_section = true;
            continue;
        }
        if line.starts_with("BUNDLED WITH") || line.starts_with("PLATFORMS") || line.starts_with("DEPENDENCIES") {
            in_gem_section = false;
            continue;
        }
        if in_gem_section {
            // Format: "    gemname (version)"
            let trimmed = line.trim();
            if trimmed.starts_with("remote:") || trimmed.starts_with("specs:") { continue; }
            if let Some(paren) = trimmed.find(" (") {
                let name = trimmed[..paren].trim().to_string();
                let version = trimmed[paren+2..].trim_end_matches(')').to_string();
                if !name.is_empty() && !version.is_empty() && !version.contains(' ') {
                    packages.push(ResolvedNode {
                        name,
                        version,
                        integrity: None,
                        resolved_url: None,
                        ecosystem: Ecosystem::Ruby,
                    });
                }
            }
        }
    }

    Ok(LockGraph { packages, edges: vec![] })
}

fn audit_gems(graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
    if graph.packages.is_empty() { return Ok(vec![]); }
    let mut body = String::from(r#"{"queries":["#);
    let mut first = true;
    for pkg in &graph.packages {
        if !first { body.push(','); }
        first = false;
        body.push_str(&format!(
            r#"{{"package":{{"name":"{}","ecosystem":"RubyGems"}},"version":"{}"}}"#,
            pkg.name, pkg.version
        ));
    }
    body.push_str("]}");
    let client = reqwest::blocking::Client::builder().use_rustls_tls().timeout(std::time::Duration::from_secs(30)).build()
        .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::NetworkError })?;
    let resp = client.post("https://api.osv.dev/v1/querybatch")
        .header("Content-Type", "application/json").body(body).send()
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

fn check_gem_outdated(project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
    let gemfile = project_root.join("Gemfile");
    if !gemfile.exists() { return Ok(vec![]); }
    let content = std::fs::read_to_string(&gemfile)
        .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::ManifestNotFound })?;

    let mut gems: Vec<(String, String)> = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("gem ") {
            let parts: Vec<&str> = line["gem ".len()..].split(',').collect();
            if parts.len() >= 2 {
                let name = parts[0].trim().trim_matches('\'').trim_matches('"').to_string();
                let ver = parts[1].trim().trim_matches('\'').trim_matches('"')
                    .trim_start_matches('>').trim_start_matches('=').trim_start_matches('~').trim_start_matches('>').trim().to_string();
                if !ver.is_empty() { gems.push((name, ver)); }
            }
        }
    }

    let mut outdated = Vec::new();
    let client = reqwest::blocking::Client::builder().use_rustls_tls().timeout(std::time::Duration::from_secs(15)).build()
        .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::NetworkError })?;

    for (name, current) in gems.iter().take(20) {
        let url = format!("https://rubygems.org/api/v1/gems/{}.json", name);
        if let Ok(resp) = client.get(&url).send() {
            if let Ok(text) = resp.text() {
                if let Some(latest) = text.split("\"version\":\"").nth(1).and_then(|s| s.split('"').next()) {
                    if latest != current.as_str() {
                        outdated.push(OutdatedPackage {
                            name: name.clone(), current: current.clone(), latest: latest.to_string(),
                            update_type: "unknown".to_string()
                        });
                    }
                }
            }
        }
    }
    Ok(outdated)
}
