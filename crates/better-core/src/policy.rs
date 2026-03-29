use std::fs;
use std::path::Path;

use crate::types::*;
use crate::{extract_json_field, extract_json_object_raw,
            list_packages_in_node_modules, check_dedupe, depth_from_path, JsonWriter,
            extract_json_number};

// === D.3: Policy engine ===

fn default_policy_config() -> PolicyConfig {
    PolicyConfig {
        threshold: 70,
        rules: vec![
            PolicyRule {
                id: "no-deprecated".into(), severity: "warning".into(),
                description: "No deprecated packages".into(),
                max_duplicates: None, max_depth: None, banned_packages: Vec::new(),
            },
            PolicyRule {
                id: "max-duplicates".into(), severity: "warning".into(),
                description: "Maximum duplicate package instances".into(),
                max_duplicates: Some(3), max_depth: None, banned_packages: Vec::new(),
            },
            PolicyRule {
                id: "max-depth".into(), severity: "warning".into(),
                description: "Maximum dependency nesting depth".into(),
                max_duplicates: None, max_depth: Some(15), banned_packages: Vec::new(),
            },
        ],
        waivers: Vec::new(),
    }
}

pub fn load_policy_config(project_root: &Path) -> PolicyConfig {
    let config_file = project_root.join(".betterrc.json");
    if let Ok(content) = fs::read_to_string(&config_file) {
        if let Some(raw) = extract_json_object_raw(&content, "policy") {
            let threshold = extract_json_number(&raw, "threshold").unwrap_or(70) as i32;
            let mut cfg = default_policy_config();
            cfg.threshold = threshold;
            return cfg;
        }
        let threshold = extract_json_number(&content, "threshold").unwrap_or(70) as i32;
        let mut cfg = default_policy_config();
        cfg.threshold = threshold;
        return cfg;
    }
    let pkg_json = project_root.join("package.json");
    if let Ok(content) = fs::read_to_string(&pkg_json) {
        if let Some(better_raw) = extract_json_object_raw(&content, "better") {
            if let Some(policy_raw) = extract_json_object_raw(&better_raw, "policy") {
                let threshold = extract_json_number(&policy_raw, "threshold").unwrap_or(70) as i32;
                let mut cfg = default_policy_config();
                cfg.threshold = threshold;
                return cfg;
            }
        }
    }
    default_policy_config()
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
    w.end_array();
    w.key("waivers"); w.begin_array(); w.end_array();
    w.end_object();
    w.end_object();
    w.out.push('\n');
    fs::write(&path, w.finish()).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

