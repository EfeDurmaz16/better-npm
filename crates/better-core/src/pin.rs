// crates/better-core/src/pin.rs
// Pin or unpin package versions in package.json

use std::fs;
use std::path::Path;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct PinChange {
    pub name: String,
    pub section: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug)]
pub struct PinResult {
    pub changes: Vec<PinChange>,
    pub total: usize,
}

/// Strip semver range prefix (^, ~, >=, etc.) from a version string
pub fn strip_range(v: &str) -> String {
    let trimmed = v.trim_start_matches(|c: char| {
        matches!(c, '^' | '~' | '>' | '<' | '=' | ' ')
    });
    // Take only up to the first space (handles ">=1.0.0 <2.0.0")
    trimmed.split_whitespace().next().unwrap_or("").to_string()
}

/// Check if a version string has a range prefix
pub fn has_range(v: &str) -> bool {
    v.starts_with(|c: char| matches!(c, '^' | '~' | '>' | '<' | '='))
}

/// Pin all dependencies in package.json to exact versions.
/// Uses lockfile to resolve the exact installed version.
///
/// Returns a list of changes made.
pub fn pin_versions(
    project_root: &Path,
    package_names: &[String],
    unpin: bool,
    dev_only: bool,
    prod_only: bool,
    dry_run: bool,
) -> Result<PinResult, String> {
    let pkg_path = project_root.join("package.json");
    let lock_path = project_root.join("package-lock.json");

    let pkg_content = fs::read_to_string(&pkg_path)
        .map_err(|e| format!("Cannot read package.json: {}", e))?;

    // Read installed versions from lockfile
    let mut installed: HashMap<String, String> = HashMap::new();
    if let Ok(lock_content) = fs::read_to_string(&lock_path) {
        parse_lockfile_versions(&lock_content, &mut installed);
    }

    // We need to parse and rewrite package.json
    // Using simple string manipulation to preserve formatting
    let mut content = pkg_content.clone();
    let mut changes = Vec::new();

    // Process "dependencies" section
    if !dev_only {
        process_section(&mut content, "dependencies", &installed, package_names,
                         unpin, &mut changes, "prod");
    }
    if !prod_only {
        process_section(&mut content, "devDependencies", &installed, package_names,
                         unpin, &mut changes, "dev");
    }

    if !dry_run && !changes.is_empty() {
        fs::write(&pkg_path, &content)
            .map_err(|e| format!("Cannot write package.json: {}", e))?;
    }

    let total = changes.len();
    Ok(PinResult { changes, total })
}

fn process_section(
    content: &mut String,
    section: &str,
    installed: &HashMap<String, String>,
    filter: &[String],
    unpin: bool,
    changes: &mut Vec<PinChange>,
    section_label: &str,
) {
    let key = format!("\"{}\"", section);
    if let Some(start) = content.find(&key) {
        let after_key = &content[start + key.len()..];
        if let Some(brace) = after_key.find('{') {
            let obj_start = start + key.len() + brace;
            let inner_start = obj_start + 1;
            let depth = 1i32;
            let mut end_pos = None;
            let mut d = depth;
            for (i, c) in content[inner_start..].char_indices() {
                match c {
                    '{' => d += 1,
                    '}' => {
                        d -= 1;
                        if d == 0 {
                            end_pos = Some(inner_start + i);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if let Some(end) = end_pos {
                let section_body = content[inner_start..end].to_string();
                let new_body = rewrite_deps(&section_body, installed, filter, unpin,
                                            changes, section_label);
                let _ = content.replace_range(inner_start..end, &new_body);
            }
        }
    }
}

fn rewrite_deps(
    body: &str,
    installed: &HashMap<String, String>,
    filter: &[String],
    unpin: bool,
    changes: &mut Vec<PinChange>,
    section: &str,
) -> String {
    let mut result = body.to_string();

    // Find each "name": "version" pattern
    let mut pos = 0;
    while pos < result.len() {
        // Find next quoted key
        if let Some(q1) = result[pos..].find('"') {
            let key_start = pos + q1 + 1;
            if let Some(q2) = result[key_start..].find('"') {
                let name = result[key_start..key_start + q2].to_string();
                let after_name = key_start + q2 + 1;

                // Find the colon and value
                if let Some(colon) = result[after_name..].find(':') {
                    let val_area_start = after_name + colon + 1;
                    let trimmed = result[val_area_start..].trim_start();
                    let trim_offset = result[val_area_start..].len() - trimmed.len();
                    let actual_val_start = val_area_start + trim_offset;

                    if actual_val_start < result.len() && result.as_bytes().get(actual_val_start) == Some(&b'"') {
                        let inner_start = actual_val_start + 1;
                        if let Some(end_q) = result[inner_start..].find('"') {
                            let current_ver = result[inner_start..inner_start + end_q].to_string();

                            // Apply filter
                            if filter.is_empty() || filter.contains(&name) {
                                let new_ver = if unpin {
                                    // Remove range — add ^ if currently exact
                                    if !has_range(&current_ver) {
                                        Some(format!("^{}", current_ver))
                                    } else {
                                        None
                                    }
                                } else {
                                    // Pin — use installed version or strip range
                                    if has_range(&current_ver) {
                                        let exact = installed.get(&name)
                                            .cloned()
                                            .unwrap_or_else(|| strip_range(&current_ver));
                                        Some(exact)
                                    } else {
                                        None
                                    }
                                };

                                if let Some(new_v) = new_ver {
                                    changes.push(PinChange {
                                        name: name.clone(),
                                        section: section.to_string(),
                                        from: current_ver.clone(),
                                        to: new_v.clone(),
                                    });
                                    let range_start = inner_start;
                                    let range_end = inner_start + end_q;
                                    result.replace_range(range_start..range_end, &new_v);
                                    // Adjust position
                                    pos = inner_start + new_v.len() + 1;
                                    continue;
                                }
                            }
                            pos = inner_start + end_q + 1;
                            continue;
                        }
                    }
                }
                pos = key_start + q2 + 1;
                continue;
            }
        }
        break;
    }

    result
}

fn parse_lockfile_versions(content: &str, installed: &mut HashMap<String, String>) {
    let marker = "\"node_modules/";
    let mut pos = 0;
    while pos < content.len() {
        if let Some(nm_pos) = content[pos..].find(marker) {
            let abs = pos + nm_pos;
            let name_start = abs + marker.len();
            if let Some(end_q) = content[name_start..].find('"') {
                let name = &content[name_start..name_start + end_q];
                if !name.contains("/node_modules/") {
                    // Find version in the following object
                    let after = &content[name_start + end_q..];
                    if let Some(ver_key) = after.find("\"version\"") {
                        let ver_area = &after[ver_key + "\"version\"".len()..];
                        if let Some(colon) = ver_area.find(':') {
                            let val = ver_area[colon + 1..].trim_start();
                            if val.starts_with('"') {
                                let inner = &val[1..];
                                if let Some(end) = inner.find('"') {
                                    installed.insert(name.to_string(), inner[..end].to_string());
                                }
                            }
                        }
                    }
                }
                pos = name_start + end_q + 1;
            } else {
                break;
            }
        } else {
            break;
        }
    }
}
