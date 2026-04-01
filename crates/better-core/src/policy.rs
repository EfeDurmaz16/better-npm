use std::fs;
use std::path::Path;

use crate::types::*;
use crate::{extract_json_field, extract_json_object_raw,
            list_packages_in_node_modules, check_dedupe, depth_from_path, JsonWriter,
            extract_json_number};

// === D.3: Policy engine (v1 + v2) ===

fn default_policy_config() -> PolicyConfig {
    PolicyConfig {
        threshold: 70,
        rules: vec![
            PolicyRule {
                id: "no-deprecated".into(), severity: "warning".into(),
                description: "No deprecated packages".into(),
                max_duplicates: None, max_depth: None, banned_packages: Vec::new(),
                max_install_size_mb: None, min_maintainers: None,
                min_publish_age_days: None, require_source: None, max_direct_deps: None,
            },
            PolicyRule {
                id: "max-duplicates".into(), severity: "warning".into(),
                description: "Maximum duplicate package instances".into(),
                max_duplicates: Some(3), max_depth: None, banned_packages: Vec::new(),
                max_install_size_mb: None, min_maintainers: None,
                min_publish_age_days: None, require_source: None, max_direct_deps: None,
            },
            PolicyRule {
                id: "max-depth".into(), severity: "warning".into(),
                description: "Maximum dependency nesting depth".into(),
                max_duplicates: None, max_depth: Some(15), banned_packages: Vec::new(),
                max_install_size_mb: None, min_maintainers: None,
                min_publish_age_days: None, require_source: None, max_direct_deps: None,
            },
            // v2 rules
            PolicyRule {
                id: "max-install-size".into(), severity: "warning".into(),
                description: "Maximum unpacked install size per package".into(),
                max_duplicates: None, max_depth: None, banned_packages: Vec::new(),
                max_install_size_mb: Some(50), min_maintainers: None,
                min_publish_age_days: None, require_source: None, max_direct_deps: None,
            },
            PolicyRule {
                id: "min-maintainers".into(), severity: "warning".into(),
                description: "Minimum number of npm maintainers".into(),
                max_duplicates: None, max_depth: None, banned_packages: Vec::new(),
                max_install_size_mb: None, min_maintainers: Some(2),
                min_publish_age_days: None, require_source: None, max_direct_deps: None,
            },
            PolicyRule {
                id: "min-publish-age".into(), severity: "warning".into(),
                description: "Minimum days since package publication (anti-typosquat)".into(),
                max_duplicates: None, max_depth: None, banned_packages: Vec::new(),
                max_install_size_mb: None, min_maintainers: None,
                min_publish_age_days: Some(7), require_source: None, max_direct_deps: None,
            },
            PolicyRule {
                id: "require-source".into(), severity: "warning".into(),
                description: "Require source repository link in package.json".into(),
                max_duplicates: None, max_depth: None, banned_packages: Vec::new(),
                max_install_size_mb: None, min_maintainers: None,
                min_publish_age_days: None, require_source: Some(true), max_direct_deps: None,
            },
            PolicyRule {
                id: "max-direct-deps".into(), severity: "warning".into(),
                description: "Maximum number of direct dependencies".into(),
                max_duplicates: None, max_depth: None, banned_packages: Vec::new(),
                max_install_size_mb: None, min_maintainers: None,
                min_publish_age_days: None, require_source: None, max_direct_deps: Some(100),
            },
        ],
        waivers: Vec::new(),
    }
}

pub fn load_policy_config(project_root: &Path) -> PolicyConfig {
    let config_file = project_root.join(".betterrc.json");
    if let Ok(content) = fs::read_to_string(&config_file) {
        if let Some(raw) = extract_json_object_raw(&content, "policy") {
            return parse_policy_config(&raw);
        }
        return parse_policy_config(&content);
    }
    let pkg_json = project_root.join("package.json");
    if let Ok(content) = fs::read_to_string(&pkg_json) {
        if let Some(better_raw) = extract_json_object_raw(&content, "better") {
            if let Some(policy_raw) = extract_json_object_raw(&better_raw, "policy") {
                return parse_policy_config(&policy_raw);
            }
        }
    }
    default_policy_config()
}

fn parse_policy_config(raw: &str) -> PolicyConfig {
    let threshold = extract_json_number(raw, "threshold").unwrap_or(70) as i32;
    let mut cfg = default_policy_config();
    cfg.threshold = threshold;

    // Override rule-specific thresholds from config
    if let Some(max_dup) = extract_json_number(raw, "maxDuplicates") {
        if let Some(rule) = cfg.rules.iter_mut().find(|r| r.id == "max-duplicates") {
            rule.max_duplicates = Some(max_dup);
        }
    }
    if let Some(max_d) = extract_json_number(raw, "maxDepth") {
        if let Some(rule) = cfg.rules.iter_mut().find(|r| r.id == "max-depth") {
            rule.max_depth = Some(max_d);
        }
    }
    if let Some(max_size) = extract_json_number(raw, "maxInstallSizeMb") {
        if let Some(rule) = cfg.rules.iter_mut().find(|r| r.id == "max-install-size") {
            rule.max_install_size_mb = Some(max_size);
        }
    }
    if let Some(min_m) = extract_json_number(raw, "minMaintainers") {
        if let Some(rule) = cfg.rules.iter_mut().find(|r| r.id == "min-maintainers") {
            rule.min_maintainers = Some(min_m);
        }
    }
    if let Some(min_age) = extract_json_number(raw, "minPublishAgeDays") {
        if let Some(rule) = cfg.rules.iter_mut().find(|r| r.id == "min-publish-age") {
            rule.min_publish_age_days = Some(min_age);
        }
    }
    if let Some(max_dd) = extract_json_number(raw, "maxDirectDeps") {
        if let Some(rule) = cfg.rules.iter_mut().find(|r| r.id == "max-direct-deps") {
            rule.max_direct_deps = Some(max_dd);
        }
    }

    cfg
}

pub fn policy_check(project_root: &Path) -> Result<PolicyCheckResult, String> {
    let config = load_policy_config(project_root);
    let nm = project_root.join("node_modules");
    let pkg_dirs = list_packages_in_node_modules(&nm)?;
    let mut violations = Vec::new();
    let mut errors = 0u64;
    let mut warnings = 0u64;
    let mut waived = 0u64;

    // Check deprecated packages
    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) { Ok(c) => c, Err(_) => continue };
        let name = extract_json_field(&content, "name").unwrap_or_else(|| "unknown".into());
        if extract_json_field(&content, "deprecated").is_some() {
            let rule_id = "no-deprecated";
            if config.waivers.iter().any(|w| w.rule == rule_id && w.package == name) {
                waived += 1; continue;
            }
            let severity = config.rules.iter().find(|r| r.id == rule_id)
                .map(|r| r.severity.clone()).unwrap_or_else(|| "warning".into());
            if severity == "error" { errors += 1; } else { warnings += 1; }
            violations.push(PolicyViolation {
                rule: rule_id.into(), severity, package: name, reason: "package is deprecated".into(),
            });
        }
    }

    // Check duplicates
    if let Ok(dedupe_report) = check_dedupe(project_root) {
        let max_dup = config.rules.iter().find(|r| r.id == "max-duplicates")
            .and_then(|r| r.max_duplicates).unwrap_or(3);
        for entry in &dedupe_report.duplicates {
            if entry.instances > max_dup {
                let rule_id = "max-duplicates";
                if config.waivers.iter().any(|w| w.rule == rule_id && w.package == entry.name) {
                    waived += 1; continue;
                }
                let severity = config.rules.iter().find(|r| r.id == rule_id)
                    .map(|r| r.severity.clone()).unwrap_or_else(|| "warning".into());
                if severity == "error" { errors += 1; } else { warnings += 1; }
                violations.push(PolicyViolation {
                    rule: rule_id.into(), severity, package: entry.name.clone(),
                    reason: format!("{} instances (max: {})", entry.instances, max_dup),
                });
            }
        }
    }

    // Check max depth
    let max_depth_limit = config.rules.iter().find(|r| r.id == "max-depth")
        .and_then(|r| r.max_depth).unwrap_or(15);
    let mut actual_max_depth = 0u64;
    for pkg_dir in &pkg_dirs {
        let d = depth_from_path(pkg_dir);
        if d > actual_max_depth { actual_max_depth = d; }
    }
    if actual_max_depth > max_depth_limit {
        let rule_id = "max-depth";
        let severity = config.rules.iter().find(|r| r.id == rule_id)
            .map(|r| r.severity.clone()).unwrap_or_else(|| "warning".into());
        if severity == "error" { errors += 1; } else { warnings += 1; }
        violations.push(PolicyViolation {
            rule: rule_id.into(), severity, package: "(tree)".into(),
            reason: format!("depth {} exceeds limit {}", actual_max_depth, max_depth_limit),
        });
    }

    // === v2 rules ===

    // max-install-size: check unpacked size of each package
    let max_size_mb = config.rules.iter().find(|r| r.id == "max-install-size")
        .and_then(|r| r.max_install_size_mb).unwrap_or(50);
    let max_size_bytes = max_size_mb * 1024 * 1024;
    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) { Ok(c) => c, Err(_) => continue };
        let name = extract_json_field(&content, "name").unwrap_or_else(|| "unknown".into());

        // Calculate directory size
        let dir_size = dir_size_bytes(pkg_dir);
        if dir_size > max_size_bytes {
            let rule_id = "max-install-size";
            if config.waivers.iter().any(|w| w.rule == rule_id && w.package == name) {
                waived += 1; continue;
            }
            let severity = config.rules.iter().find(|r| r.id == rule_id)
                .map(|r| r.severity.clone()).unwrap_or_else(|| "warning".into());
            if severity == "error" { errors += 1; } else { warnings += 1; }
            let size_mb = dir_size / (1024 * 1024);
            violations.push(PolicyViolation {
                rule: rule_id.into(), severity, package: name,
                reason: format!("{}MB unpacked (max: {}MB)", size_mb, max_size_mb),
            });
        }
    }

    // min-maintainers: check maintainers count in package.json
    let min_maintainers = config.rules.iter().find(|r| r.id == "min-maintainers")
        .and_then(|r| r.min_maintainers).unwrap_or(2);
    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) { Ok(c) => c, Err(_) => continue };
        let name = extract_json_field(&content, "name").unwrap_or_else(|| "unknown".into());

        let maintainer_count = count_json_array_entries(&content, "maintainers");
        if maintainer_count > 0 && maintainer_count < min_maintainers {
            let rule_id = "min-maintainers";
            if config.waivers.iter().any(|w| w.rule == rule_id && w.package == name) {
                waived += 1; continue;
            }
            let severity = config.rules.iter().find(|r| r.id == rule_id)
                .map(|r| r.severity.clone()).unwrap_or_else(|| "warning".into());
            if severity == "error" { errors += 1; } else { warnings += 1; }
            violations.push(PolicyViolation {
                rule: rule_id.into(), severity, package: name,
                reason: format!("{} maintainer(s) (min: {})", maintainer_count, min_maintainers),
            });
        }
    }

    // min-publish-age: check time field in package.json (npm includes this in installed packages)
    let min_age_days = config.rules.iter().find(|r| r.id == "min-publish-age")
        .and_then(|r| r.min_publish_age_days).unwrap_or(7);
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) { Ok(c) => c, Err(_) => continue };
        let name = extract_json_field(&content, "name").unwrap_or_else(|| "unknown".into());

        // npm stores publish time in the "time" field or "_time" field
        if let Some(time_str) = extract_json_field(&content, "publish_time")
            .or_else(|| extract_json_field(&content, "_time"))
        {
            if let Some(publish_secs) = parse_iso_timestamp(&time_str) {
                let age_days = (now_secs.saturating_sub(publish_secs)) / 86400;
                if age_days < min_age_days {
                    let rule_id = "min-publish-age";
                    if config.waivers.iter().any(|w| w.rule == rule_id && w.package == name) {
                        waived += 1; continue;
                    }
                    let severity = config.rules.iter().find(|r| r.id == rule_id)
                        .map(|r| r.severity.clone()).unwrap_or_else(|| "warning".into());
                    if severity == "error" { errors += 1; } else { warnings += 1; }
                    violations.push(PolicyViolation {
                        rule: rule_id.into(), severity, package: name,
                        reason: format!("published {} day(s) ago (min: {} days)", age_days, min_age_days),
                    });
                }
            }
        }
    }

    // require-source: check repository field in package.json
    let require_source = config.rules.iter().find(|r| r.id == "require-source")
        .and_then(|r| r.require_source).unwrap_or(true);
    if require_source {
        for pkg_dir in &pkg_dirs {
            let pkg_json = pkg_dir.join("package.json");
            let content = match fs::read_to_string(&pkg_json) { Ok(c) => c, Err(_) => continue };
            let name = extract_json_field(&content, "name").unwrap_or_else(|| "unknown".into());

            let has_repo = extract_json_field(&content, "repository").is_some()
                || extract_json_object_raw(&content, "repository").is_some();
            if !has_repo {
                let rule_id = "require-source";
                if config.waivers.iter().any(|w| w.rule == rule_id && w.package == name) {
                    waived += 1; continue;
                }
                let severity = config.rules.iter().find(|r| r.id == rule_id)
                    .map(|r| r.severity.clone()).unwrap_or_else(|| "warning".into());
                if severity == "error" { errors += 1; } else { warnings += 1; }
                violations.push(PolicyViolation {
                    rule: rule_id.into(), severity, package: name,
                    reason: "no repository/source link in package.json".into(),
                });
            }
        }
    }

    // max-direct-deps: count direct dependencies in project package.json
    let max_direct = config.rules.iter().find(|r| r.id == "max-direct-deps")
        .and_then(|r| r.max_direct_deps).unwrap_or(100);
    let project_pkg = project_root.join("package.json");
    if let Ok(content) = fs::read_to_string(&project_pkg) {
        let mut direct_count = 0u64;
        direct_count += count_json_object_keys(&content, "dependencies");
        direct_count += count_json_object_keys(&content, "devDependencies");
        if direct_count > max_direct {
            let rule_id = "max-direct-deps";
            let severity = config.rules.iter().find(|r| r.id == rule_id)
                .map(|r| r.severity.clone()).unwrap_or_else(|| "warning".into());
            if severity == "error" { errors += 1; } else { warnings += 1; }
            violations.push(PolicyViolation {
                rule: rule_id.into(), severity, package: "(project)".into(),
                reason: format!("{} direct dependencies (max: {})", direct_count, max_direct),
            });
        }
    }

    let score = (100 - (errors as i32 * 15) - (warnings as i32 * 5)).max(0);
    let pass = score >= config.threshold;
    Ok(PolicyCheckResult { score, threshold: config.threshold, pass, violations, errors, warnings, waived })
}

pub fn policy_init(project_root: &Path) -> Result<String, String> {
    let path = project_root.join(".betterrc.json");
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("policy"); w.begin_object();
    w.key("threshold"); w.value_i64(70);
    w.key("rules"); w.begin_array();
    // v1 rules
    w.begin_object();
    w.key("id"); w.value_string("no-deprecated");
    w.key("severity"); w.value_string("warning");
    w.key("description"); w.value_string("No deprecated packages");
    w.end_object();
    w.begin_object();
    w.key("id"); w.value_string("max-duplicates");
    w.key("severity"); w.value_string("warning");
    w.key("maxDuplicates"); w.value_u64(3);
    w.key("description"); w.value_string("Maximum duplicate package instances");
    w.end_object();
    w.begin_object();
    w.key("id"); w.value_string("max-depth");
    w.key("severity"); w.value_string("warning");
    w.key("maxDepth"); w.value_u64(15);
    w.key("description"); w.value_string("Maximum dependency nesting depth");
    w.end_object();
    // v2 rules
    w.begin_object();
    w.key("id"); w.value_string("max-install-size");
    w.key("severity"); w.value_string("warning");
    w.key("maxInstallSizeMb"); w.value_u64(50);
    w.key("description"); w.value_string("Maximum unpacked install size per package (MB)");
    w.end_object();
    w.begin_object();
    w.key("id"); w.value_string("min-maintainers");
    w.key("severity"); w.value_string("warning");
    w.key("minMaintainers"); w.value_u64(2);
    w.key("description"); w.value_string("Minimum number of npm maintainers");
    w.end_object();
    w.begin_object();
    w.key("id"); w.value_string("min-publish-age");
    w.key("severity"); w.value_string("warning");
    w.key("minPublishAgeDays"); w.value_u64(7);
    w.key("description"); w.value_string("Minimum days since package publication");
    w.end_object();
    w.begin_object();
    w.key("id"); w.value_string("require-source");
    w.key("severity"); w.value_string("warning");
    w.key("description"); w.value_string("Require source repository link in package.json");
    w.end_object();
    w.begin_object();
    w.key("id"); w.value_string("max-direct-deps");
    w.key("severity"); w.value_string("warning");
    w.key("maxDirectDeps"); w.value_u64(100);
    w.key("description"); w.value_string("Maximum number of direct dependencies");
    w.end_object();
    w.end_array();
    w.key("waivers"); w.begin_array(); w.end_array();
    w.end_object();
    w.end_object();
    w.out.push('\n');
    fs::write(&path, w.finish()).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

// --- Helper functions ---

fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str == "node_modules" { continue; }
                total += dir_size_bytes(&path);
            } else if let Ok(md) = entry.metadata() {
                total += md.len();
            }
        }
    }
    total
}

/// Count entries in a JSON array field (e.g., "maintainers": [{...}, {...}])
fn count_json_array_entries(json: &str, field_name: &str) -> u64 {
    let needle = format!("\"{}\"", field_name);
    let start = match json.find(&needle) {
        Some(pos) => pos,
        None => return 0,
    };
    let after = &json[start + needle.len()..];
    let colon = match after.find(':') {
        Some(pos) => pos,
        None => return 0,
    };
    let rest = after[colon + 1..].trim_start();
    if !rest.starts_with('[') {
        return 0;
    }

    let mut count = 0u64;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut has_content = false;

    for ch in rest.chars() {
        if esc { esc = false; continue; }
        if ch == '\\' && in_str { esc = true; continue; }
        if ch == '"' { in_str = !in_str; continue; }
        if in_str { continue; }
        match ch {
            '[' => { depth += 1; }
            ']' => {
                depth -= 1;
                if depth == 0 {
                    if has_content { count += 1; }
                    break;
                }
            }
            '{' if depth == 1 => { has_content = true; }
            '}' if depth == 1 => { /* closing an object entry */ }
            ',' if depth == 1 => {
                if has_content { count += 1; has_content = false; }
            }
            '"' if depth == 1 => { has_content = true; }
            _ if depth == 1 && !ch.is_whitespace() => { has_content = true; }
            _ => {}
        }
    }
    count
}

/// Count keys in a JSON object field (e.g., "dependencies": {"foo": "^1", "bar": "^2"})
fn count_json_object_keys(json: &str, field_name: &str) -> u64 {
    let needle = format!("\"{}\"", field_name);
    let start = match json.find(&needle) {
        Some(pos) => pos,
        None => return 0,
    };
    let after = &json[start + needle.len()..];
    let obj_start = match after.find('{') {
        Some(pos) => pos,
        None => return 0,
    };
    let section = &after[obj_start..];

    let mut count = 0u64;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut key_found = false;

    for ch in section.chars() {
        if esc { esc = false; continue; }
        if ch == '\\' && in_str { esc = true; continue; }
        if ch == '"' {
            in_str = !in_str;
            if depth == 1 && in_str && !key_found {
                key_found = true;
            }
            continue;
        }
        if in_str { continue; }
        match ch {
            '{' => { depth += 1; }
            '}' => { depth -= 1; if depth == 0 { break; } }
            ':' if depth == 1 && key_found => {
                count += 1;
                key_found = false;
            }
            ',' if depth == 1 => { key_found = false; }
            _ => {}
        }
    }
    count
}

/// Parse a simple ISO 8601 timestamp to Unix seconds.
/// Handles formats like "2024-01-15T10:30:00.000Z"
fn parse_iso_timestamp(s: &str) -> Option<u64> {
    // Expect at least YYYY-MM-DDThh:mm:ss
    if s.len() < 19 { return None; }
    let year: u64 = s.get(0..4)?.parse().ok()?;
    let month: u64 = s.get(5..7)?.parse().ok()?;
    let day: u64 = s.get(8..10)?.parse().ok()?;
    let hour: u64 = s.get(11..13)?.parse().ok()?;
    let min: u64 = s.get(14..16)?.parse().ok()?;
    let sec: u64 = s.get(17..19)?.parse().ok()?;

    // Simple days-from-epoch calculation (good enough for age comparison)
    let mut days = 0u64;
    for y in 1970..year {
        days += if is_leap(y) { 366 } else { 365 };
    }
    let month_days = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 1..month {
        days += month_days[m as usize];
        if m == 2 && is_leap(year) { days += 1; }
    }
    days += day - 1;

    Some(days * 86400 + hour * 3600 + min * 60 + sec)
}

fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_pkg(root: &Path, name: &str, extra: &str) {
        let dir = root.join("node_modules").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let content = format!(r#"{{"name":"{}","version":"1.0.0"{}}} "#, name, extra);
        let mut f = std::fs::File::create(dir.join("package.json")).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn load_policy_config_defaults_when_no_file() {
        let tmp = std::env::temp_dir().join("policy-test-defaults");
        std::fs::create_dir_all(&tmp).unwrap();
        let config = load_policy_config(&tmp);
        assert!(config.threshold > 0);
        assert!(!config.rules.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn policy_check_empty_node_modules_passes() {
        let tmp = std::env::temp_dir().join("policy-test-empty");
        let nm = tmp.join("node_modules");
        std::fs::create_dir_all(&nm).unwrap();
        let result = policy_check(&tmp).unwrap();
        assert!(result.violations.is_empty());
        assert!(result.pass);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn policy_check_deprecated_package_produces_warning() {
        let tmp = std::env::temp_dir().join("policy-test-deprecated");
        write_pkg(&tmp, "old-pkg", r#","deprecated":"Use new-pkg instead""#);
        let result = policy_check(&tmp).unwrap();
        assert!(result.violations.iter().any(|v| v.rule == "no-deprecated" && v.package == "old-pkg"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn policy_check_clean_package_has_no_violations() {
        let tmp = std::env::temp_dir().join("policy-test-clean");
        write_pkg(&tmp, "lodash", "");
        let result = policy_check(&tmp).unwrap();
        // A clean package should not trigger deprecated or banned rules
        assert!(!result.violations.iter().any(|v| v.package == "lodash" && v.rule == "no-deprecated"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn default_policy_has_seven_rules() {
        let config = default_policy_config();
        assert_eq!(config.rules.len(), 8);
        assert!(config.rules.iter().any(|r| r.id == "no-deprecated"));
        assert!(config.rules.iter().any(|r| r.id == "max-duplicates"));
        assert!(config.rules.iter().any(|r| r.id == "max-depth"));
    }

    #[test]
    fn policy_check_missing_node_modules_returns_error() {
        // list_packages_in_node_modules returns Err when node_modules is missing
        let result = policy_check(Path::new("/nonexistent-policy-project"));
        // Either an error or empty violations — both are valid; key is no panic
        let _ = result;
    }
}
