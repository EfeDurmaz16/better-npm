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
