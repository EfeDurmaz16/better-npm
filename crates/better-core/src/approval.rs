use std::fs;
use std::path::Path;

use crate::JsonWriter;

// --- Dependency approval workflow ---

#[derive(Debug, Clone)]
pub struct ApprovedEntry {
    pub pattern: String,
    pub approved_by: String,
    pub date: String,
}

#[derive(Debug, Clone)]
pub struct ApprovalConfig {
    pub approved: Vec<ApprovedEntry>,
}

impl Default for ApprovalConfig {
    fn default() -> Self {
        Self { approved: Vec::new() }
    }
}

/// Load `.better-approved.json` from project root.
pub fn load_approval_config(project_root: &Path) -> ApprovalConfig {
    let config_path = project_root.join(".better-approved.json");
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return ApprovalConfig::default(),
    };
    parse_approval_config(&content)
}

fn parse_approval_config(json: &str) -> ApprovalConfig {
    let entries = extract_approved_entries(json);
    ApprovalConfig { approved: entries }
}

fn extract_approved_entries(json: &str) -> Vec<ApprovedEntry> {
    let mut entries = Vec::new();

    let needle = "\"approved\"";
    let start = match json.find(needle) {
        Some(pos) => pos,
        None => return entries,
    };
    let after = &json[start + needle.len()..];
    let arr_start = match after.find('[') {
        Some(pos) => pos,
        None => return entries,
    };
    let section = &after[arr_start..];

    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut obj_start: Option<usize> = None;

    for (i, ch) in section.char_indices() {
        if esc { esc = false; continue; }
        if ch == '\\' && in_str { esc = true; continue; }
        if ch == '"' { in_str = !in_str; continue; }
        if in_str { continue; }
        match ch {
            '[' => { depth += 1; }
            ']' => {
                depth -= 1;
                if depth == 0 { break; }
            }
            '{' => {
                depth += 1;
                if depth == 2 { obj_start = Some(i); }
            }
            '}' => {
                if depth == 2 {
                    if let Some(start) = obj_start {
                        let obj_str = &section[start..=i];
                        let pattern = extract_field(obj_str, "pattern").unwrap_or_default();
                        let approved_by = extract_field(obj_str, "approved_by").unwrap_or_default();
                        let date = extract_field(obj_str, "date").unwrap_or_default();
                        if !pattern.is_empty() {
                            entries.push(ApprovedEntry { pattern, approved_by, date });
                        }
                    }
                    obj_start = None;
                }
                depth -= 1;
            }
            _ => {}
        }
    }

    entries
}

fn extract_field(json: &str, field_name: &str) -> Option<String> {
    let needle = format!("\"{}\"", field_name);
    let start = json.find(&needle)?;
    let after = &json[start + needle.len()..];
    let colon = after.find(':')?;
    let mut rest = after[colon + 1..].trim_start();
    if !rest.starts_with('"') { return None; }
    rest = &rest[1..];
    let mut result = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => {
                if let Some(esc) = chars.next() {
                    result.push(match esc {
                        '"' => '"', '\\' => '\\', 'n' => '\n',
                        'r' => '\r', 't' => '\t', other => other,
                    });
                }
            }
            other => result.push(other),
        }
    }
    if result.is_empty() { None } else { Some(result) }
}

fn write_approval_config(path: &Path, config: &ApprovalConfig) -> Result<(), String> {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("approved");
    w.begin_array();
    for entry in &config.approved {
        w.begin_object();
        w.key("pattern"); w.value_string(&entry.pattern);
        w.key("approved_by"); w.value_string(&entry.approved_by);
        w.key("date"); w.value_string(&entry.date);
        w.end_object();
    }
    w.end_array();
    w.end_object();
    w.out.push('\n');
    fs::write(path, w.finish()).map_err(|e| format!("Failed to write approval config: {}", e))
}

/// Check if a package name@version matches an approval pattern.
/// Supports:
///   - Exact match: `lodash@4.17.21`
///   - Scope glob: `@myorg/*`
///   - Version range prefix: `express@^4.0.0` (matches 4.x.x)
///   - Name-only: `lodash` (any version)
fn matches_pattern(pattern: &str, pkg_name: &str, pkg_version: &str) -> bool {
    // Check if pattern has @ for version (but not scope @)
    let (pat_name, pat_version) = split_name_version(pattern);

    // Name matching
    if pat_name.ends_with("/*") {
        // Scope glob: @myorg/*
        let scope = &pat_name[..pat_name.len() - 2];
        if !pkg_name.starts_with(scope) || !pkg_name[scope.len()..].starts_with('/') {
            return false;
        }
    } else if pat_name != pkg_name {
        return false;
    }

    // Version matching
    match pat_version {
        None => true, // Name-only pattern matches any version
        Some(ver) => {
            if ver.starts_with('^') {
                // Caret range: ^4.0.0 matches 4.x.x
                let base = &ver[1..];
                let major = base.split('.').next().unwrap_or("0");
                let pkg_major = pkg_version.split('.').next().unwrap_or("");
                major == pkg_major
            } else if ver.starts_with('~') {
                // Tilde range: ~4.17.0 matches 4.17.x
                let base = &ver[1..];
                let base_parts: Vec<&str> = base.split('.').collect();
                let pkg_parts: Vec<&str> = pkg_version.split('.').collect();
                base_parts.first() == pkg_parts.first() && base_parts.get(1) == pkg_parts.get(1)
            } else {
                // Exact version match
                ver == pkg_version
            }
        }
    }
}

/// Split `name@version` into (name, Some(version)) or (name, None).
fn split_name_version(pattern: &str) -> (&str, Option<&str>) {
    // Handle scoped packages: @scope/name@version
    if pattern.starts_with('@') {
        // Find the second @ (version separator)
        if let Some(pos) = pattern[1..].find('@') {
            let split_at = pos + 1;
            return (&pattern[..split_at], Some(&pattern[split_at + 1..]));
        }
        // No version part
        return (pattern, None);
    }
    // Unscoped: name@version
    if let Some(pos) = pattern.find('@') {
        return (&pattern[..pos], Some(&pattern[pos + 1..]));
    }
    (pattern, None)
}

/// `better policy approve <pattern>` — add to approved list.
pub fn approve_package(project_root: &Path, pattern: &str, approved_by: &str) -> Result<String, String> {
    let config_path = project_root.join(".better-approved.json");
    let mut config = load_approval_config(project_root);

    // Check if pattern already exists
    if config.approved.iter().any(|e| e.pattern == pattern) {
        return Err(format!("'{}' is already in the approved list", pattern));
    }

    // Get current date
    let date = current_date_string();

    config.approved.push(ApprovedEntry {
        pattern: pattern.to_string(),
        approved_by: approved_by.to_string(),
        date,
    });

    write_approval_config(&config_path, &config)?;
    Ok(config_path.to_string_lossy().to_string())
}

/// `better policy revoke <name>` — remove from approved list.
pub fn revoke_package(project_root: &Path, name: &str) -> Result<u64, String> {
    let config_path = project_root.join(".better-approved.json");
    let mut config = load_approval_config(project_root);

    let before = config.approved.len();
    config.approved.retain(|e| {
        let (pat_name, _) = split_name_version(&e.pattern);
        pat_name != name && e.pattern != name
    });
    let removed = (before - config.approved.len()) as u64;

    if removed == 0 {
        return Err(format!("'{}' not found in the approved list", name));
    }

    write_approval_config(&config_path, &config)?;
    Ok(removed)
}

/// `better policy pending` — show unapproved packages.
pub fn pending_packages(project_root: &Path) -> Result<PendingResult, String> {
    let config = load_approval_config(project_root);
    let nm = project_root.join("node_modules");
    let pkg_dirs = crate::list_packages_in_node_modules(&nm)?;

    let mut unapproved = Vec::new();
    let mut approved_count = 0u64;

    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) { Ok(c) => c, Err(_) => continue };
        let name = crate::extract_json_field(&content, "name").unwrap_or_default();
        let version = crate::extract_json_field(&content, "version").unwrap_or_default();
        if name.is_empty() { continue; }

        let is_approved = config.approved.iter().any(|e| matches_pattern(&e.pattern, &name, &version));
        if is_approved {
            approved_count += 1;
        } else {
            unapproved.push((name, version));
        }
    }

    // Deduplicate
    unapproved.sort();
    unapproved.dedup();

    Ok(PendingResult {
        unapproved,
        approved_count,
    })
}

/// Check if all installed packages are approved. Used with `--approved-only` on install.
pub fn check_all_approved(project_root: &Path) -> Result<ApprovalCheckResult, String> {
    let config = load_approval_config(project_root);
    let nm = project_root.join("node_modules");
    let pkg_dirs = crate::list_packages_in_node_modules(&nm)?;

    let mut violations = Vec::new();

    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) { Ok(c) => c, Err(_) => continue };
        let name = crate::extract_json_field(&content, "name").unwrap_or_default();
        let version = crate::extract_json_field(&content, "version").unwrap_or_default();
        if name.is_empty() { continue; }

        let is_approved = config.approved.iter().any(|e| matches_pattern(&e.pattern, &name, &version));
        if !is_approved {
            violations.push(format!("{}@{}", name, version));
        }
    }

    violations.sort();
    violations.dedup();

    Ok(ApprovalCheckResult {
        all_approved: violations.is_empty(),
        violations,
    })
}

fn current_date_string() -> String {
    use std::time::SystemTime;
    match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => {
            let secs = duration.as_secs();
            let days = secs / 86400;
            let year = 1970 + days / 365;
            let remaining = days % 365;
            let month = remaining / 30 + 1;
            let day = remaining % 30 + 1;
            format!("{:04}-{:02}-{:02}", year, month, day)
        }
        Err(_) => "1970-01-01".to_string(),
    }
}

pub struct PendingResult {
    pub unapproved: Vec<(String, String)>,
    pub approved_count: u64,
}

pub struct ApprovalCheckResult {
    pub all_approved: bool,
    pub violations: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exact_match() {
        assert!(matches_pattern("lodash@4.17.21", "lodash", "4.17.21"));
        assert!(!matches_pattern("lodash@4.17.21", "lodash", "4.17.20"));
    }

    #[test]
    fn test_scope_glob() {
        assert!(matches_pattern("@myorg/*", "@myorg/utils", "1.0.0"));
        assert!(matches_pattern("@myorg/*", "@myorg/core", "2.3.4"));
        assert!(!matches_pattern("@myorg/*", "@other/utils", "1.0.0"));
    }

    #[test]
    fn test_caret_range() {
        assert!(matches_pattern("express@^4.0.0", "express", "4.18.2"));
        assert!(matches_pattern("express@^4.0.0", "express", "4.0.0"));
        assert!(!matches_pattern("express@^4.0.0", "express", "5.0.0"));
    }

    #[test]
    fn test_tilde_range() {
        assert!(matches_pattern("lodash@~4.17.0", "lodash", "4.17.21"));
        assert!(!matches_pattern("lodash@~4.17.0", "lodash", "4.18.0"));
    }

    #[test]
    fn test_name_only() {
        assert!(matches_pattern("lodash", "lodash", "4.17.21"));
        assert!(matches_pattern("lodash", "lodash", "3.0.0"));
        assert!(!matches_pattern("lodash", "underscore", "1.0.0"));
    }

    #[test]
    fn test_scoped_exact() {
        assert!(matches_pattern("@babel/core@7.24.0", "@babel/core", "7.24.0"));
        assert!(!matches_pattern("@babel/core@7.24.0", "@babel/core", "7.23.0"));
    }

    #[test]
    fn test_split_name_version() {
        assert_eq!(split_name_version("lodash@4.17.21"), ("lodash", Some("4.17.21")));
        assert_eq!(split_name_version("lodash"), ("lodash", None));
        assert_eq!(split_name_version("@myorg/utils@1.0.0"), ("@myorg/utils", Some("1.0.0")));
        assert_eq!(split_name_version("@myorg/*"), ("@myorg/*", None));
    }

    #[test]
    fn approve_package_creates_config_file() {
        let tmp = std::env::temp_dir().join("approval-test-approve");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = approve_package(&tmp, "lodash@4.17.21", "alice");
        assert!(result.is_ok(), "approve should succeed: {:?}", result);
        assert!(tmp.join(".better-approved.json").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn approve_package_twice_returns_error() {
        let tmp = std::env::temp_dir().join("approval-test-double");
        std::fs::create_dir_all(&tmp).unwrap();
        approve_package(&tmp, "lodash@4.17.21", "alice").unwrap();
        let result = approve_package(&tmp, "lodash@4.17.21", "bob");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn revoke_nonexistent_returns_error() {
        let tmp = std::env::temp_dir().join("approval-test-revoke-none");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = revoke_package(&tmp, "nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn revoke_existing_removes_entry() {
        let tmp = std::env::temp_dir().join("approval-test-revoke");
        std::fs::create_dir_all(&tmp).unwrap();
        approve_package(&tmp, "express@4.18.2", "alice").unwrap();
        let removed = revoke_package(&tmp, "express@4.18.2").unwrap();
        assert_eq!(removed, 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn check_all_approved_empty_dir_returns_no_violations() {
        let tmp = std::env::temp_dir().join("approval-test-check");
        std::fs::create_dir_all(&tmp).unwrap();
        // No node_modules → no packages to check
        let result = check_all_approved(&tmp).unwrap();
        assert!(result.violations.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
