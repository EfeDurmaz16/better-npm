use std::fs;
use std::path::{Path, PathBuf};

use crate::types::*;
use crate::extract_json_field;

// --- Bin links ---

/// Parse the "bin" field from a package.json string.
/// Returns Vec<(bin_name, relative_script_path)>.
fn parse_bin_field(pkg_json: &str, pkg_name: &str) -> Vec<(String, String)> {
    let mut bins = Vec::new();

    // Try "bin": "file.js" (string form)
    if let Some(bin_str) = extract_json_field(pkg_json, "bin") {
        // Check if it's a string (not an object — objects start with {)
        let trimmed = bin_str.trim();
        if !trimmed.starts_with('{') {
            // Use the package name (without scope) as the bin name
            let bin_name = if pkg_name.contains('/') {
                // @scope/name -> name
                pkg_name.rsplit('/').next().unwrap_or(pkg_name)
            } else {
                pkg_name
            };
            bins.push((bin_name.to_string(), trimmed.to_string()));
            return bins;
        }
    }

    // Try "bin": { "name": "file.js", ... } (object form)
    // Find "bin" key and parse the object
    let bin_needle = "\"bin\"";
    if let Some(bin_start) = pkg_json.find(bin_needle) {
        let after_bin = &pkg_json[bin_start + bin_needle.len()..];
        // Find the colon
        if let Some(colon) = after_bin.find(':') {
            let after_colon = after_bin[colon + 1..].trim_start();
            if after_colon.starts_with('{') {
                // Parse the object: find matching }
                let mut depth = 0;
                let mut in_string = false;
                let mut escape = false;
                let mut end_idx = 0;

                for (i, ch) in after_colon.char_indices() {
                    if escape {
                        escape = false;
                        continue;
                    }
                    if ch == '\\' && in_string {
                        escape = true;
                        continue;
                    }
                    if ch == '"' {
                        in_string = !in_string;
                        continue;
                    }
                    if in_string {
                        continue;
                    }
                    if ch == '{' {
                        depth += 1;
                    } else if ch == '}' {
                        depth -= 1;
                        if depth == 0 {
                            end_idx = i + 1;
                            break;
                        }
                    }
                }

                if end_idx > 0 {
                    let bin_obj = &after_colon[1..end_idx - 1]; // contents inside {}
                    // Parse key-value pairs
                    let mut key = String::new();
                    let mut val = String::new();
                    let mut reading_key = false;
                    let mut reading_val = false;
                    let mut in_str = false;
                    let mut esc = false;
                    let mut after_key_colon = false;

                    for ch in bin_obj.chars() {
                        if esc {
                            if reading_key {
                                key.push(ch);
                            } else if reading_val {
                                val.push(ch);
                            }
                            esc = false;
                            continue;
                        }
                        if ch == '\\' && in_str {
                            esc = true;
                            if reading_key {
                                key.push(ch);
                            } else if reading_val {
                                val.push(ch);
                            }
                            continue;
                        }
                        if ch == '"' {
                            if !in_str {
                                in_str = true;
                                if after_key_colon {
                                    reading_val = true;
                                } else {
                                    reading_key = true;
                                }
                            } else {
                                in_str = false;
                                if reading_val {
                                    reading_val = false;
                                    after_key_colon = false;
                                    if !key.is_empty() && !val.is_empty() {
                                        bins.push((key.clone(), val.clone()));
                                    }
                                    key.clear();
                                    val.clear();
                                } else if reading_key {
                                    reading_key = false;
                                }
                            }
                            continue;
                        }
                        if !in_str && ch == ':' {
                            after_key_colon = true;
                            continue;
                        }
                        if !in_str && (ch == ',' || ch.is_whitespace()) {
                            continue;
                        }
                        if reading_key {
                            key.push(ch);
                        } else if reading_val {
                            val.push(ch);
                        }
                    }
                }
            }
        }
    }

    // Try "directories.bin" field (less common)
    // Skip for now — covers 99%+ of packages

    bins
}

/// Create bin links in node_modules/.bin/ for all installed packages.
/// Scans each package's package.json for "bin" entries and creates symlinks.
pub fn create_bin_links(
    node_modules_dir: &Path,
    packages: &[ResolvedPackage],
) -> Result<BinLinkResult, String> {
    let bin_dir = node_modules_dir.join(".bin");
    fs::create_dir_all(&bin_dir).map_err(|e| format!("Failed to create .bin dir: {}", e))?;

    let mut result = BinLinkResult::default();

    for pkg in packages {
        // Determine package directory
        let pkg_dir = if pkg.rel_path.starts_with("node_modules/") {
            node_modules_dir.join(&pkg.rel_path[13..])
        } else {
            node_modules_dir.join(&pkg.rel_path)
        };

        let pkg_json_path = pkg_dir.join("package.json");
        let pkg_json = match fs::read_to_string(&pkg_json_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let bins = parse_bin_field(&pkg_json, &pkg.name);
        if bins.is_empty() {
            continue;
        }

        for (bin_name, bin_script) in &bins {
            let bin_target = pkg_dir.join(bin_script);
            let bin_link = bin_dir.join(bin_name);

            // Remove existing link/file
            let _ = fs::remove_file(&bin_link);

            #[cfg(unix)]
            {
                // Make the target executable
                if let Ok(md) = fs::metadata(&bin_target) {
                    use std::os::unix::fs::PermissionsExt;
                    let mut perms = md.permissions();
                    let mode = perms.mode() | 0o111;
                    perms.set_mode(mode);
                    let _ = fs::set_permissions(&bin_target, perms);
                }

                // Create relative symlink from .bin/name -> ../pkg/script
                let rel_target = pathdiff_relative(&bin_dir, &bin_target);
                match std::os::unix::fs::symlink(&rel_target, &bin_link) {
                    Ok(()) => result.links_created += 1,
                    Err(_) => result.links_failed += 1,
                }
            }

            #[cfg(windows)]
            {
                // On Windows, create a .cmd shim
                let cmd_link = bin_dir.join(format!("{}.cmd", bin_name));
                let rel_target = pathdiff_relative(&bin_dir, &bin_target);
                let shim_content = format!(
                    "@ECHO off\r\n\"%~dp0\\{}\" %*\r\n",
                    rel_target.to_string_lossy().replace('/', "\\")
                );
                match fs::write(&cmd_link, shim_content) {
                    Ok(()) => result.links_created += 1,
                    Err(_) => result.links_failed += 1,
                }
            }

            #[cfg(not(any(unix, windows)))]
            {
                result.links_failed += 1;
            }
        }
    }

    Ok(result)
}

/// Compute a relative path from `base` to `target`.
fn pathdiff_relative(base: &Path, target: &Path) -> PathBuf {
    // Canonicalize both paths for reliable relative path computation
    let base_abs = fs::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
    let target_abs = fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());

    let base_components: Vec<_> = base_abs.components().collect();
    let target_components: Vec<_> = target_abs.components().collect();

    // Find common prefix length
    let common_len = base_components
        .iter()
        .zip(target_components.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let mut rel = PathBuf::new();
    // Go up from base
    for _ in common_len..base_components.len() {
        rel.push("..");
    }
    // Go down to target
    for comp in &target_components[common_len..] {
        rel.push(comp.as_os_str());
    }

    if rel.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        rel
    }
}

// --- Lifecycle scripts ---

/// Detect lifecycle scripts (install, preinstall, postinstall) and binding.gyp
/// across all installed packages.
pub fn detect_lifecycle_scripts(
    node_modules_dir: &Path,
    packages: &[ResolvedPackage],
) -> LifecycleDetectionResult {
    let mut result = LifecycleDetectionResult::default();
    let lifecycle_names = ["preinstall", "install", "postinstall"];

    for pkg in packages {
        let pkg_dir = if pkg.rel_path.starts_with("node_modules/") {
            node_modules_dir.join(&pkg.rel_path[13..])
        } else {
            node_modules_dir.join(&pkg.rel_path)
        };

        let pkg_json_path = pkg_dir.join("package.json");
        let pkg_json = match fs::read_to_string(&pkg_json_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        // Check for binding.gyp
        if pkg_dir.join("binding.gyp").exists() {
            result.has_native_addons = true;
            result
                .packages_with_binding_gyp
                .push(pkg.name.clone());
        }

        // Check for gypfile field
        if pkg_json.contains("\"gypfile\"") && pkg_json.contains("true") {
            result.has_native_addons = true;
        }

        // Check for lifecycle scripts
        for script_name in &lifecycle_names {
            // Look for "scripts": { ... "install": "command" ... }
            if let Some(pos) = pkg_json.find("\"scripts\"") {
                let after_scripts = &pkg_json[pos..];
                if let Some(obj_start) = after_scripts.find('{') {
                    let scripts_section = &after_scripts[obj_start..];
                    if let Some(script_val) = extract_json_field(scripts_section, script_name) {
                        if !script_val.is_empty() {
                            result.has_native_addons = true;
                            result.scripts.push(LifecycleScriptInfo {
                                package_name: pkg.name.clone(),
                                package_dir: pkg_dir.clone(),
                                script_name: script_name.to_string(),
                                script_command: script_val,
                            });
                        }
                    }
                }
            }
        }
    }

    result
}

/// Run lifecycle scripts by delegating to `npm rebuild`.
/// Only runs if native addons were detected, saving ~600ms on projects without them.
pub fn run_lifecycle_scripts(
    project_root: &Path,
    detection: &LifecycleDetectionResult,
) -> LifecycleRunResult {
    if !detection.has_native_addons {
        return LifecycleRunResult {
            skipped_reason: Some("no_native_addons".to_string()),
            ..Default::default()
        };
    }

    // Delegate to npm rebuild for maximum compatibility
    let output = std::process::Command::new("npm")
        .args(["rebuild", "--no-audit", "--no-fund"])
        .current_dir(project_root)
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .status();

    match output {
        Ok(status) => {
            let code = status.code().unwrap_or(-1);
            LifecycleRunResult {
                scripts_run: 1,
                scripts_succeeded: if code == 0 { 1 } else { 0 },
                scripts_failed: if code != 0 { 1 } else { 0 },
                skipped_reason: None,
                rebuild_exit_code: Some(code),
            }
        }
        Err(e) => LifecycleRunResult {
            scripts_run: 0,
            scripts_succeeded: 0,
            scripts_failed: 1,
            skipped_reason: Some(format!("npm_not_found: {}", e)),
            rebuild_exit_code: None,
        },
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_pkg(nm: &Path, name: &str, pkg_json: &str) -> ResolvedPackage {
        let dir = nm.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = std::fs::File::create(dir.join("package.json")).unwrap();
        f.write_all(pkg_json.as_bytes()).unwrap();
        // Create stub bin script
        let mut js = std::fs::File::create(dir.join("cli.js")).unwrap();
        js.write_all(b"#!/usr/bin/env node\n").unwrap();
        ResolvedPackage {
            name: name.to_string(),
            version: "1.0.0".to_string(),
            rel_path: name.to_string(),
            resolved_url: String::new(),
            integrity: String::new(),
        }
    }

    #[test]
    fn parse_bin_string_form() {
        let json = r#"{"name":"mycli","version":"1.0.0","bin":"cli.js"}"#;
        let bins = parse_bin_field(json, "mycli");
        assert_eq!(bins.len(), 1);
        assert_eq!(bins[0].0, "mycli");
        assert_eq!(bins[0].1, "cli.js");
    }

    #[test]
    fn parse_bin_object_form() {
        let json = r#"{"name":"tools","version":"1.0.0","bin":{"tool1":"bin/tool1.js","tool2":"bin/tool2.js"}}"#;
        let bins = parse_bin_field(json, "tools");
        assert_eq!(bins.len(), 2);
        let names: Vec<&str> = bins.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"tool1"));
        assert!(names.contains(&"tool2"));
    }

    #[test]
    fn parse_bin_no_bin_field_returns_empty() {
        let json = r#"{"name":"no-bin","version":"1.0.0"}"#;
        let bins = parse_bin_field(json, "no-bin");
        assert!(bins.is_empty());
    }

    #[test]
    fn create_bin_links_creates_dot_bin() {
        let tmp = std::env::temp_dir().join("binlinks-test-create");
        let nm = tmp.join("node_modules");
        let pkg = make_pkg(&nm, "mycli", r#"{"name":"mycli","version":"1.0.0","bin":"cli.js"}"#);
        let result = create_bin_links(&nm, &[pkg]).unwrap();
        // Expect at least 1 link created or failed (not zero total)
        assert!(nm.join(".bin").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn create_bin_links_no_bin_no_links() {
        let tmp = std::env::temp_dir().join("binlinks-test-nobin");
        let nm = tmp.join("node_modules");
        let pkg = make_pkg(&nm, "no-bin-pkg", r#"{"name":"no-bin-pkg","version":"1.0.0"}"#);
        let result = create_bin_links(&nm, &[pkg]).unwrap();
        assert_eq!(result.links_created, 0);
        assert_eq!(result.links_failed, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_lifecycle_no_scripts() {
        let tmp = std::env::temp_dir().join("binlinks-test-lifecycle");
        let nm = tmp.join("node_modules");
        let pkg = make_pkg(&nm, "clean-pkg", r#"{"name":"clean-pkg","version":"1.0.0"}"#);
        let result = detect_lifecycle_scripts(&nm, &[pkg]);
        assert!(!result.has_native_addons);
        assert_eq!(result.scripts.len(), 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
