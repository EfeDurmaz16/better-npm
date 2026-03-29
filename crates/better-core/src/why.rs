use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::Path;

use crate::types::WhyReport;
use crate::{extract_json_field, package_name_from_path};

// --- B.4: Dependency Tracer (why) ---

pub fn trace_dependency(project_root: &Path, lockfile: &Path, target: &str) -> Result<WhyReport, String> {
    let content = fs::read_to_string(lockfile)
        .map_err(|e| format!("Failed to read lockfile: {}", e))?;

    // Check if direct dependency
    let pkg_json_path = project_root.join("package.json");
    let pkg_json = fs::read_to_string(&pkg_json_path).unwrap_or_default();

    // Look in dependencies and devDependencies
    let is_direct = {
        let dep_check = format!("\"{}\"", target);
        let in_deps = if let Some(pos) = pkg_json.find("\"dependencies\"") {
            let section = &pkg_json[pos..];
            let end = section.find('}').unwrap_or(section.len());
            section[..end].contains(&dep_check)
        } else { false };
        let in_dev = if let Some(pos) = pkg_json.find("\"devDependencies\"") {
            let section = &pkg_json[pos..];
            let end = section.find('}').unwrap_or(section.len());
            section[..end].contains(&dep_check)
        } else { false };
        in_deps || in_dev
    };

    // Parse lockfile to build dependency graph
    let graph = parse_lockfile_graph(&content)?;

    // Find target version
    let target_version = graph.iter()
        .find(|(_, (name, _, _))| name == target)
        .map(|(_, (_, ver, _))| ver.clone());

    // Find all packages that depend on target
    let mut depended_on_by = Vec::new();
    for (_, (name, version, deps)) in &graph {
        if deps.iter().any(|d| d == target) {
            depended_on_by.push((name.clone(), version.clone()));
        }
    }

    // Build adjacency map: name -> [dep_names]
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    let mut root_deps: Vec<String> = Vec::new();
    for (path, (name, _, deps)) in &graph {
        // Direct deps: paths like "node_modules/foo" (no nested node_modules)
        let segments: Vec<&str> = path.split("node_modules/").filter(|s| !s.is_empty()).collect();
        if segments.len() == 1 {
            root_deps.push(name.clone());
        }
        adj.entry(name.clone()).or_default().extend(deps.clone());
    }
    adj.insert("(root)".to_string(), root_deps);

    // BFS to find paths from root to target (limit to 10)
    let mut paths: Vec<Vec<String>> = Vec::new();
    let mut queue: VecDeque<Vec<String>> = VecDeque::new();
    queue.push_back(vec!["(root)".to_string()]);

    while let Some(path) = queue.pop_front() {
        if paths.len() >= 10 { break; }
        if path.len() > 10 { continue; }

        let current = path.last().unwrap().clone();
        if let Some(deps) = adj.get(&current) {
            for dep in deps {
                let mut new_path = path.clone();
                new_path.push(dep.clone());
                if dep == target {
                    paths.push(new_path);
                } else if !path.contains(dep) {
                    queue.push_back(new_path);
                }
            }
        }
    }

    let total = paths.len() as u64;
    Ok(WhyReport {
        package: target.to_string(),
        version: target_version,
        is_direct,
        dependency_paths: paths,
        depended_on_by,
        total_paths: total,
    })
}

fn parse_lockfile_graph(json: &str) -> Result<HashMap<String, (String, String, Vec<String>)>, String> {
    let mut graph = HashMap::new();

    let packages_start = json.find("\"packages\"")
        .ok_or_else(|| "Missing packages in lockfile".to_string())?;
    let after = &json[packages_start..];
    let obj_start = after.find('{').ok_or_else(|| "Malformed lockfile".to_string())?;
    let packages_str = &after[obj_start..];

    let mut current_key = String::new();
    let mut in_string = false;
    let mut escape_next = false;
    let mut brace_depth = 0i32;
    let mut collecting_entry = false;
    let mut entry_data = String::new();
    let mut key_state = 0u8;

    for ch in packages_str.chars() {
        if escape_next {
            if key_state == 1 { current_key.push(ch); }
            else if collecting_entry { entry_data.push(ch); }
            escape_next = false;
            continue;
        }
        if ch == '\\' && in_string {
            escape_next = true;
            if key_state == 1 { current_key.push(ch); }
            else if collecting_entry { entry_data.push(ch); }
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            if brace_depth == 1 && !collecting_entry {
                if key_state == 0 && in_string { key_state = 1; current_key.clear(); }
                else if key_state == 1 && !in_string { key_state = 2; }
            } else if collecting_entry { entry_data.push(ch); }
            continue;
        }
        if in_string {
            if key_state == 1 { current_key.push(ch); }
            else if collecting_entry { entry_data.push(ch); }
            continue;
        }
        if ch == '{' {
            brace_depth += 1;
            if brace_depth == 2 && !current_key.is_empty() {
                collecting_entry = true;
                entry_data.clear();
                key_state = 0;
            }
            if collecting_entry && brace_depth > 2 { entry_data.push(ch); }
        } else if ch == '}' {
            if collecting_entry && brace_depth == 2 {
                let name = extract_json_field(&entry_data, "name")
                    .unwrap_or_else(|| package_name_from_path(&current_key));
                let version = extract_json_field(&entry_data, "version").unwrap_or_default();
                let deps = extract_dep_names(&entry_data);

                if !current_key.is_empty() {
                    graph.insert(current_key.clone(), (name, version, deps));
                }

                collecting_entry = false;
                entry_data.clear();
            } else if collecting_entry { entry_data.push(ch); }
            brace_depth -= 1;
            if brace_depth == 0 { break; }
            if brace_depth == 1 { key_state = 0; }
        } else if ch == ',' && brace_depth == 1 && !collecting_entry {
            key_state = 0;
        } else if collecting_entry {
            entry_data.push(ch);
        }
    }

    Ok(graph)
}

fn extract_dep_names(entry_json: &str) -> Vec<String> {
    let needle = "\"dependencies\"";
    let start = match entry_json.find(needle) {
        Some(pos) => pos,
        None => return Vec::new(),
    };
    let after = &entry_json[start + needle.len()..];
    let obj_start = match after.find('{') {
        Some(pos) => pos,
        None => return Vec::new(),
    };
    let section = &after[obj_start..];

    let mut names = Vec::new();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut current = String::new();
    let mut reading_key = false;
    let mut key_done = false;

    for ch in section.chars() {
        if esc { if reading_key { current.push(ch); } esc = false; continue; }
        if ch == '\\' && in_str { esc = true; continue; }
        if ch == '"' {
            in_str = !in_str;
            if depth == 1 {
                if !key_done && in_str { reading_key = true; current.clear(); }
                else if reading_key && !in_str {
                    reading_key = false; key_done = true;
                    if !current.is_empty() { names.push(current.clone()); }
                    current.clear();
                }
                else if key_done && !in_str { key_done = false; }
            }
            continue;
        }
        if in_str { if reading_key { current.push(ch); } continue; }
        match ch {
            '{' => depth += 1,
            '}' => { depth -= 1; if depth == 0 { break; } }
            ',' if depth == 1 => { key_done = false; }
            _ => {}
        }
    }
    names
}

