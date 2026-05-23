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

    // Parse lockfile to build dependency graph: key -> (name, version, Vec<(dep_name, dep_range)>)
    let graph = parse_lockfile_graph(&content)?;

    // Find target version
    let target_version = graph.iter()
        .find(|(_, (name, _, _))| name == target)
        .map(|(_, (_, ver, _))| ver.clone());

    // Find all packages that depend on target (with range)
    let mut depended_on_by = Vec::new();
    for (_, (name, version, deps)) in &graph {
        for (dep_name, dep_range) in deps {
            if dep_name == target {
                depended_on_by.push((name.clone(), version.clone(), dep_range.clone()));
                break;
            }
        }
    }

    // Build adjacency map: name -> [dep_names]
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    let mut root_deps: Vec<String> = Vec::new();
    for (path, (name, _, deps)) in &graph {
        let segments: Vec<&str> = path.split("node_modules/").filter(|s| !s.is_empty()).collect();
        if segments.len() == 1 {
            root_deps.push(name.clone());
        }
        for (dep_name, _) in deps {
            adj.entry(name.clone()).or_default().push(dep_name.clone());
        }
    }
    adj.insert("(root)".to_string(), root_deps);

    // BFS to find paths from root to target (limit to 10), strip "(root)" prefix
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
                    // Strip leading "(root)" for display
                    let display_path: Vec<String> = new_path.into_iter().skip(1).collect();
                    paths.push(display_path);
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

// Graph value: (name, version, Vec<(dep_name, dep_range)>)
fn parse_lockfile_graph(json: &str) -> Result<HashMap<String, (String, String, Vec<(String, String)>)>, String> {
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
                let deps = extract_dep_entries(&entry_data);

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

fn extract_dep_entries(entry_json: &str) -> Vec<(String, String)> {
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

    let mut entries = Vec::new();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut current = String::new();
    let mut reading_key = false;
    let mut reading_val = false;
    let mut current_key = String::new();

    for ch in section.chars() {
        if esc {
            if reading_key { current.push(ch); }
            else if reading_val { current.push(ch); }
            esc = false;
            continue;
        }
        if ch == '\\' && in_str { esc = true; continue; }
        if ch == '"' {
            in_str = !in_str;
            if depth == 1 {
                if !reading_val && in_str && current_key.is_empty() {
                    reading_key = true; current.clear();
                } else if reading_key && !in_str {
                    reading_key = false;
                    current_key = current.clone();
                    current.clear();
                } else if !reading_val && in_str && !current_key.is_empty() {
                    reading_val = true; current.clear();
                } else if reading_val && !in_str {
                    reading_val = false;
                    if !current_key.is_empty() {
                        entries.push((current_key.clone(), current.clone()));
                    }
                    current_key.clear();
                    current.clear();
                }
            }
            continue;
        }
        if in_str {
            if reading_key { current.push(ch); }
            else if reading_val { current.push(ch); }
            continue;
        }
        match ch {
            '{' => depth += 1,
            '}' => { depth -= 1; if depth == 0 { break; } }
            ',' if depth == 1 => { current_key.clear(); current.clear(); }
            _ => {}
        }
    }
    entries
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_missing_lockfile_errors() {
        let result = trace_dependency(
            std::path::Path::new("/nonexistent"),
            std::path::Path::new("/nonexistent/package-lock.json"),
            "lodash",
        );
        assert!(result.is_err());
    }

    #[test]
    fn parse_lockfile_graph_missing_packages_errors() {
        let result = parse_lockfile_graph("{}");
        assert!(result.is_err());
    }

    #[test]
    fn parse_lockfile_graph_parses_simple_package() {
        let json = r#"{"packages":{"node_modules/lodash":{"name":"lodash","version":"4.17.21","dependencies":{}}}}"#;
        let graph = parse_lockfile_graph(json).unwrap();
        assert!(!graph.is_empty());
    }

    #[test]
    fn parse_lockfile_graph_empty_packages_returns_empty() {
        let json = r#"{"packages":{}}"#;
        let graph = parse_lockfile_graph(json).unwrap();
        assert!(graph.is_empty());
    }

    #[test]
    fn parse_lockfile_graph_extracts_version() {
        let json = r#"{"packages":{"node_modules/express":{"name":"express","version":"4.18.2","dependencies":{}}}}"#;
        let graph = parse_lockfile_graph(json).unwrap();
        let (_, ver, _) = graph.get("node_modules/express").unwrap();
        assert_eq!(ver, "4.18.2");
    }

    #[test]
    fn extract_dep_names_parses_single_dep() {
        let entry = r#""version":"1.0.0","dependencies":{"debug":"^2.0.0"}"#;
        let names = extract_dep_names(entry);
        assert!(names.contains(&"debug".to_string()));
    }

    #[test]
    fn extract_dep_names_no_deps_returns_empty() {
        let entry = r#""version":"1.0.0""#;
        let names = extract_dep_names(entry);
        assert!(names.is_empty());
    }

    #[test]
    fn parse_lockfile_graph_extracts_deps() {
        let json = r#"{"packages":{"node_modules/express":{"name":"express","version":"4.18.2","dependencies":{"debug":"^2.0.0"}}}}"#;
        let graph = parse_lockfile_graph(json).unwrap();
        let (_, _, deps) = graph.get("node_modules/express").unwrap();
        assert!(deps.contains(&"debug".to_string()));
    }
}
