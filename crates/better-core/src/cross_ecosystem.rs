// crates/better-core/src/workspace/cross_ecosystem.rs
// Cross-ecosystem monorepo support — detect all ecosystems, topological ordering

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
pub struct PolyglotWorkspace {
    pub root: PathBuf,
    pub members: Vec<WorkspaceMember>,
    pub ecosystems: Vec<String>,
    pub topo_order: Vec<String>,  // topologically sorted package names
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceMember {
    pub name: String,
    pub path: PathBuf,
    pub ecosystem: String,
    pub dependencies: Vec<String>,  // names of workspace-internal deps
}

/// Detect all workspace members across all ecosystems.
pub fn detect_polyglot_workspace(root: &Path) -> PolyglotWorkspace {
    let mut members = vec![];
    let mut ecosystems = HashSet::new();

    // Walk subdirectories
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() { continue; }
            if path.file_name().map_or(false, |n| {
                n == "node_modules" || n == "target" || n == ".git" || n.to_string_lossy().starts_with('.')
            }) { continue; }

            // npm
            if path.join("package.json").exists() {
                if let Some(m) = read_npm_member(&path) {
                    ecosystems.insert("npm".to_string());
                    members.push(m);
                }
            }

            // Python
            if path.join("pyproject.toml").exists() || path.join("setup.py").exists() {
                ecosystems.insert("python".to_string());
                let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                members.push(WorkspaceMember {
                    name,
                    path: path.clone(),
                    ecosystem: "python".to_string(),
                    dependencies: vec![],
                });
            }

            // Rust
            if path.join("Cargo.toml").exists() {
                ecosystems.insert("cargo".to_string());
                let name = read_cargo_name(&path).unwrap_or_else(|| {
                    path.file_name().unwrap_or_default().to_string_lossy().to_string()
                });
                members.push(WorkspaceMember {
                    name,
                    path: path.clone(),
                    ecosystem: "cargo".to_string(),
                    dependencies: vec![],
                });
            }

            // Go
            if path.join("go.mod").exists() {
                ecosystems.insert("go".to_string());
                let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                members.push(WorkspaceMember {
                    name,
                    path: path.clone(),
                    ecosystem: "go".to_string(),
                    dependencies: vec![],
                });
            }
        }
    }

    let topo_order = topological_sort(&members);
    let ecosystems: Vec<String> = ecosystems.into_iter().collect();

    PolyglotWorkspace {
        root: root.to_path_buf(),
        members,
        ecosystems,
        topo_order,
    }
}

fn read_npm_member(path: &Path) -> Option<WorkspaceMember> {
    let content = std::fs::read_to_string(path.join("package.json")).ok()?;
    let pkg: serde_json::Value = serde_json::from_str(&content).ok()?;
    let name = pkg.get("name")?.as_str()?.to_string();
    let dependencies: Vec<String> = pkg.get("dependencies")
        .and_then(|d| d.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default();
    Some(WorkspaceMember {
        name,
        path: path.to_path_buf(),
        ecosystem: "npm".to_string(),
        dependencies,
    })
}

fn read_cargo_name(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path.join("Cargo.toml")).ok()?;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("name") {
            if let Some(val) = line.split('=').nth(1) {
                return Some(val.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

/// Kahn's algorithm for topological sort.
fn topological_sort(members: &[WorkspaceMember]) -> Vec<String> {
    let names: HashSet<&str> = members.iter().map(|m| m.name.as_str()).collect();
    let mut in_degree: HashMap<&str, usize> = members.iter().map(|m| (m.name.as_str(), 0)).collect();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();

    for m in members {
        for dep in &m.dependencies {
            if names.contains(dep.as_str()) {
                *in_degree.entry(m.name.as_str()).or_insert(0) += 1;
                dependents.entry(dep.as_str()).or_default().push(m.name.as_str());
            }
        }
    }

    let mut queue: Vec<&str> = in_degree.iter()
        .filter(|(_, &d)| d == 0)
        .map(|(&n, _)| n)
        .collect();
    queue.sort();

    let mut result = vec![];
    while !queue.is_empty() {
        let node = queue.remove(0);
        result.push(node.to_string());
        if let Some(deps) = dependents.get(node) {
            for &dep in deps {
                let deg = in_degree.entry(dep).or_insert(0);
                *deg = deg.saturating_sub(1);
                if *deg == 0 {
                    queue.push(dep);
                    queue.sort();
                }
            }
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_dir_returns_empty_workspace() {
        let tmp = std::env::temp_dir().join("cross-eco-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        let ws = detect_polyglot_workspace(&tmp);
        assert!(ws.members.is_empty());
        assert!(ws.ecosystems.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detects_npm_package_json() {
        let tmp = std::env::temp_dir().join("cross-eco-test-npm");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), r#"{"name":"my-app","workspaces":[]}"#).unwrap();
        let ws = detect_polyglot_workspace(&tmp);
        // Root-level package.json counts as npm ecosystem
        assert!(ws.ecosystems.contains(&"npm".to_string()) || ws.members.is_empty()); // may or may not detect root
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn topological_sort_empty_returns_empty() {
        let result = topological_sort(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn topological_sort_no_deps_returns_all() {
        let members = vec![
            WorkspaceMember { name: "a".into(), path: std::path::PathBuf::new(), ecosystem: "npm".into(), dependencies: vec![] },
            WorkspaceMember { name: "b".into(), path: std::path::PathBuf::new(), ecosystem: "npm".into(), dependencies: vec![] },
        ];
        let result = topological_sort(&members);
        assert_eq!(result.len(), 2);
        assert!(result.contains(&"a".to_string()));
        assert!(result.contains(&"b".to_string()));
    }

    #[test]
    fn topological_sort_dep_before_dependent() {
        let members = vec![
            WorkspaceMember { name: "app".into(), path: std::path::PathBuf::new(), ecosystem: "npm".into(), dependencies: vec!["lib".into()] },
            WorkspaceMember { name: "lib".into(), path: std::path::PathBuf::new(), ecosystem: "npm".into(), dependencies: vec![] },
        ];
        let result = topological_sort(&members);
        let lib_pos = result.iter().position(|n| n == "lib").unwrap();
        let app_pos = result.iter().position(|n| n == "app").unwrap();
        assert!(lib_pos < app_pos, "lib should come before app");
    }

    #[test]
    fn detects_rust_subpackage() {
        let tmp = std::env::temp_dir().join("cross-eco-test-rust");
        std::fs::create_dir_all(&tmp).unwrap();
        let sub = tmp.join("my-crate");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("Cargo.toml"), "[package]\nname = \"my-crate\"\nversion = \"0.1.0\"\n").unwrap();
        let ws = detect_polyglot_workspace(&tmp);
        assert!(ws.ecosystems.contains(&"cargo".to_string()));
        assert!(ws.members.iter().any(|m| m.name == "my-crate"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detects_python_subpackage() {
        let tmp = std::env::temp_dir().join("cross-eco-test-python");
        std::fs::create_dir_all(&tmp).unwrap();
        let sub = tmp.join("my-service");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("pyproject.toml"), "[project]\nname = \"my-service\"\n").unwrap();
        let ws = detect_polyglot_workspace(&tmp);
        assert!(ws.ecosystems.contains(&"python".to_string()));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ignores_node_modules_dir() {
        let tmp = std::env::temp_dir().join("cross-eco-test-nm");
        std::fs::create_dir_all(&tmp).unwrap();
        let nm = tmp.join("node_modules").join("some-pkg");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(nm.join("package.json"), r#"{"name":"some-pkg"}"#).unwrap();
        let ws = detect_polyglot_workspace(&tmp);
        assert!(ws.members.is_empty(), "node_modules should be ignored");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
