// crates/better-core/src/graph.rs
// Dependency graph construction and analysis

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct DepNode {
    pub name: String,
    pub version: String,
    pub deps: Vec<String>,
    pub is_direct: bool,
    pub dep_type: String, // "prod" | "dev" | "transitive"
}

#[derive(Debug)]
pub struct DepGraph {
    pub nodes: HashMap<String, DepNode>,
    pub root_name: String,
    pub root_version: String,
}

#[derive(Debug)]
pub struct CycleReport {
    pub cycles: Vec<Vec<String>>,
    pub has_cycles: bool,
}

impl DepGraph {
    /// Build a DepGraph from a package-lock.json path.
    pub fn from_lockfile(project_root: &Path) -> Result<DepGraph, String> {
        let lock_path = project_root.join("package-lock.json");
        let pkg_path = project_root.join("package.json");

        let lock_content = fs::read_to_string(&lock_path)
            .map_err(|e| format!("Cannot read package-lock.json: {}", e))?;
        let pkg_content = fs::read_to_string(&pkg_path).unwrap_or_default();

        let root_name = extract_field_str(&pkg_content, "name").unwrap_or("project".to_string());
        let root_version = extract_field_str(&pkg_content, "version").unwrap_or("0.0.0".to_string());

        let mut nodes: HashMap<String, DepNode> = HashMap::new();
        let mut direct_prod: HashSet<String> = HashSet::new();
        let mut direct_dev: HashSet<String> = HashSet::new();

        // Parse direct deps from package.json
        if let Some(deps_start) = pkg_content.find("\"dependencies\"") {
            let section = &pkg_content[deps_start..];
            if let Some(brace) = section.find('{') {
                let inner = &section[brace + 1..];
                if let Some(end) = inner.find('}') {
                    let body = &inner[..end];
                    for part in body.split('"').collect::<Vec<_>>().chunks(4) {
                        if part.len() >= 2 && !part[1].is_empty() {
                            direct_prod.insert(part[1].to_string());
                        }
                    }
                }
            }
        }
        if let Some(deps_start) = pkg_content.find("\"devDependencies\"") {
            let section = &pkg_content[deps_start..];
            if let Some(brace) = section.find('{') {
                let inner = &section[brace + 1..];
                if let Some(end) = inner.find('}') {
                    let body = &inner[..end];
                    for part in body.split('"').collect::<Vec<_>>().chunks(4) {
                        if part.len() >= 2 && !part[1].is_empty() {
                            direct_dev.insert(part[1].to_string());
                        }
                    }
                }
            }
        }

        // Parse packages from lock
        let packages_marker = "\"packages\"";
        if let Some(start) = lock_content.find(packages_marker) {
            let after = &lock_content[start + packages_marker.len()..];
            // Simple tokenizer: find each "node_modules/..." entry
            let mut pos = 0;
            while pos < after.len() {
                // Find next "node_modules/
                if let Some(nm_pos) = after[pos..].find("\"node_modules/") {
                    let abs_pos = pos + nm_pos;
                    let key_start = abs_pos + 1; // skip opening quote
                    if let Some(key_end) = after[key_start..].find('"') {
                        let full_path = &after[key_start..key_start + key_end];
                        // Extract package name (last node_modules/ segment)
                        let name = full_path
                            .rsplit("node_modules/")
                            .next()
                            .unwrap_or(full_path)
                            .to_string();

                        if !name.is_empty() && !name.contains("/node_modules/") {
                            // Find the object for this package
                            let obj_start = key_start + key_end + 2; // skip `": `
                            if let Some(brace_pos) = after[obj_start..].find('{') {
                                let obj_abs = obj_start + brace_pos;
                                let obj_body = extract_object_body(&after[obj_abs..]);

                                let version = extract_field_str(obj_body, "version")
                                    .unwrap_or("?".to_string());

                                let mut deps = vec![];
                                if let Some(dep_start) = obj_body.find("\"dependencies\"") {
                                    let dep_sec = &obj_body[dep_start..];
                                    if let Some(b) = dep_sec.find('{') {
                                        let inner = &dep_sec[b + 1..];
                                        if let Some(e) = inner.find('}') {
                                            for chunk in inner[..e].split('"').collect::<Vec<_>>().chunks(4) {
                                                if chunk.len() >= 2 && !chunk[1].is_empty() && !chunk[1].contains(':') {
                                                    deps.push(chunk[1].to_string());
                                                }
                                            }
                                        }
                                    }
                                }

                                let dep_type = if direct_prod.contains(&name) {
                                    "prod".to_string()
                                } else if direct_dev.contains(&name) {
                                    "dev".to_string()
                                } else {
                                    "transitive".to_string()
                                };

                                let is_direct = direct_prod.contains(&name) || direct_dev.contains(&name);

                                nodes.insert(name.clone(), DepNode {
                                    name: name.clone(),
                                    version,
                                    deps,
                                    is_direct,
                                    dep_type,
                                });
                            }
                        }
                        pos = abs_pos + 1;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
        }

        Ok(DepGraph { nodes, root_name, root_version })
    }

    /// Find all dependency paths from the root to a target package.
    pub fn find_paths(&self, target: &str, max_depth: usize) -> Vec<Vec<String>> {
        let mut all_paths = vec![];
        let direct_deps: Vec<String> = self.nodes.values()
            .filter(|n| n.is_direct)
            .map(|n| n.name.clone())
            .collect();

        fn dfs(
            graph: &DepGraph,
            current: &str,
            target: &str,
            path: &mut Vec<String>,
            all_paths: &mut Vec<Vec<String>>,
            visited: &mut HashSet<String>,
            max_depth: usize,
        ) {
            if path.len() > max_depth { return; }
            if current == target {
                all_paths.push(path.clone());
                return;
            }
            if let Some(node) = graph.nodes.get(current) {
                for dep in &node.deps {
                    if !visited.contains(dep) {
                        visited.insert(dep.clone());
                        path.push(dep.clone());
                        dfs(graph, dep, target, path, all_paths, visited, max_depth);
                        path.pop();
                        visited.remove(dep);
                    }
                }
            }
        }

        for start in &direct_deps {
            if start == target {
                all_paths.push(vec![start.clone()]);
                continue;
            }
            let mut visited = HashSet::new();
            visited.insert(start.clone());
            let mut path = vec![start.clone()];
            dfs(self, start, target, &mut path, &mut all_paths, &mut visited, max_depth);
        }

        all_paths.sort_by_key(|p| p.len());
        all_paths
    }

    /// Find all circular dependency cycles using DFS.
    pub fn find_cycles(&self) -> CycleReport {
        let mut cycles = vec![];
        let mut visited: HashSet<String> = HashSet::new();

        fn dfs_cycle(
            graph: &DepGraph,
            name: &str,
            stack: &mut Vec<String>,
            visited: &mut HashSet<String>,
            cycles: &mut Vec<Vec<String>>,
        ) {
            if let Some(idx) = stack.iter().position(|s| s == name) {
                let cycle = stack[idx..].to_vec();
                cycles.push(cycle);
                return;
            }
            if visited.contains(name) { return; }
            visited.insert(name.to_string());
            stack.push(name.to_string());
            if let Some(node) = graph.nodes.get(name) {
                for dep in &node.deps {
                    dfs_cycle(graph, dep, stack, visited, cycles);
                }
            }
            stack.pop();
        }

        let direct: Vec<String> = self.nodes.values()
            .filter(|n| n.is_direct)
            .map(|n| n.name.clone())
            .collect();

        for name in &direct {
            dfs_cycle(self, name, &mut vec![], &mut visited, &mut cycles);
        }

        let has_cycles = !cycles.is_empty();
        CycleReport { cycles, has_cycles }
    }

    /// Generate DOT format string.
    pub fn to_dot(&self, max_depth: usize) -> String {
        let mut lines = vec![
            format!("digraph \"{}\" {{", self.root_name),
            "  rankdir=LR;".to_string(),
            "  node [shape=box fontname=\"monospace\"];".to_string(),
        ];

        let direct: Vec<String> = self.nodes.values()
            .filter(|n| n.is_direct)
            .map(|n| n.name.clone())
            .collect();

        let mut seen_edges: HashSet<String> = HashSet::new();

        fn traverse(
            graph: &DepGraph,
            name: &str,
            depth: usize,
            max_depth: usize,
            seen: &mut HashSet<String>,
            lines: &mut Vec<String>,
        ) {
            if depth > max_depth { return; }
            if let Some(node) = graph.nodes.get(name) {
                for dep in &node.deps {
                    let edge = format!("  \"{}\" -> \"{}\";", name, dep);
                    if !seen.contains(&edge) {
                        seen.insert(edge.clone());
                        lines.push(edge);
                        traverse(graph, dep, depth + 1, max_depth, seen, lines);
                    }
                }
            }
        }

        for name in &direct {
            traverse(self, name, 0, max_depth, &mut seen_edges, &mut lines);
        }

        lines.push("}".to_string());
        lines.join("\n")
    }
}

fn extract_field_str(json: &str, field: &str) -> Option<String> {
    let key = format!("\"{}\"", field);
    let pos = json.find(&key)?;
    let after = &json[pos + key.len()..];
    let colon = after.find(':')?;
    let val_start = &after[colon + 1..].trim_start_matches(|c: char| c == ' ' || c == '\t');
    if val_start.starts_with('"') {
        let inner = &val_start[1..];
        let end = inner.find('"')?;
        Some(inner[..end].to_string())
    } else {
        None
    }
}

fn extract_object_body(s: &str) -> &str {
    let depth_start = s.find('{').unwrap_or(0);
    let inner = &s[depth_start + 1..];
    let mut depth = 1;
    for (i, c) in inner.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &inner[..i];
                }
            }
            _ => {}
        }
    }
    inner
}

/// Compute graph stats for JSON output.
pub fn graph_stats(project_root: &Path) -> Result<String, String> {
    let graph = DepGraph::from_lockfile(project_root)?;
    let cycle_report = graph.find_cycles();

    let total = graph.nodes.len();
    let direct = graph.nodes.values().filter(|n| n.is_direct).count();
    let max_depth = compute_max_depth(&graph);

    Ok(format!(
        r#"{{"ok":true,"kind":"better.graph.stats","total":{total},"direct":{direct},"transitive":{transitive},"has_cycles":{has_cycles},"cycle_count":{cycle_count},"max_depth":{max_depth}}}"#,
        total = total,
        direct = direct,
        transitive = total - direct,
        has_cycles = cycle_report.has_cycles,
        cycle_count = cycle_report.cycles.len(),
        max_depth = max_depth,
    ))
}

fn compute_max_depth(graph: &DepGraph) -> usize {
    let direct: Vec<String> = graph.nodes.values()
        .filter(|n| n.is_direct)
        .map(|n| n.name.clone())
        .collect();

    fn depth(graph: &DepGraph, name: &str, visited: &mut HashSet<String>) -> usize {
        if visited.contains(name) { return 0; }
        visited.insert(name.to_string());
        let node = match graph.nodes.get(name) {
            Some(n) => n,
            None => return 0,
        };
        let max_child = node.deps.iter()
            .map(|d| depth(graph, d, visited))
            .max()
            .unwrap_or(0);
        visited.remove(name);
        max_child + 1
    }

    direct.iter()
        .map(|name| depth(graph, name, &mut HashSet::new()))
        .max()
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_graph(nodes: &[(&str, &str, &[&str], bool)]) -> DepGraph {
        let mut map = HashMap::new();
        for (name, version, deps, is_direct) in nodes {
            map.insert(name.to_string(), DepNode {
                name: name.to_string(),
                version: version.to_string(),
                deps: deps.iter().map(|s| s.to_string()).collect(),
                is_direct: *is_direct,
                dep_type: if *is_direct { "prod".to_string() } else { "transitive".to_string() },
            });
        }
        DepGraph { nodes: map, root_name: "my-app".to_string(), root_version: "1.0.0".to_string() }
    }

    #[test]
    fn find_paths_direct_dep() {
        let graph = make_graph(&[
            ("express", "4.18.2", &["lodash"], true),
            ("lodash", "4.17.21", &[], false),
        ]);
        let paths = graph.find_paths("express", 10);
        assert!(!paths.is_empty());
        assert!(paths.iter().any(|p| p.contains(&"express".to_string())));
    }

    #[test]
    fn find_paths_transitive_dep() {
        let graph = make_graph(&[
            ("a", "1.0.0", &["b"], true),
            ("b", "1.0.0", &["c"], false),
            ("c", "1.0.0", &[], false),
        ]);
        let paths = graph.find_paths("c", 10);
        assert!(!paths.is_empty());
    }

    #[test]
    fn find_cycles_no_cycle() {
        let graph = make_graph(&[
            ("a", "1.0.0", &["b"], true),
            ("b", "1.0.0", &[], false),
        ]);
        let report = graph.find_cycles();
        assert!(!report.has_cycles);
        assert!(report.cycles.is_empty());
    }

    #[test]
    fn to_dot_contains_edges() {
        let graph = make_graph(&[
            ("react", "18.0.0", &["react-dom"], true),
            ("react-dom", "18.0.0", &[], false),
        ]);
        let dot = graph.to_dot(5);
        assert!(dot.starts_with("digraph"));
        assert!(dot.contains("react") && dot.contains("react-dom"));
    }

    #[test]
    fn from_lockfile_missing_file_returns_error() {
        let result = DepGraph::from_lockfile(Path::new("/nonexistent-graph-project"));
        assert!(result.is_err());
    }

    #[test]
    fn from_lockfile_parses_packages() {
        let tmp = std::env::temp_dir().join("graph-test-lock");
        std::fs::create_dir_all(&tmp).unwrap();

        let lock = r#"{
            "name": "my-app",
            "version": "1.0.0",
            "lockfileVersion": 3,
            "packages": {
                "": { "name": "my-app", "version": "1.0.0", "dependencies": { "lodash": "^4.17.21" } },
                "node_modules/lodash": { "version": "4.17.21", "resolved": "", "integrity": "" }
            }
        }"#;
        let pkg = r#"{"name":"my-app","version":"1.0.0","dependencies":{"lodash":"^4.17.21"}}"#;

        let mut f = std::fs::File::create(tmp.join("package-lock.json")).unwrap();
        f.write_all(lock.as_bytes()).unwrap();
        let mut f2 = std::fs::File::create(tmp.join("package.json")).unwrap();
        f2.write_all(pkg.as_bytes()).unwrap();

        let graph = DepGraph::from_lockfile(&tmp).unwrap();
        assert!(graph.nodes.contains_key("lodash"));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
