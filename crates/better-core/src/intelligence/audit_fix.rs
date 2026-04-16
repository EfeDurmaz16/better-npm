// crates/better-core/src/intelligence/audit_fix.rs
// Smart audit fix engine — upgrade to patched version, run tests, rollback if needed

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct AuditFixResult {
    pub fixes_attempted: usize,
    pub fixes_applied: usize,
    pub fixes_rolled_back: usize,
    pub remaining_vulns: usize,
    pub details: Vec<FixAttempt>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FixAttempt {
    pub package: String,
    pub from_version: String,
    pub to_version: String,
    pub vuln_ids: Vec<String>,
    pub status: FixStatus,
    pub test_output: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub enum FixStatus {
    Applied,
    RolledBack { reason: String },
    Skipped { reason: String },
    Failed { error: String },
}

#[derive(Debug, Clone)]
pub struct AuditFixConfig {
    pub dry_run: bool,
    pub run_tests: bool,
    pub force_major: bool,
    pub test_command: Option<String>,
}

impl Default for AuditFixConfig {
    fn default() -> Self {
        Self {
            dry_run: false,
            run_tests: false,
            force_major: false,
            test_command: None,
        }
    }
}

/// Apply vulnerability fixes from audit results.
pub fn apply_audit_fixes(
    project_root: &Path,
    vulnerabilities: &[AuditVuln],
    config: &AuditFixConfig,
) -> Result<AuditFixResult, String> {
    let mut details = vec![];
    let total = vulnerabilities.len();

    for vuln in vulnerabilities {
        let Some(ref patched) = vuln.patched_version else {
            details.push(FixAttempt {
                package: vuln.package.clone(),
                from_version: vuln.version.clone(),
                to_version: "N/A".to_string(),
                vuln_ids: vuln.ids.clone(),
                status: FixStatus::Skipped {
                    reason: "No patched version available".to_string(),
                },
                test_output: None,
            });
            continue;
        };

        // Check if this is a major version bump
        let is_major = is_major_bump(&vuln.version, patched);
        if is_major && !config.force_major {
            details.push(FixAttempt {
                package: vuln.package.clone(),
                from_version: vuln.version.clone(),
                to_version: patched.clone(),
                vuln_ids: vuln.ids.clone(),
                status: FixStatus::Skipped {
                    reason: "Major version upgrade requires --force".to_string(),
                },
                test_output: None,
            });
            continue;
        }

        if config.dry_run {
            details.push(FixAttempt {
                package: vuln.package.clone(),
                from_version: vuln.version.clone(),
                to_version: patched.clone(),
                vuln_ids: vuln.ids.clone(),
                status: FixStatus::Applied,
                test_output: None,
            });
            continue;
        }

        // Apply fix via npm install
        let install_result = std::process::Command::new("npm")
            .args(["install", &format!("{}@{}", vuln.package, patched)])
            .current_dir(project_root)
            .output();

        match install_result {
            Ok(out) if out.status.success() => {
                let test_output = if config.run_tests {
                    let test_cmd = config.test_command.as_deref().unwrap_or("npm test");
                    let parts: Vec<&str> = test_cmd.split_whitespace().collect();
                    let test_result = if let Some((cmd, args)) = parts.split_first() {
                        std::process::Command::new(cmd)
                            .args(args)
                            .current_dir(project_root)
                            .output()
                            .ok()
                    } else {
                        None
                    };

                    if let Some(tr) = test_result {
                        if !tr.status.success() {
                            // Rollback
                            let _ = std::process::Command::new("npm")
                                .args(["install", &format!("{}@{}", vuln.package, vuln.version)])
                                .current_dir(project_root)
                                .output();
                            details.push(FixAttempt {
                                package: vuln.package.clone(),
                                from_version: vuln.version.clone(),
                                to_version: patched.clone(),
                                vuln_ids: vuln.ids.clone(),
                                status: FixStatus::RolledBack {
                                    reason: "Tests failed after upgrade".to_string(),
                                },
                                test_output: Some(String::from_utf8_lossy(&tr.stderr).to_string()),
                            });
                            continue;
                        }
                        Some(String::from_utf8_lossy(&tr.stdout).chars().take(500).collect())
                    } else {
                        None
                    }
                } else {
                    None
                };

                details.push(FixAttempt {
                    package: vuln.package.clone(),
                    from_version: vuln.version.clone(),
                    to_version: patched.clone(),
                    vuln_ids: vuln.ids.clone(),
                    status: FixStatus::Applied,
                    test_output,
                });
            }
            Ok(out) => {
                details.push(FixAttempt {
                    package: vuln.package.clone(),
                    from_version: vuln.version.clone(),
                    to_version: patched.clone(),
                    vuln_ids: vuln.ids.clone(),
                    status: FixStatus::Failed {
                        error: String::from_utf8_lossy(&out.stderr).chars().take(200).collect(),
                    },
                    test_output: None,
                });
            }
            Err(e) => {
                details.push(FixAttempt {
                    package: vuln.package.clone(),
                    from_version: vuln.version.clone(),
                    to_version: patched.clone(),
                    vuln_ids: vuln.ids.clone(),
                    status: FixStatus::Failed { error: e.to_string() },
                    test_output: None,
                });
            }
        }
    }

    let fixes_applied = details.iter().filter(|d| matches!(d.status, FixStatus::Applied)).count();
    let fixes_rolled_back = details.iter().filter(|d| matches!(d.status, FixStatus::RolledBack { .. })).count();
    let remaining_vulns = total - fixes_applied;

    Ok(AuditFixResult {
        fixes_attempted: total,
        fixes_applied,
        fixes_rolled_back,
        remaining_vulns,
        details,
    })
}

#[derive(Debug, Clone)]
pub struct AuditVuln {
    pub package: String,
    pub version: String,
    pub severity: String,
    pub ids: Vec<String>,
    pub patched_version: Option<String>,
}

fn is_major_bump(current: &str, target: &str) -> bool {
    let cur_major: u64 = current.split('.').next()
        .and_then(|s| s.trim_start_matches('^').trim_start_matches('~').trim_start_matches('v').parse().ok())
        .unwrap_or(0);
    let tgt_major: u64 = target.split('.').next()
        .and_then(|s| s.trim_start_matches('^').trim_start_matches('~').trim_start_matches('v').parse().ok())
        .unwrap_or(0);
    tgt_major > cur_major
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn make_vuln(pkg: &str, from: &str, to: Option<&str>) -> AuditVuln {
        AuditVuln {
            package: pkg.to_string(),
            version: from.to_string(),
            severity: "high".to_string(),
            ids: vec!["GHSA-test-0001".to_string()],
            patched_version: to.map(|s| s.to_string()),
        }
    }

    #[test]
    fn no_patched_version_is_skipped() {
        let vulns = vec![make_vuln("unpatchable", "1.0.0", None)];
        let cfg = AuditFixConfig { dry_run: true, ..Default::default() };
        let result = apply_audit_fixes(Path::new("/tmp"), &vulns, &cfg).unwrap();
        assert_eq!(result.fixes_attempted, 1);
        assert_eq!(result.fixes_applied, 0);
        assert!(matches!(result.details[0].status, FixStatus::Skipped { .. }));
    }

    #[test]
    fn major_bump_skipped_without_force() {
        let vulns = vec![make_vuln("mypkg", "1.5.0", Some("2.0.0"))];
        let cfg = AuditFixConfig { dry_run: true, force_major: false, ..Default::default() };
        let result = apply_audit_fixes(Path::new("/tmp"), &vulns, &cfg).unwrap();
        assert!(matches!(result.details[0].status, FixStatus::Skipped { .. }));
    }

    #[test]
    fn major_bump_allowed_with_force() {
        let vulns = vec![make_vuln("mypkg", "1.5.0", Some("2.0.0"))];
        let cfg = AuditFixConfig { dry_run: true, force_major: true, ..Default::default() };
        let result = apply_audit_fixes(Path::new("/tmp"), &vulns, &cfg).unwrap();
        assert!(matches!(result.details[0].status, FixStatus::Applied));
    }

    #[test]
    fn dry_run_applies_without_spawning_npm() {
        let vulns = vec![make_vuln("lodash", "4.17.20", Some("4.17.21"))];
        let cfg = AuditFixConfig { dry_run: true, ..Default::default() };
        let result = apply_audit_fixes(Path::new("/nonexistent"), &vulns, &cfg).unwrap();
        assert_eq!(result.fixes_applied, 1);
    }

    #[test]
    fn is_major_bump_detection() {
        assert!(is_major_bump("1.0.0", "2.0.0"));
        assert!(!is_major_bump("1.0.0", "1.5.0"));
        assert!(!is_major_bump("2.0.0", "2.0.1"));
        assert!(is_major_bump("v1.0.0", "v2.0.0"));
    }

    #[test]
    fn remaining_vulns_count() {
        let vulns = vec![
            make_vuln("a", "1.0.0", Some("1.0.1")),  // will be applied (dry_run)
            make_vuln("b", "2.0.0", None),             // will be skipped (no fix)
        ];
        let cfg = AuditFixConfig { dry_run: true, ..Default::default() };
        let result = apply_audit_fixes(Path::new("/tmp"), &vulns, &cfg).unwrap();
        assert_eq!(result.fixes_applied, 1);
        assert_eq!(result.remaining_vulns, 1);
    }

    #[test]
    fn audit_vuln_has_correct_fields() {
        let v = make_vuln("lodash", "4.17.20", Some("4.17.21"));
        assert_eq!(v.package, "lodash");
        assert_eq!(v.version, "4.17.20");
        assert_eq!(v.patched_version, Some("4.17.21".to_string()));
        assert!(!v.ids.is_empty());
    }

    #[test]
    fn fix_status_applied_serializes() {
        let status = FixStatus::Applied;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"Applied\"");
    }

    #[test]
    fn empty_vulns_returns_zero_counts() {
        let cfg = AuditFixConfig { dry_run: true, ..Default::default() };
        let result = apply_audit_fixes(Path::new("/tmp"), &[], &cfg).unwrap();
        assert_eq!(result.fixes_attempted, 0);
        assert_eq!(result.fixes_applied, 0);
        assert_eq!(result.remaining_vulns, 0);
    }
}
