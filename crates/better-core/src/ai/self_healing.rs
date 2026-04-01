// crates/better-core/src/ai/self_healing.rs
// Self-healing dependency management — detect and auto-fix common issues

use std::path::Path;

#[derive(Debug, Clone, serde::Serialize)]
pub struct HealingAction {
    pub issue: String,
    pub action: String,
    pub applied: bool,
    pub details: String,
}

pub struct SelfHealingEngine;

impl SelfHealingEngine {
    /// Detect and fix common dependency issues automatically.
    pub fn heal(project_root: &Path, dry_run: bool) -> Vec<HealingAction> {
        let mut actions = Vec::new();

        // Check 1: Missing lockfile
        if !project_root.join("package-lock.json").exists()
            && !project_root.join("better.lock").exists()
            && project_root.join("package.json").exists()
        {
            actions.push(HealingAction {
                issue: "Missing lockfile".to_string(),
                action: "better install".to_string(),
                applied: false,
                details: "No package-lock.json or better.lock found".to_string(),
            });
        }

        // Check 2: node_modules out of sync
        if project_root.join("package-lock.json").exists()
            && !project_root.join("node_modules").exists()
        {
            actions.push(HealingAction {
                issue: "node_modules missing".to_string(),
                action: "better install --frozen".to_string(),
                applied: false,
                details: "Lockfile exists but node_modules is absent".to_string(),
            });
        }

        // Check 3: Deprecated packages in lockfile
        if let Ok(content) = std::fs::read_to_string(project_root.join("package-lock.json")) {
            if content.contains("\"deprecated\"") {
                actions.push(HealingAction {
                    issue: "Deprecated packages installed".to_string(),
                    action: "better update --safe".to_string(),
                    applied: false,
                    details: "package-lock.json contains deprecated packages".to_string(),
                });
            }
        }

        // Check 4: .env.example exists but .env is missing
        if project_root.join(".env.example").exists() && !project_root.join(".env").exists() {
            if !dry_run {
                // Copy .env.example to .env
                let _ = std::fs::copy(
                    project_root.join(".env.example"),
                    project_root.join(".env"),
                );
            }
            actions.push(HealingAction {
                issue: ".env missing".to_string(),
                action: if dry_run { "cp .env.example .env" } else { "Copied .env.example → .env" }.to_string(),
                applied: !dry_run,
                details: ".env.example exists but .env not found".to_string(),
            });
        }

        // Check 5: package.json has scripts but no lockfile
        if let Ok(content) = std::fs::read_to_string(project_root.join("package.json")) {
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
                // Check for engine field violations
                if let Some(engines) = pkg["engines"]["node"].as_str() {
                    let node_ver = std::env::var("NODE_VERSION").unwrap_or_else(|_| "20".to_string());
                    let required = engines.replace(">=", "").replace(">", "").trim().parse::<u32>().unwrap_or(0);
                    let current = node_ver.split('.').next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(20);
                    if required > current {
                        actions.push(HealingAction {
                            issue: format!("Node.js version too old: {} < {}", current, required),
                            action: format!("nvm use {} || n {}", required, required),
                            applied: false,
                            details: format!("package.json requires Node.js >= {}", required),
                        });
                    }
                }
            }
        }

        actions
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(path: &std::path::Path, content: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(content).unwrap();
    }

    #[test]
    fn empty_project_no_actions() {
        let tmp = std::env::temp_dir().join("heal-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        // No package.json, no lockfile → no actions
        let actions = SelfHealingEngine::heal(&tmp, true);
        assert!(actions.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_lockfile_detected() {
        let tmp = std::env::temp_dir().join("heal-test-missing-lock");
        write_file(&tmp.join("package.json"), b"{}");
        let actions = SelfHealingEngine::heal(&tmp, true);
        assert!(actions.iter().any(|a| a.issue.contains("lockfile")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn node_modules_missing_with_lockfile_detected() {
        let tmp = std::env::temp_dir().join("heal-test-nm-missing");
        write_file(&tmp.join("package.json"), b"{}");
        write_file(&tmp.join("package-lock.json"), b"{}");
        // node_modules intentionally absent
        let actions = SelfHealingEngine::heal(&tmp, true);
        assert!(actions.iter().any(|a| a.issue.contains("node_modules")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn deprecated_in_lockfile_flagged() {
        let tmp = std::env::temp_dir().join("heal-test-deprecated");
        write_file(&tmp.join("package.json"), b"{}");
        write_file(&tmp.join("package-lock.json"), b"{\"deprecated\": \"use new-pkg\"}");
        std::fs::create_dir_all(tmp.join("node_modules")).unwrap();
        let actions = SelfHealingEngine::heal(&tmp, true);
        assert!(actions.iter().any(|a| a.issue.contains("Deprecated")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn env_example_copied_when_not_dry_run() {
        let tmp = std::env::temp_dir().join("heal-test-env");
        write_file(&tmp.join(".env.example"), b"SECRET=changeme");
        let _ = std::fs::remove_file(tmp.join(".env")); // ensure .env absent
        let actions = SelfHealingEngine::heal(&tmp, false);
        assert!(actions.iter().any(|a| a.issue.contains(".env")));
        // The copy should have been applied
        assert!(actions.iter().any(|a| a.applied));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
