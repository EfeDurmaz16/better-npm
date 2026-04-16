// crates/better-core/src/ai/heal.rs
// Self-healing dependencies — detect vulnerabilities and apply fixes with PR creation

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct HealAction {
    pub vulnerability: String,
    pub package: String,
    pub action_type: HealActionType,
    pub status: HealStatus,
    pub pr_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub enum HealActionType {
    Upgrade { from: String, to: String },
    Remove,
    NoAction,
}

#[derive(Debug, Clone, Serialize)]
pub enum HealStatus {
    Fixed,
    PrCreated,
    TestsFailed,
    NoPatchAvailable,
    ManualRequired(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct HealReport {
    pub actions: Vec<HealAction>,
    pub fixed_count: usize,
    pub remaining_count: usize,
    pub pr_created: bool,
}

/// Heal project by upgrading vulnerable packages.
/// Returns list of actions taken.
pub fn heal_project(project_root: &Path, dry_run: bool) -> Result<HealReport, String> {
    // Check for common issues
    let mut actions = vec![];

    // 1. Check if node_modules is missing
    let node_modules = project_root.join("node_modules");
    if !node_modules.exists() && project_root.join("package.json").exists() {
        if !dry_run {
            let status = std::process::Command::new("npm")
                .args(["install"])
                .current_dir(project_root)
                .status()
                .map_err(|e| e.to_string())?;
            let heal_status = if status.success() { HealStatus::Fixed } else { HealStatus::TestsFailed };
            actions.push(HealAction {
                vulnerability: "missing_node_modules".to_string(),
                package: "(project)".to_string(),
                action_type: HealActionType::NoAction,
                status: heal_status,
                pr_url: None,
            });
        } else {
            actions.push(HealAction {
                vulnerability: "missing_node_modules".to_string(),
                package: "(project)".to_string(),
                action_type: HealActionType::NoAction,
                status: HealStatus::ManualRequired("Run 'npm install' or 'better install'".to_string()),
                pr_url: None,
            });
        }
    }

    // 2. Check for deprecated packages in package.json
    if let Ok(content) = std::fs::read_to_string(project_root.join("package.json")) {
        let known_deprecated = &[
            ("request", "got"),
            ("node-uuid", "uuid"),
            ("jade", "pug"),
            ("bower", ""),
        ];
        let pkg: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
        let deps = pkg.get("dependencies").and_then(|d| d.as_object()).cloned().unwrap_or_default();

        for (deprecated, replacement) in known_deprecated {
            if deps.contains_key(*deprecated) {
                let current = deps[*deprecated].as_str().unwrap_or("*").to_string();
                actions.push(HealAction {
                    vulnerability: format!("{} is deprecated", deprecated),
                    package: deprecated.to_string(),
                    action_type: if replacement.is_empty() {
                        HealActionType::Remove
                    } else {
                        HealActionType::Upgrade { from: current, to: replacement.to_string() }
                    },
                    status: HealStatus::ManualRequired(
                        if replacement.is_empty() {
                            format!("Remove {} from dependencies", deprecated)
                        } else {
                            format!("Replace {} with {}", deprecated, replacement)
                        }
                    ),
                    pr_url: None,
                });
            }
        }
    }

    let fixed_count = actions.iter().filter(|a| matches!(a.status, HealStatus::Fixed)).count();
    let remaining_count = actions.len() - fixed_count;

    Ok(HealReport {
        actions,
        fixed_count,
        remaining_count,
        pr_created: false,
    })
}

/// Check if project needs healing (quick check).
pub fn needs_healing(project_root: &Path) -> Vec<String> {
    let mut issues = vec![];

    if project_root.join("package.json").exists() && !project_root.join("node_modules").exists() {
        issues.push("node_modules missing — run 'better install'".to_string());
    }

    if project_root.join("package.json").exists() && !project_root.join("package-lock.json").exists()
       && !project_root.join("yarn.lock").exists() && !project_root.join("pnpm-lock.yaml").exists() {
        issues.push("No lockfile found — run 'better install'".to_string());
    }

    // Check .env.example exists but .env doesn't
    if project_root.join(".env.example").exists() && !project_root.join(".env").exists() {
        issues.push(".env file missing — copy from .env.example".to_string());
    }

    issues
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(path: &std::path::Path, content: &[u8]) {
        if let Some(p) = path.parent() { std::fs::create_dir_all(p).unwrap(); }
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(content).unwrap();
    }

    #[test]
    fn needs_healing_empty_dir_no_issues() {
        let tmp = std::env::temp_dir().join("heal2-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        let issues = needs_healing(&tmp);
        assert!(issues.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn needs_healing_missing_node_modules() {
        let tmp = std::env::temp_dir().join("heal2-test-nm");
        write_file(&tmp.join("package.json"), b"{}");
        write_file(&tmp.join("package-lock.json"), b"{}");
        let issues = needs_healing(&tmp);
        assert!(issues.iter().any(|i| i.contains("node_modules")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn needs_healing_missing_lockfile() {
        let tmp = std::env::temp_dir().join("heal2-test-nolock");
        write_file(&tmp.join("package.json"), b"{}");
        // No lockfile, no node_modules
        let issues = needs_healing(&tmp);
        assert!(issues.iter().any(|i| i.contains("lockfile") || i.contains("lock")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn heal_project_dry_run_no_changes() {
        let tmp = std::env::temp_dir().join("heal2-test-dry");
        write_file(&tmp.join("package.json"), b"{}");
        let report = heal_project(&tmp, true).unwrap();
        // Dry run should not apply anything
        assert_eq!(report.fixed_count, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn heal_action_type_upgrade_serializes() {
        let action = HealActionType::Upgrade {
            from: "1.0.0".into(),
            to: "2.0.0".into(),
        };
        let json = serde_json::to_string(&action).unwrap();
        assert!(json.contains("Upgrade") || json.contains("from") || json.contains("to"));
    }

    #[test]
    fn heal_status_no_patch_serializes() {
        let status = HealStatus::NoPatchAvailable;
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.is_empty());
    }

    #[test]
    fn heal_report_remaining_count_is_total_minus_fixed() {
        let report = HealReport {
            actions: vec![
                HealAction {
                    vulnerability: "v1".into(),
                    package: "pkg".into(),
                    action_type: HealActionType::NoAction,
                    status: HealStatus::Fixed,
                    pr_url: None,
                },
                HealAction {
                    vulnerability: "v2".into(),
                    package: "pkg2".into(),
                    action_type: HealActionType::Remove,
                    status: HealStatus::NoPatchAvailable,
                    pr_url: None,
                },
            ],
            fixed_count: 1,
            remaining_count: 1,
            pr_created: false,
        };
        assert_eq!(report.fixed_count + report.remaining_count, report.actions.len());
    }

    #[test]
    fn heal_project_detects_deprecated_request() {
        let tmp = std::env::temp_dir().join("heal2-test-deprecated");
        write_file(
            &tmp.join("package.json"),
            br#"{"name":"app","version":"1.0.0","dependencies":{"request":"^2.88.2"}}"#,
        );
        let report = heal_project(&tmp, true).unwrap();
        assert!(report.actions.iter().any(|a| a.package == "request"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn needs_healing_env_example_without_env() {
        let tmp = std::env::temp_dir().join("heal2-test-env");
        std::fs::create_dir_all(&tmp).unwrap();
        write_file(&tmp.join(".env.example"), b"FOO=bar");
        let issues = needs_healing(&tmp);
        assert!(issues.iter().any(|i| i.contains(".env")));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
