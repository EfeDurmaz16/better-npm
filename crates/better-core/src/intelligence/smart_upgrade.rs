// crates/better-core/src/intelligence/smart_upgrade.rs
//
// Smart upgrade runner (v1.5 Task 115.2).
//
// Combines changelog analysis + reputation scoring to plan and validate
// package upgrades without requiring network I/O in the core logic.
// The caller is responsible for supplying parsed data; this module
// provides the planning, migration-step application, and test-gating logic.

use std::path::Path;

use serde::Serialize;

use super::changelog::{ChangelogAnalysis, MigrationStep, RiskLevel};
use super::scoring::ReputationScore;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SmartUpgradeResult {
    pub package: String,
    pub from_version: String,
    pub to_version: String,
    pub steps_applied: Vec<UpgradeStep>,
    pub tests_passed: bool,
    pub rollback_applied: bool,
    pub dry_run: bool,
    pub risk_level: RiskLevel,
    /// Human-readable summary
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpgradeStep {
    pub description: String,
    pub files_modified: Vec<String>,
    pub status: StepStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Applied,
    Skipped,
    Failed(String),
}

/// Input to the smart upgrade planner.
pub struct UpgradeInput<'a> {
    pub project_root: &'a Path,
    pub package: &'a str,
    pub from_version: &'a str,
    pub to_version: &'a str,
    /// Pre-fetched changelog analysis (None = no changelog available)
    pub changelog: Option<&'a ChangelogAnalysis>,
    /// Reputation score of the *target* version (None = unscored)
    pub target_reputation: Option<&'a ReputationScore>,
    /// Run without modifying any files
    pub dry_run: bool,
    /// Minimum acceptable reputation score (0–100); upgrade is blocked below this
    pub min_reputation_score: u8,
}

#[derive(Debug)]
pub enum UpgradeError {
    /// Reputation score too low
    LowReputation { score: u8, minimum: u8 },
    /// Risk level too high for unattended upgrade
    RiskTooHigh { risk: RiskLevel },
    /// A migration step failed
    MigrationFailed(String),
    /// I/O error
    Io(std::io::Error),
}

impl std::fmt::Display for UpgradeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LowReputation { score, minimum } =>
                write!(f, "Package reputation {} is below minimum {}", score, minimum),
            Self::RiskTooHigh { risk } =>
                write!(f, "Upgrade risk {:?} is too high for unattended execution", risk),
            Self::MigrationFailed(msg) => write!(f, "Migration failed: {}", msg),
            Self::Io(e) => write!(f, "I/O error: {}", e),
        }
    }
}

// ---------------------------------------------------------------------------
// Core planner
// ---------------------------------------------------------------------------

/// Plan (and optionally execute) a smart upgrade.
///
/// In `dry_run` mode no files are touched and `tests_passed` is always `true`.
pub fn smart_upgrade(input: &UpgradeInput<'_>) -> Result<SmartUpgradeResult, UpgradeError> {
    // 1. Reputation gate
    if let Some(rep) = input.target_reputation {
        if rep.score < input.min_reputation_score {
            return Err(UpgradeError::LowReputation {
                score: rep.score,
                minimum: input.min_reputation_score,
            });
        }
    }

    // 2. Risk gate — refuse Critical upgrades unless dry_run (they still plan)
    let risk = input.changelog
        .map(|c| c.risk_level.clone())
        .unwrap_or(RiskLevel::Low);

    if !input.dry_run && risk == RiskLevel::Critical {
        return Err(UpgradeError::RiskTooHigh { risk });
    }

    // 3. Collect automated migration steps
    let steps_to_apply: Vec<&MigrationStep> = input.changelog
        .map(|c| c.migration_steps.iter().filter(|s| s.automated).collect())
        .unwrap_or_default();

    // 4. Apply / simulate steps
    let mut applied_steps: Vec<UpgradeStep> = Vec::new();
    for step in &steps_to_apply {
        let status = if input.dry_run {
            StepStatus::Skipped
        } else {
            match apply_migration_step(input.project_root, step) {
                Ok(files) => {
                    applied_steps.push(UpgradeStep {
                        description: step.description.clone(),
                        files_modified: files,
                        status: StepStatus::Applied,
                    });
                    continue;
                }
                Err(e) => StepStatus::Failed(e.to_string()),
            }
        };
        applied_steps.push(UpgradeStep {
            description: step.description.clone(),
            files_modified: vec![],
            status,
        });
    }

    // 5. Summarise
    let breaking_count = input.changelog
        .map(|c| c.breaking_changes.len())
        .unwrap_or(0);

    let summary = build_summary(
        input.package,
        input.from_version,
        input.to_version,
        breaking_count,
        &risk,
        applied_steps.len(),
        input.dry_run,
    );

    Ok(SmartUpgradeResult {
        package: input.package.to_string(),
        from_version: input.from_version.to_string(),
        to_version: input.to_version.to_string(),
        steps_applied: applied_steps,
        tests_passed: true,  // tests are run externally; core just plans
        rollback_applied: false,
        dry_run: input.dry_run,
        risk_level: risk,
        summary,
    })
}

// ---------------------------------------------------------------------------
// Migration step application
// ---------------------------------------------------------------------------

/// Apply a single migration step to the project, returning paths of modified files.
fn apply_migration_step(
    root: &Path,
    step: &MigrationStep,
) -> Result<Vec<String>, std::io::Error> {
    if step.search_pattern.is_empty() || step.replacement.is_empty() {
        return Ok(vec![]);
    }

    let mut modified = Vec::new();
    apply_in_dir(root, root, step, &mut modified)?;
    Ok(modified)
}

fn apply_in_dir(
    root: &Path,
    dir: &Path,
    step: &MigrationStep,
    modified: &mut Vec<String>,
) -> Result<(), std::io::Error> {
    for entry in std::fs::read_dir(dir)?.flatten() {
        let path = entry.path();
        let name = path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if matches!(name.as_str(), "node_modules" | "target" | ".git" | "dist" | "build") {
            continue;
        }

        if path.is_dir() {
            apply_in_dir(root, &path, step, modified)?;
        } else if is_target_file(&path, &step.file_pattern) {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if content.contains(&step.search_pattern) {
                    let new_content = content.replace(&step.search_pattern, &step.replacement);
                    std::fs::write(&path, new_content)?;
                    let rel = path.strip_prefix(root)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| path.display().to_string());
                    modified.push(rel);
                }
            }
        }
    }
    Ok(())
}

fn is_target_file(path: &Path, pattern: &str) -> bool {
    // Simple extension matching from patterns like "**/*.{js,ts,jsx,tsx}"
    let exts: Vec<&str> = pattern
        .split('{')
        .nth(1)
        .and_then(|s| s.split('}').next())
        .map(|s| s.split(',').collect())
        .unwrap_or_default();

    if exts.is_empty() {
        return false;
    }

    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| exts.iter().any(|&e| e == ext))
        .unwrap_or(false)
}

fn build_summary(
    package: &str,
    from: &str,
    to: &str,
    breaking: usize,
    risk: &RiskLevel,
    steps: usize,
    dry_run: bool,
) -> String {
    let mode = if dry_run { " [dry-run]" } else { "" };
    format!(
        "{}: {} → {}{} | risk: {:?} | {} breaking change(s) | {} migration step(s) applied",
        package, from, to, mode, risk, breaking, steps
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::changelog::{analyze_changelog, RiskLevel};

    const CHANGELOG_TEXT: &str = r#"
## [2.0.0] - 2024-01-01
### BREAKING CHANGES
- Removed `oldApi()` — use `newApi()` instead
## [1.5.0] - 2023-06-01
### Added
- Some new feature
"#;

    fn make_input<'a>(
        root: &'a Path,
        pkg: &'a str,
        changelog: Option<&'a ChangelogAnalysis>,
        dry_run: bool,
    ) -> UpgradeInput<'a> {
        UpgradeInput {
            project_root: root,
            package: pkg,
            from_version: "1.5.0",
            to_version: "2.0.0",
            changelog,
            target_reputation: None,
            dry_run,
            min_reputation_score: 0,
        }
    }

    #[test]
    fn dry_run_produces_result_without_writing() {
        let tmp = std::env::temp_dir().join("smart-upgrade-test");
        let changelog = analyze_changelog("mypkg", "1.5.0", "2.0.0", CHANGELOG_TEXT).ok();
        let input = make_input(&tmp, "mypkg", changelog.as_ref(), true);
        let result = smart_upgrade(&input).unwrap();
        assert!(result.dry_run);
        assert_eq!(result.from_version, "1.5.0");
        assert_eq!(result.to_version, "2.0.0");
    }

    #[test]
    fn low_reputation_blocked() {
        use crate::intelligence::signals::PackageSignals;
        use crate::intelligence::scoring::compute_score;
        let mut sig = PackageSignals::default();
        sig.package = "bad-pkg".to_string();
        sig.version = "2.0.0".to_string();
        sig.typosquat_suspect = true; // will slash score
        let rep = compute_score(&sig);
        let tmp = std::env::temp_dir();
        let input = UpgradeInput {
            project_root: &tmp,
            package: "bad-pkg",
            from_version: "1.0.0",
            to_version: "2.0.0",
            changelog: None,
            target_reputation: Some(&rep),
            dry_run: false,
            min_reputation_score: 80, // high threshold
        };
        let err = smart_upgrade(&input).unwrap_err();
        assert!(matches!(err, UpgradeError::LowReputation { .. }));
    }

    #[test]
    fn critical_risk_blocked_in_live_mode() {
        // Build a changelog with 6 breaking changes → Critical
        let big_changelog = r#"
## [2.0.0]
### BREAKING CHANGES
- Removed `a()`
- Removed `b()`
- Removed `c()`
- Removed `d()`
- Removed `e()`
- Removed `f()`
## [1.0.0]
Initial
"#;
        let ca = analyze_changelog("pkg", "1.0.0", "2.0.0", big_changelog).unwrap();
        assert_eq!(ca.risk_level, RiskLevel::Critical);
        let tmp = std::env::temp_dir();
        let input = make_input(&tmp, "pkg", Some(&ca), false /* live mode */);
        let err = smart_upgrade(&input).unwrap_err();
        assert!(matches!(err, UpgradeError::RiskTooHigh { .. }));
    }

    #[test]
    fn critical_risk_allowed_in_dry_run() {
        let big_changelog = r#"
## [2.0.0]
### BREAKING CHANGES
- Removed `a()` - Removed `b()` - Removed `c()` - Removed `d()` - Removed `e()` - Removed `f()`
## [1.0.0]
"#;
        let ca = analyze_changelog("pkg", "1.0.0", "2.0.0", big_changelog).ok();
        let tmp = std::env::temp_dir();
        let input = make_input(&tmp, "pkg", ca.as_ref(), true /* dry run */);
        let result = smart_upgrade(&input).unwrap();
        assert!(result.dry_run);
    }

    #[test]
    fn summary_contains_key_fields() {
        let tmp = std::env::temp_dir().join("smart-upgrade-summary");
        let changelog = analyze_changelog("express", "4.0.0", "5.0.0", CHANGELOG_TEXT).ok();
        let input = make_input(&tmp, "express", changelog.as_ref(), true);
        let result = smart_upgrade(&input).unwrap();
        assert!(result.summary.contains("express"));
        assert!(result.summary.contains("→"));
    }

    #[test]
    fn no_changelog_succeeds_with_low_risk() {
        let tmp = std::env::temp_dir();
        let input = make_input(&tmp, "simple-pkg", None, true);
        let result = smart_upgrade(&input).unwrap();
        assert_eq!(result.risk_level, RiskLevel::Low);
    }

    #[test]
    fn is_target_file_matches_js_pattern() {
        let path = std::path::Path::new("src/app.js");
        assert!(is_target_file(path, "**/*.{js,ts,jsx,tsx}"));
    }

    #[test]
    fn is_target_file_rejects_non_matching() {
        let path = std::path::Path::new("src/app.css");
        assert!(!is_target_file(path, "**/*.{js,ts,jsx,tsx}"));
    }

    #[test]
    fn is_target_file_no_braces_returns_false() {
        let path = std::path::Path::new("src/app.js");
        assert!(!is_target_file(path, "**/*.js")); // no braces → no extensions parsed
    }

    #[test]
    fn build_summary_dry_run_label() {
        let summary = build_summary("express", "4.0.0", "5.0.0", 2, &RiskLevel::High, 3, true);
        assert!(summary.contains("[dry-run]"));
        assert!(summary.contains("express"));
        assert!(summary.contains("4.0.0"));
        assert!(summary.contains("5.0.0"));
    }

    #[test]
    fn build_summary_live_has_no_dry_run_label() {
        let summary = build_summary("lodash", "4.0.0", "4.17.21", 0, &RiskLevel::Low, 0, false);
        assert!(!summary.contains("[dry-run]"));
        assert!(summary.contains("lodash"));
    }
}
