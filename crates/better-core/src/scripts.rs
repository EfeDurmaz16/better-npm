use std::fs;
use std::path::Path;

use crate::types::*;
use crate::{extract_json_field, extract_json_object_raw, extract_json_object_pairs,
            extract_json_array_strings, list_packages_in_node_modules, JsonWriter};

// === D.2: Script sandboxing policy ===

pub fn load_script_policy(project_root: &Path) -> ScriptPolicy {
    let policy_file = project_root.join(".better-scripts.json");
    if let Ok(content) = fs::read_to_string(&policy_file) {
        return parse_script_policy_json(&content);
    }
    let pkg_json = project_root.join("package.json");
    if let Ok(content) = fs::read_to_string(&pkg_json) {
        if let Some(raw) = extract_json_object_raw(&content, "betterScripts") {
            return parse_script_policy_json(&raw);
        }
    }
    ScriptPolicy {
        default_policy: "allow".to_string(),
        allowed_packages: Vec::new(),
        blocked_packages: Vec::new(),
        allowed_script_types: vec!["postinstall".into(), "install".into()],
        trusted_scopes: Vec::new(),
    }
}

fn parse_script_policy_json(json: &str) -> ScriptPolicy {
    let default_policy = extract_json_field(json, "defaultPolicy").unwrap_or_else(|| "allow".into());
    let allowed_packages = extract_json_array_strings(json, "allowedPackages");
    let blocked_packages = extract_json_array_strings(json, "blockedPackages");
    let allowed_script_types = {
        let t = extract_json_array_strings(json, "allowedScriptTypes");
        if t.is_empty() { vec!["postinstall".into(), "install".into()] } else { t }
    };
    let trusted_scopes = extract_json_array_strings(json, "trustedScopes");
    ScriptPolicy { default_policy, allowed_packages, blocked_packages, allowed_script_types, trusted_scopes }
}

pub fn check_script_permission(policy: &ScriptPolicy, package_name: &str, script_type: &str) -> (String, String) {
    if policy.blocked_packages.iter().any(|b| b == package_name) {
        return ("blocked".into(), "package is in blocked list".into());
    }
    if policy.allowed_packages.iter().any(|a| a == package_name) {
        return ("allowed".into(), "package is in allowed list".into());
    }
    if package_name.starts_with('@') {
        if let Some(slash) = package_name.find('/') {
            let scope = &package_name[..slash];
            if policy.trusted_scopes.iter().any(|s| s == scope) {
                return ("allowed".into(), format!("scope {} is trusted", scope));
            }
        }
    }
    if policy.allowed_script_types.iter().any(|t| t == script_type) {
        return ("allowed".into(), format!("script type '{}' is allowed", script_type));
    }
    (policy.default_policy.clone(), format!("default policy: {}", policy.default_policy))
}

pub fn scan_scripts(project_root: &Path) -> Result<ScriptScanResult, String> {
    let nm = project_root.join("node_modules");
    let pkg_dirs = list_packages_in_node_modules(&nm)?;
    let policy = load_script_policy(project_root);
    let lifecycle_types = ["preinstall", "install", "postinstall", "prepare"];
    let mut packages = Vec::new();
    let mut total_with_scripts = 0u64;
    let mut allowed = 0u64;
    let mut blocked = 0u64;
    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) { Ok(c) => c, Err(_) => continue };
        let name = extract_json_field(&content, "name").unwrap_or_else(|| "unknown".into());
        let version = extract_json_field(&content, "version").unwrap_or_else(|| "0.0.0".into());
        let all_scripts = extract_json_object_pairs(&content, "scripts").unwrap_or_default();
        let lifecycle: Vec<(String, String)> = all_scripts.into_iter()
            .filter(|(k, _)| lifecycle_types.contains(&k.as_str())).collect();
        if lifecycle.is_empty() { continue; }
        total_with_scripts += 1;
        let (pol, reason) = check_script_permission(&policy, &name, &lifecycle[0].0);
        if pol == "blocked" { blocked += 1; } else { allowed += 1; }
        packages.push(ScriptScanEntry { name, version, scripts: lifecycle, policy: pol, reason });
    }
    Ok(ScriptScanResult { packages, total_with_scripts, allowed, blocked })
}

pub fn scripts_allow(project_root: &Path, package: &str) -> Result<ScriptPolicy, String> {
    let mut policy = load_script_policy(project_root);
    policy.blocked_packages.retain(|p| p != package);
    if !policy.allowed_packages.iter().any(|p| p == package) {
        policy.allowed_packages.push(package.to_string());
    }
    write_script_policy(project_root, &policy)?;
    Ok(policy)
}

pub fn scripts_block(project_root: &Path, package: &str) -> Result<ScriptPolicy, String> {
    let mut policy = load_script_policy(project_root);
    policy.allowed_packages.retain(|p| p != package);
    if !policy.blocked_packages.iter().any(|p| p == package) {
        policy.blocked_packages.push(package.to_string());
    }
    write_script_policy(project_root, &policy)?;
    Ok(policy)
}

fn write_script_policy(project_root: &Path, policy: &ScriptPolicy) -> Result<(), String> {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("defaultPolicy"); w.value_string(&policy.default_policy);
    w.key("allowedPackages"); w.begin_array();
    for p in &policy.allowed_packages { w.value_string(p); }
    w.end_array();
    w.key("blockedPackages"); w.begin_array();
    for p in &policy.blocked_packages { w.value_string(p); }
    w.end_array();
    w.key("allowedScriptTypes"); w.begin_array();
    for t in &policy.allowed_script_types { w.value_string(t); }
    w.end_array();
    w.key("trustedScopes"); w.begin_array();
    for s in &policy.trusted_scopes { w.value_string(s); }
    w.end_array();
    w.end_object();
    w.out.push('\n');
    fs::write(project_root.join(".better-scripts.json"), w.finish())
        .map_err(|e| format!("Failed to write policy: {}", e))
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_allows_scripts() {
        let policy = load_script_policy(std::path::Path::new("/nonexistent-scripts-project"));
        assert_eq!(policy.default_policy, "allow");
    }

    #[test]
    fn blocked_package_is_blocked() {
        let policy = ScriptPolicy {
            default_policy: "allow".to_string(),
            allowed_packages: vec![],
            blocked_packages: vec!["evil-pkg".to_string()],
            allowed_script_types: vec!["postinstall".to_string()],
            trusted_scopes: vec![],
        };
        let (decision, _) = check_script_permission(&policy, "evil-pkg", "postinstall");
        assert_eq!(decision, "blocked");
    }

    #[test]
    fn allowed_package_is_allowed() {
        let policy = ScriptPolicy {
            default_policy: "deny".to_string(),
            allowed_packages: vec!["safe-pkg".to_string()],
            blocked_packages: vec![],
            allowed_script_types: vec![],
            trusted_scopes: vec![],
        };
        let (decision, _) = check_script_permission(&policy, "safe-pkg", "postinstall");
        assert_eq!(decision, "allowed");
    }

    #[test]
    fn trusted_scope_allows_scoped_package() {
        let policy = ScriptPolicy {
            default_policy: "deny".to_string(),
            allowed_packages: vec![],
            blocked_packages: vec![],
            allowed_script_types: vec![],
            trusted_scopes: vec!["@myco".to_string()],
        };
        let (decision, _) = check_script_permission(&policy, "@myco/utils", "postinstall");
        assert_eq!(decision, "allowed");
    }

    #[test]
    fn unknown_package_uses_default_policy() {
        let policy = ScriptPolicy {
            default_policy: "deny".to_string(),
            allowed_packages: vec![],
            blocked_packages: vec![],
            allowed_script_types: vec![],
            trusted_scopes: vec![],
        };
        let (decision, _) = check_script_permission(&policy, "unknown-pkg", "preinstall");
        assert_eq!(decision, "deny");
    }

    #[test]
    fn allowed_script_type_permits_execution() {
        let policy = ScriptPolicy {
            default_policy: "deny".to_string(),
            allowed_packages: vec![],
            blocked_packages: vec![],
            allowed_script_types: vec!["postinstall".to_string()],
            trusted_scopes: vec![],
        };
        let (decision, _) = check_script_permission(&policy, "any-pkg", "postinstall");
        assert_eq!(decision, "allowed");
    }

    #[test]
    fn parse_script_policy_json_parses_default_policy() {
        let json = r#"{"defaultPolicy":"deny","blockedPackages":["bad-pkg"]}"#;
        let policy = parse_script_policy_json(json);
        assert_eq!(policy.default_policy, "deny");
        assert!(policy.blocked_packages.contains(&"bad-pkg".to_string()));
    }

    #[test]
    fn scripts_allow_creates_policy_file() {
        let tmp = std::env::temp_dir().join("scripts-test-allow");
        std::fs::create_dir_all(&tmp).unwrap();
        scripts_allow(&tmp, "safe-pkg").unwrap();
        let policy = load_script_policy(&tmp);
        assert!(policy.allowed_packages.contains(&"safe-pkg".to_string()));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn scripts_block_creates_policy_file() {
        let tmp = std::env::temp_dir().join("scripts-test-block");
        std::fs::create_dir_all(&tmp).unwrap();
        scripts_block(&tmp, "evil-pkg").unwrap();
        let policy = load_script_policy(&tmp);
        assert!(policy.blocked_packages.contains(&"evil-pkg".to_string()));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
