use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::extract_json_object_pairs;

// Prefixes that should be excluded from unused detection:
// - @types/* (imported implicitly by TypeScript)
// - Config/plugin packages (used by tools, not imported directly)
const EXCLUDE_PREFIXES: &[&str] = &[
    "@types/",
    "eslint-config-",
    "eslint-plugin-",
    "babel-plugin-",
    "babel-preset-",
    "postcss-",
    "@postcss/",
    "prettier-plugin-",
    "typescript",
    "@eslint/",
    "stylelint-",
];

pub struct UnusedPackage {
    pub name: String,
    pub version: String,
    pub is_dev: bool,
    pub possible_script_use: bool,
}

pub struct UnusedResult {
    pub unused: Vec<UnusedPackage>,
    pub maybe_unused: Vec<UnusedPackage>,
    pub scanned_files: usize,
    pub total_deps: usize,
}

/// Detect unused dependencies by scanning source files for imports and
/// cross-referencing with package.json dependencies.
pub fn detect_unused(project_root: &Path) -> Result<UnusedResult, String> {
    let pkg_json_path = project_root.join("package.json");
    let pkg_content = fs::read_to_string(&pkg_json_path)
        .map_err(|e| format!("Failed to read package.json: {}", e))?;

    let deps = extract_json_object_pairs(&pkg_content, "dependencies")
        .unwrap_or_default();
    let dev_deps = extract_json_object_pairs(&pkg_content, "devDependencies")
        .unwrap_or_default();
    let scripts = extract_json_object_pairs(&pkg_content, "scripts")
        .unwrap_or_default();

    let deps_map: HashMap<String, String> = deps.into_iter().collect();
    let dev_deps_map: HashMap<String, String> = dev_deps.into_iter().collect();
    let scripts_map: HashMap<String, String> = scripts.into_iter().collect();

    // Scan source files for import specifiers
    let (imported, scanned_files) = scan_imports(project_root);

    // Extract package references from scripts
    let script_refs: HashSet<String> = scripts_map
        .values()
        .flat_map(|cmd| extract_package_refs_from_script(cmd))
        .collect();

    let mut unused = Vec::new();
    let mut maybe_unused = Vec::new();

    let all_deps: Vec<(&String, &String, bool)> = deps_map
        .iter()
        .map(|(k, v)| (k, v, false))
        .chain(dev_deps_map.iter().map(|(k, v)| (k, v, true)))
        .collect();

    let total_deps = all_deps.len();

    for (name, version, is_dev) in &all_deps {
        if EXCLUDE_PREFIXES.iter().any(|p| name.starts_with(p)) {
            continue;
        }

        if !imported.contains(*name) {
            let in_scripts = script_refs.contains(*name);
            let pkg = UnusedPackage {
                name: name.to_string(),
                version: version.to_string(),
                is_dev: *is_dev,
                possible_script_use: in_scripts,
            };
            if in_scripts {
                maybe_unused.push(pkg);
            } else {
                unused.push(pkg);
            }
        }
    }

    Ok(UnusedResult {
        unused,
        maybe_unused,
        scanned_files,
        total_deps,
    })
}

/// Scan JS/TS files for import/require statements.
/// Returns a set of bare specifier package names and the count of files scanned.
fn scan_imports(project_root: &Path) -> (HashSet<String>, usize) {
    let mut packages = HashSet::new();

    let scan_dirs = [
        "src", "lib", "app", "pages", "components", "server", "scripts",
    ];
    let extensions: &[&str] = &["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"];

    let mut files_to_scan = Vec::new();

    for dir in &scan_dirs {
        let dir_path = project_root.join(dir);
        if dir_path.is_dir() {
            walk_dir(&dir_path, extensions, &mut files_to_scan);
        }
    }

    // Also scan root-level files
    if let Ok(entries) = fs::read_dir(project_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if extensions.contains(&ext) {
                        files_to_scan.push(path);
                    }
                }
            }
        }
    }

    let file_count = files_to_scan.len();

    for file in &files_to_scan {
        if let Ok(content) = fs::read_to_string(file) {
            extract_imports_from_content(&content, &mut packages);
        }
    }

    (packages, file_count)
}

/// Extract import specifiers from file content without regex.
/// Handles: import ... from 'X', require('X'), import('X'), export ... from 'X'
fn extract_imports_from_content(content: &str, packages: &mut HashSet<String>) {
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        // Skip single-line comments
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Skip multi-line comments
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        // Skip string literals (to avoid false positives inside strings)
        if bytes[i] == b'`' {
            i += 1;
            while i < len && bytes[i] != b'`' {
                if bytes[i] == b'\\' { i += 1; }
                i += 1;
            }
            i += 1;
            continue;
        }

        // Check for 'from' keyword (import/export ... from 'specifier')
        if i + 4 < len && &bytes[i..i + 4] == b"from" && !is_ident_char(bytes.get(i + 4).copied()) && (i == 0 || !is_ident_char(Some(bytes[i - 1]))) {
            i += 4;
            // Skip whitespace
            while i < len && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if let Some((spec, end)) = extract_string_literal(bytes, i) {
                if let Some(pkg) = extract_package_name_from_specifier(&spec) {
                    packages.insert(pkg);
                }
                i = end;
                continue;
            }
        }

        // Check for require('specifier') or import('specifier')
        if (i + 7 < len && &bytes[i..i + 7] == b"require" && !is_ident_char(bytes.get(i.wrapping_sub(1)).copied()))
            || (i + 6 < len && &bytes[i..i + 6] == b"import" && !is_ident_char(bytes.get(i.wrapping_sub(1)).copied()))
        {
            let keyword_len = if bytes[i] == b'r' { 7 } else { 6 };
            let mut j = i + keyword_len;
            // Skip whitespace
            while j < len && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < len && bytes[j] == b'(' {
                j += 1;
                // Skip whitespace
                while j < len && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if let Some((spec, end)) = extract_string_literal(bytes, j) {
                    if let Some(pkg) = extract_package_name_from_specifier(&spec) {
                        packages.insert(pkg);
                    }
                    i = end;
                    continue;
                }
            }
        }

        i += 1;
    }
}

fn is_ident_char(ch: Option<u8>) -> bool {
    match ch {
        Some(c) => c.is_ascii_alphanumeric() || c == b'_' || c == b'$',
        None => false,
    }
}

/// Extract a string literal (single or double quoted) starting at position i.
/// Returns the string content and the position after the closing quote.
fn extract_string_literal(bytes: &[u8], i: usize) -> Option<(String, usize)> {
    if i >= bytes.len() {
        return None;
    }
    let quote = bytes[i];
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    let mut j = i + 1;
    let mut s = String::new();
    while j < bytes.len() {
        if bytes[j] == b'\\' {
            j += 2;
            continue;
        }
        if bytes[j] == quote {
            return Some((s, j + 1));
        }
        s.push(bytes[j] as char);
        j += 1;
    }
    None
}

/// Extract package name from a bare specifier.
/// "lodash/fp" -> "lodash"
/// "@scope/pkg/deep" -> "@scope/pkg"
/// "./local" -> None (relative)
fn extract_package_name_from_specifier(spec: &str) -> Option<String> {
    if spec.starts_with('.') || spec.starts_with('/') {
        return None;
    }
    if spec.starts_with('@') {
        let parts: Vec<&str> = spec.splitn(3, '/').collect();
        if parts.len() >= 2 {
            Some(format!("{}/{}", parts[0], parts[1]))
        } else {
            None
        }
    } else {
        Some(spec.split('/').next().unwrap_or(spec).to_string())
    }
}

/// Walk directory recursively, collecting files with matching extensions.
fn walk_dir(dir: &Path, extensions: &[&str], files: &mut Vec<PathBuf>) {
    let ignore_dirs = [
        "node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__",
    ];
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !ignore_dirs.contains(&name) && !name.starts_with('.') {
                    walk_dir(&path, extensions, files);
                }
            } else if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if extensions.contains(&ext) {
                        files.push(path);
                    }
                }
            }
        }
    }
}

/// Extract package names that might be referenced in npm scripts.
fn extract_package_refs_from_script(cmd: &str) -> Vec<String> {
    cmd.split_whitespace()
        .filter(|w| !w.starts_with('-') && !w.starts_with('/') && !w.starts_with('.'))
        .filter(|w| !["&&", "||", "|", ";", "npx", "node", "better", "npm", "pnpm", "yarn"].contains(w))
        .map(|w| w.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_package_name_from_specifier() {
        assert_eq!(extract_package_name_from_specifier("lodash"), Some("lodash".into()));
        assert_eq!(extract_package_name_from_specifier("lodash/fp"), Some("lodash".into()));
        assert_eq!(extract_package_name_from_specifier("@scope/pkg"), Some("@scope/pkg".into()));
        assert_eq!(extract_package_name_from_specifier("@scope/pkg/deep"), Some("@scope/pkg".into()));
        assert_eq!(extract_package_name_from_specifier("./local"), None);
        assert_eq!(extract_package_name_from_specifier("/absolute"), None);
        assert_eq!(extract_package_name_from_specifier("@types/node"), Some("@types/node".into()));
    }

    #[test]
    fn test_extract_imports_from_content() {
        let mut pkgs = HashSet::new();

        let content = r#"
import lodash from "lodash";
import { merge } from 'lodash/merge';
const express = require('express');
const path = require("path");
import("chalk").then(m => m.default);
export { foo } from '@scope/pkg';
import type { Bar } from '@types/bar';
// import ignored from "commented-out";
/* import also from "block-comment"; */
import relative from "./local";
        "#;

        extract_imports_from_content(content, &mut pkgs);

        assert!(pkgs.contains("lodash"));
        assert!(pkgs.contains("express"));
        assert!(pkgs.contains("path"));
        assert!(pkgs.contains("chalk"));
        assert!(pkgs.contains("@scope/pkg"));
        assert!(pkgs.contains("@types/bar"));
        assert!(!pkgs.contains("commented-out"));
        assert!(!pkgs.contains("block-comment"));
        assert!(!pkgs.contains("./local"));
    }

    #[test]
    fn test_extract_package_refs_from_script() {
        let refs = extract_package_refs_from_script("tsc && jest --coverage");
        assert!(refs.contains(&"tsc".to_string()));
        assert!(refs.contains(&"jest".to_string()));
        assert!(!refs.contains(&"--coverage".to_string()));
    }
}
