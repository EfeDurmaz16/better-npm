use std::path::Path;
use super::{PackageEngine, LockGraph, ResolvedNode, FetchResult, Vulnerability, OutdatedPackage, EngineError, EngineErrorKind, Ecosystem};

pub struct DotNetEngine;

impl PackageEngine for DotNetEngine {
    fn name(&self) -> &str { "dotnet" }
    fn manifest_files(&self) -> &[&str] { &["*.csproj", "*.fsproj", "*.vbproj"] }

    fn detect(&self, project_root: &Path) -> bool {
        // Check for .csproj, .fsproj, .vbproj, or packages.lock.json
        if project_root.join("packages.lock.json").exists() { return true; }
        if let Ok(entries) = std::fs::read_dir(project_root) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let s = name.to_string_lossy();
                if s.ends_with(".csproj") || s.ends_with(".fsproj") || s.ends_with(".vbproj") {
                    return true;
                }
            }
        }
        false
    }

    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError> {
        // Try packages.lock.json first (NuGet lock file)
        let lockfile = project_root.join("packages.lock.json");
        if lockfile.exists() {
            return parse_nuget_lock(&lockfile);
        }
        // Fall back to scanning .csproj for PackageReference
        parse_csproj_packages(project_root)
    }

    fn fetch(&self, graph: &LockGraph, _: &Path) -> Result<Vec<FetchResult>, EngineError> {
        Ok(graph.packages.iter().map(|p| FetchResult {
            name: p.name.clone(), version: p.version.clone(), cached: true, bytes_downloaded: 0
        }).collect())
    }
    fn materialize(&self, _: &[FetchResult], _: &Path) -> Result<(), EngineError> { Ok(()) }

    fn audit(&self, graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
        audit_nuget(graph)
    }

    fn outdated(&self, project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
        check_nuget_outdated(project_root)
    }
}

fn parse_nuget_lock(lockfile: &Path) -> Result<LockGraph, EngineError> {
    let content = std::fs::read_to_string(lockfile)
        .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::LockfileNotFound })?;
    let v: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::ResolutionFailed })?;

    let mut packages = Vec::new();
    // packages.lock.json format: { "version": 1, "dependencies": { "net8.0": { "PackageName": { "type": "Direct", "requested": "...", "resolved": "1.0.0", ... } } } }
    if let Some(deps_map) = v["dependencies"].as_object() {
        for (_framework, framework_deps) in deps_map {
            if let Some(pkg_map) = framework_deps.as_object() {
                for (name, pkg_info) in pkg_map {
                    let version = pkg_info["resolved"].as_str()
                        .unwrap_or_else(|| pkg_info["version"].as_str().unwrap_or(""))
                        .to_string();
                    if !version.is_empty() {
                        packages.push(ResolvedNode {
                            name: name.clone(),
                            version,
                            integrity: pkg_info["contentHash"].as_str().map(|s| s.to_string()),
                            resolved_url: None,
                            ecosystem: Ecosystem::DotNet,
                        });
                    }
                }
            }
        }
    }
    // Dedup by name+version
    packages.dedup_by(|a, b| a.name == b.name && a.version == b.version);
    Ok(LockGraph { packages, edges: vec![] })
}

fn parse_csproj_packages(project_root: &Path) -> Result<LockGraph, EngineError> {
    let mut packages = Vec::new();
    if let Ok(entries) = std::fs::read_dir(project_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.ends_with(".csproj") || name.ends_with(".fsproj") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    // Parse <PackageReference Include="Name" Version="1.0.0" />
                    for line in content.lines() {
                        let line = line.trim();
                        if line.contains("PackageReference") && line.contains("Include=") {
                            let pkg_name = extract_xml_attr(line, "Include");
                            let version = extract_xml_attr(line, "Version");
                            if let (Some(n), Some(v)) = (pkg_name, version) {
                                packages.push(ResolvedNode {
                                    name: n, version: v, integrity: None,
                                    resolved_url: None, ecosystem: Ecosystem::DotNet,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(LockGraph { packages, edges: vec![] })
}

fn extract_xml_attr(line: &str, attr: &str) -> Option<String> {
    let search = format!("{}=\"", attr);
    let pos = line.find(&search)?;
    let rest = &line[pos + search.len()..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn audit_nuget(graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
    if graph.packages.is_empty() { return Ok(vec![]); }
    let mut body = String::from(r#"{"queries":["#);
    let mut first = true;
    for pkg in &graph.packages {
        if !first { body.push(','); }
        first = false;
        body.push_str(&format!(r#"{{"package":{{"name":"{}","ecosystem":"NuGet"}},"version":"{}"}}"#, pkg.name, pkg.version));
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

fn check_nuget_outdated(project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
    // Inline resolve logic to avoid calling DotNetEngine method from free function
    let lockfile = project_root.join("packages.lock.json");
    let graph = if lockfile.exists() {
        parse_nuget_lock(&lockfile)?
    } else {
        parse_csproj_packages(project_root)?
    };
    let mut outdated = Vec::new();
    let client = reqwest::blocking::Client::builder().use_rustls_tls().timeout(std::time::Duration::from_secs(15)).build()
        .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::NetworkError })?;
    for pkg in graph.packages.iter().take(10) {
        // NuGet API: GET https://api.nuget.org/v3-flatcontainer/{id}/index.json
        let url = format!("https://api.nuget.org/v3-flatcontainer/{}/index.json", pkg.name.to_lowercase());
        if let Ok(resp) = client.get(&url).send() {
            if let Ok(text) = resp.text() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(versions) = v["versions"].as_array() {
                        if let Some(latest) = versions.last().and_then(|v| v.as_str()) {
                            if latest != pkg.version.as_str() {
                                outdated.push(OutdatedPackage {
                                    name: pkg.name.clone(),
                                    current: pkg.version.clone(),
                                    latest: latest.to_string(),
                                    update_type: "unknown".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(outdated)
}
