use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::types::*;
use crate::{extract_json_field, extract_json_array_strings, extract_json_object_pairs};

// === D.5: Workspace support ===

pub fn detect_workspaces(project_root: &Path) -> Result<WorkspaceInfo, String> {
    let pkg_json = project_root.join("package.json");
    let content = fs::read_to_string(&pkg_json)
        .map_err(|e| format!("Failed to read package.json: {}", e))?;
    let patterns = extract_json_array_strings(&content, "workspaces");
    if patterns.is_empty() {
        return Err("No workspaces field found in package.json".into());
    }
    let mut workspace_dirs: Vec<PathBuf> = Vec::new();
    for pattern in &patterns {
        if pattern.contains('*') {
            let parts: Vec<&str> = pattern.split('*').collect();
            if parts.len() == 2 {
                let prefix = parts[0].trim_end_matches('/');
                let suffix = parts[1];
                let search_dir = if prefix.is_empty() { project_root.to_path_buf() } else { project_root.join(prefix) };
                if let Ok(entries) = fs::read_dir(&search_dir) {
                    for entry in entries.flatten() {
                        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            let candidate = entry.path();
                            if suffix.is_empty() || candidate.to_string_lossy().ends_with(suffix) {
                                if candidate.join("package.json").exists() {
                                    workspace_dirs.push(candidate);
                                }
                            }
                        }
                    }
                }
            }
        } else {
            let dir = project_root.join(pattern);
            if dir.join("package.json").exists() {
                workspace_dirs.push(dir);
            }
        }
    }
    workspace_dirs.sort();
    let mut all_names: HashSet<String> = HashSet::new();
    let mut package_data: Vec<(PathBuf, String, String, String, Vec<(String, String)>)> = Vec::new();
    for dir in &workspace_dirs {
        let pj = dir.join("package.json");
        let c = match fs::read_to_string(&pj) { Ok(c) => c, Err(_) => continue };
        let name = extract_json_field(&c, "name").unwrap_or_else(|| "unknown".into());
        let version = extract_json_field(&c, "version").unwrap_or_else(|| "0.0.0".into());
        let rel_dir = dir.strip_prefix(project_root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| dir.to_string_lossy().to_string());
        let scripts = extract_json_object_pairs(&c, "scripts").unwrap_or_default();
        all_names.insert(name.clone());
        package_data.push((dir.clone(), name, version, rel_dir, scripts));
    }
    let mut packages = Vec::new();
    for (dir, name, version, rel_dir, scripts) in package_data {
        let pj = dir.join("package.json");
        let c = fs::read_to_string(&pj).unwrap_or_default();
        let mut workspace_deps = Vec::new();
        for section in &["dependencies", "devDependencies", "peerDependencies"] {
            let deps = extract_json_object_pairs(&c, section).unwrap_or_default();
            for (dep_name, _) in &deps {
                if all_names.contains(dep_name) { workspace_deps.push(dep_name.clone()); }
            }
        }
        workspace_deps.sort();
        workspace_deps.dedup();
        packages.push(WorkspacePackage { name, version, dir, relative_dir: rel_dir, workspace_deps, scripts });
    }
    Ok(WorkspaceInfo { workspace_type: "npm".into(), packages })
}

pub fn workspace_graph(info: &WorkspaceInfo) -> WorkspaceGraphResult {
    let names: Vec<&str> = info.packages.iter().map(|p| p.name.as_str()).collect();
    let name_set: HashSet<&str> = names.iter().copied().collect();
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut dependents_of: HashMap<&str, Vec<&str>> = HashMap::new();
    for name in &names { in_degree.insert(name, 0); }
    for pkg in &info.packages {
        for dep in &pkg.workspace_deps {
            if name_set.contains(dep.as_str()) {
                *in_degree.entry(pkg.name.as_str()).or_insert(0) += 1;
                dependents_of.entry(dep.as_str()).or_default().push(pkg.name.as_str());
            }
        }
    }
    // Kahn's algorithm with level tracking
    let mut queue: VecDeque<&str> = VecDeque::new();
    for (name, deg) in &in_degree {
        if *deg == 0 { queue.push_back(name); }
    }
    let mut sorted = Vec::new();
    let mut levels: Vec<Vec<String>> = Vec::new();
    while !queue.is_empty() {
        let mut level = Vec::new();
        let level_size = queue.len();
        for _ in 0..level_size {
            let name = queue.pop_front().unwrap();
            sorted.push(name.to_string());
            level.push(name.to_string());
            if let Some(deps) = dependents_of.get(name) {
                for dep in deps {
                    if let Some(deg) = in_degree.get_mut(dep) {
                        *deg -= 1;
                        if *deg == 0 { queue.push_back(dep); }
                    }
                }
            }
        }
        levels.push(level);
    }
    let sorted_set: HashSet<&str> = sorted.iter().map(|s| s.as_str()).collect();
    let cycles: Vec<Vec<String>> = names.iter()
        .filter(|n| !sorted_set.contains(**n))
        .map(|n| vec![n.to_string()])
        .collect();
    WorkspaceGraphResult { sorted, levels, cycles }
}

pub fn workspace_changed(
    project_root: &Path, info: &WorkspaceInfo, since_ref: &str,
) -> Result<WorkspaceChangedResult, String> {
    let output = std::process::Command::new("git")
        .args(["diff", "--name-only", since_ref])
        .current_dir(project_root).output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    if !output.status.success() {
        return Err(format!("git diff failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let files_str = String::from_utf8_lossy(&output.stdout);
    let changed_files: Vec<&str> = files_str.lines().filter(|l| !l.is_empty()).collect();
    let changed_file_count = changed_files.len() as u64;
    let mut changed_packages: Vec<String> = Vec::new();
    for pkg in &info.packages {
        let prefix = &pkg.relative_dir;
        if changed_files.iter().any(|f| f.starts_with(prefix)) {
            changed_packages.push(pkg.name.clone());
        }
    }
    let changed_set: HashSet<String> = changed_packages.iter().cloned().collect();
    let mut affected: HashSet<String> = changed_set.clone();
    let mut bfs_queue: VecDeque<String> = changed_packages.clone().into_iter().collect();
    while let Some(name) = bfs_queue.pop_front() {
        for pkg in &info.packages {
            if pkg.workspace_deps.iter().any(|d| d == &name) && !affected.contains(&pkg.name) {
                affected.insert(pkg.name.clone());
                bfs_queue.push_back(pkg.name.clone());
            }
        }
    }
    let mut affected_packages: Vec<String> = affected.into_iter().collect();
    affected_packages.sort();
    Ok(WorkspaceChangedResult {
        since_ref: since_ref.into(), changed_files: changed_file_count,
        changed_packages, affected_packages,
    })
}

pub fn workspace_run(
    _project_root: &Path, info: &WorkspaceInfo, command: &str,
) -> Result<WorkspaceRunResult, String> {
    let graph = workspace_graph(info);
    let name_to_pkg: HashMap<&str, &WorkspacePackage> = info.packages.iter()
        .map(|p| (p.name.as_str(), p)).collect();
    let mut results = Vec::new();
    let mut success = 0u64;
    let mut failure = 0u64;
    for name in &graph.sorted {
        if let Some(pkg) = name_to_pkg.get(name.as_str()) {
            let started = Instant::now();
            let status = std::process::Command::new("sh").arg("-c").arg(command)
                .current_dir(&pkg.dir).status();
            let duration_ms = started.elapsed().as_millis() as u64;
            match status {
                Ok(s) => {
                    let code = s.code().unwrap_or(1);
                    if code == 0 { success += 1; } else { failure += 1; }
                    results.push((name.clone(), code, duration_ms));
                }
                Err(e) => {
                    failure += 1;
                    results.push((name.clone(), 1, duration_ms));
                    eprintln!("[better] workspace run error in {}: {}", name, e);
                }
            }
        }
    }
    Ok(WorkspaceRunResult {
        command: command.into(), total: results.len() as u64, success, failure, results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::{OsvBatchResponse};

    #[test]
    fn test_osv_batch_response_deserialization() {
        let json = r#"{
            "results": [
                {
                    "vulns": [
                        {
                            "id": "GHSA-test-1234",
                            "summary": "Prototype pollution in lodash",
                            "details": "Detailed description here",
                            "severity": [
                                {"type": "CVSS_V3", "score": "9.8"}
                            ],
                            "affected": [
                                {
                                    "package": {"name": "lodash", "ecosystem": "npm"},
                                    "ranges": [
                                        {
                                            "type": "SEMVER",
                                            "events": [
                                                {"introduced": "0"},
                                                {"fixed": "4.17.21"}
                                            ]
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                },
                {
                    "vulns": []
                },
                {}
            ]
        }"#;

        let resp: OsvBatchResponse = serde_json::from_str(json).unwrap();
        let results = resp.results.unwrap();
        assert_eq!(results.len(), 3);

        // First result has one vulnerability
        let vulns = results[0].vulns.as_ref().unwrap();
        assert_eq!(vulns.len(), 1);
        assert_eq!(vulns[0].id.as_deref(), Some("GHSA-test-1234"));
        assert_eq!(vulns[0].summary.as_deref(), Some("Prototype pollution in lodash"));

        // Severity score
        let sev = vulns[0].severity.as_ref().unwrap();
        assert_eq!(sev[0].score.as_deref(), Some("9.8"));

        // Fixed version from range events
        let affected = vulns[0].affected.as_ref().unwrap();
        let ranges = affected[0].ranges.as_ref().unwrap();
        let events = ranges[0].events.as_ref().unwrap();
        let fixed = events.iter().find_map(|ev: &serde_json::Value| {
            ev.get("fixed").and_then(|f: &serde_json::Value| f.as_str()).map(|s: &str| s.to_string())
        });
        assert_eq!(fixed.as_deref(), Some("4.17.21"));

        // Second result has empty vulns array
        let vulns2 = results[1].vulns.as_ref().unwrap();
        assert_eq!(vulns2.len(), 0);

        // Third result has no vulns field at all
        assert!(results[2].vulns.is_none());
    }

    #[test]
    fn test_osv_batch_response_empty() {
        let json = r#"{"results": []}"#;
        let resp: OsvBatchResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.results.unwrap().len(), 0);
    }

    #[test]
    fn test_osv_batch_response_malformed_fallback() {
        let json = r#"not valid json"#;
        let resp: Result<OsvBatchResponse, _> = serde_json::from_str(json);
        assert!(resp.is_err());

        // The run_audit code uses unwrap_or to handle this gracefully
        let fallback = resp.unwrap_or(OsvBatchResponse { results: None });
        assert!(fallback.results.is_none());
    }

    #[test]
    fn test_osv_severity_cvss_score_parsing() {
        let score_to_severity = |score: f64| -> &str {
            if score >= 9.0 { "CRITICAL" }
            else if score >= 7.0 { "HIGH" }
            else if score >= 4.0 { "MEDIUM" }
            else { "LOW" }
        };

        assert_eq!(score_to_severity(9.8), "CRITICAL");
        assert_eq!(score_to_severity(9.0), "CRITICAL");
        assert_eq!(score_to_severity(8.5), "HIGH");
        assert_eq!(score_to_severity(7.0), "HIGH");
        assert_eq!(score_to_severity(6.9), "MEDIUM");
        assert_eq!(score_to_severity(4.0), "MEDIUM");
        assert_eq!(score_to_severity(3.9), "LOW");
        assert_eq!(score_to_severity(0.0), "LOW");
    }

    fn make_workspace_info(packages: Vec<(&str, Vec<&str>)>) -> WorkspaceInfo {
        WorkspaceInfo {
            workspace_type: "npm".to_string(),
            packages: packages.into_iter().map(|(name, deps)| WorkspacePackage {
                name: name.to_string(),
                version: "1.0.0".to_string(),
                dir: std::path::PathBuf::from(format!("/tmp/{}", name)),
                relative_dir: name.to_string(),
                workspace_deps: deps.into_iter().map(|s| s.to_string()).collect(),
                scripts: vec![],
            }).collect(),
        }
    }

    #[test]
    fn workspace_graph_empty_returns_empty() {
        let info = make_workspace_info(vec![]);
        let result = workspace_graph(&info);
        assert!(result.sorted.is_empty());
        assert!(result.cycles.is_empty());
    }

    #[test]
    fn workspace_graph_linear_ordering() {
        // a depends on b, b has no deps → b should come before a
        let info = make_workspace_info(vec![
            ("a", vec!["b"]),
            ("b", vec![]),
        ]);
        let result = workspace_graph(&info);
        let a_pos = result.sorted.iter().position(|s| s == "a").unwrap();
        let b_pos = result.sorted.iter().position(|s| s == "b").unwrap();
        assert!(b_pos < a_pos, "b should come before a");
    }

    #[test]
    fn workspace_graph_independent_packages_no_cycles() {
        let info = make_workspace_info(vec![
            ("pkg-a", vec![]),
            ("pkg-b", vec![]),
            ("pkg-c", vec![]),
        ]);
        let result = workspace_graph(&info);
        assert!(result.cycles.is_empty());
        assert_eq!(result.sorted.len(), 3);
    }

    #[test]
    fn detect_workspaces_no_pkg_json_returns_error() {
        let tmp = std::env::temp_dir().join("ws-test-no-pkg");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = detect_workspaces(&tmp);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

