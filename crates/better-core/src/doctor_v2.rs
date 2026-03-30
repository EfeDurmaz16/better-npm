// crates/better-core/src/doctor_v2.rs
// Cross-ecosystem doctor v2 — universal project health diagnostics

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct DoctorV2Report {
    pub ecosystem_reports: Vec<EcosystemReport>,
    pub cross_ecosystem: CrossEcosystemReport,
    pub cas_health: CasHealth,
    pub overall_score: u8,
    pub issues: Vec<DoctorIssue>,
}

#[derive(Debug, Serialize)]
pub struct EcosystemReport {
    pub ecosystem: String,
    pub manifest_valid: bool,
    pub lockfile_present: bool,
    pub issues: Vec<DoctorIssue>,
}

#[derive(Debug, Serialize)]
pub struct CrossEcosystemReport {
    pub ecosystems_found: Vec<String>,
    pub duplicate_package_names: Vec<DuplicatePackage>,
    pub version_conflicts: Vec<VersionConflict>,
}

#[derive(Debug, Serialize)]
pub struct DuplicatePackage {
    pub name: String,
    pub ecosystems: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct VersionConflict {
    pub library_name: String,
    pub versions: Vec<ConflictEntry>,
}

#[derive(Debug, Serialize)]
pub struct ConflictEntry {
    pub ecosystem: String,
    pub package: String,
    pub version: String,
}

#[derive(Debug, Default, Serialize)]
pub struct CasHealth {
    pub total_entries: usize,
    pub total_bytes: u64,
    pub orphaned_entries: usize,
}

#[derive(Debug, Serialize)]
pub struct DoctorIssue {
    pub severity: IssueSeverity,
    pub category: String,
    pub message: String,
    pub fix_command: Option<String>,
}

#[derive(Debug, Serialize)]
pub enum IssueSeverity { Error, Warning, Info }

pub fn run_doctor_v2(project_root: &Path) -> Result<DoctorV2Report, String> {
    let mut ecosystem_reports = vec![];
    let mut all_issues = vec![];
    let mut ecosystems_found = vec![];

    // npm check
    if project_root.join("package.json").exists() {
        ecosystems_found.push("npm".to_string());
        let mut issues = vec![];

        let manifest_valid = std::fs::read_to_string(project_root.join("package.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .is_some();

        if !manifest_valid {
            issues.push(DoctorIssue {
                severity: IssueSeverity::Error,
                category: "manifest".to_string(),
                message: "package.json is invalid JSON".to_string(),
                fix_command: None,
            });
        }

        let lockfile_present = project_root.join("package-lock.json").exists()
            || project_root.join("yarn.lock").exists()
            || project_root.join("pnpm-lock.yaml").exists()
            || project_root.join("better.lock.json").exists();

        if !lockfile_present {
            issues.push(DoctorIssue {
                severity: IssueSeverity::Warning,
                category: "lockfile".to_string(),
                message: "No lockfile found for npm project".to_string(),
                fix_command: Some("better install".to_string()),
            });
        }

        if !project_root.join("node_modules").exists() {
            issues.push(DoctorIssue {
                severity: IssueSeverity::Warning,
                category: "install".to_string(),
                message: "node_modules not found — dependencies not installed".to_string(),
                fix_command: Some("better install".to_string()),
            });
        }

        all_issues.extend(issues.iter().map(|i| format!("[npm] {}", i.message)));
        ecosystem_reports.push(EcosystemReport {
            ecosystem: "npm".to_string(),
            manifest_valid,
            lockfile_present,
            issues,
        });
    }

    // Python check
    if project_root.join("pyproject.toml").exists() || project_root.join("requirements.txt").exists() {
        ecosystems_found.push("python".to_string());
        let mut issues = vec![];

        let has_venv = project_root.join(".venv").exists() || project_root.join("venv").exists();
        if !has_venv {
            issues.push(DoctorIssue {
                severity: IssueSeverity::Warning,
                category: "install".to_string(),
                message: "No virtual environment found".to_string(),
                fix_command: Some("better install".to_string()),
            });
        }

        let lockfile_present = project_root.join("poetry.lock").exists()
            || project_root.join("Pipfile.lock").exists()
            || project_root.join("uv.lock").exists();

        ecosystem_reports.push(EcosystemReport {
            ecosystem: "python".to_string(),
            manifest_valid: true,
            lockfile_present,
            issues,
        });
    }

    // Rust/Cargo check
    if project_root.join("Cargo.toml").exists() {
        ecosystems_found.push("cargo".to_string());
        let lockfile_present = project_root.join("Cargo.lock").exists();
        let mut issues = vec![];
        if !lockfile_present {
            issues.push(DoctorIssue {
                severity: IssueSeverity::Info,
                category: "lockfile".to_string(),
                message: "Cargo.lock not found (OK for libraries, recommended for binaries)".to_string(),
                fix_command: Some("cargo build".to_string()),
            });
        }
        ecosystem_reports.push(EcosystemReport {
            ecosystem: "cargo".to_string(),
            manifest_valid: true,
            lockfile_present,
            issues,
        });
    }

    // Go check
    if project_root.join("go.mod").exists() {
        ecosystems_found.push("go".to_string());
        let lockfile_present = project_root.join("go.sum").exists();
        ecosystem_reports.push(EcosystemReport {
            ecosystem: "go".to_string(),
            manifest_valid: true,
            lockfile_present,
            issues: vec![],
        });
    }

    // CAS health: quick check
    let cas_root = home_cas_dir();
    let cas_health = if cas_root.exists() {
        let total_entries = count_files(&cas_root);
        let total_bytes = dir_size_approx(&cas_root);
        CasHealth { total_entries, total_bytes, orphaned_entries: 0 }
    } else {
        CasHealth::default()
    };

    // Cross-ecosystem check
    let cross_ecosystem = CrossEcosystemReport {
        ecosystems_found: ecosystems_found.clone(),
        duplicate_package_names: vec![],
        version_conflicts: vec![],
    };

    // Compute overall score: start at 100, deduct per issue
    let error_count = ecosystem_reports.iter()
        .flat_map(|r| &r.issues)
        .filter(|i| matches!(i.severity, IssueSeverity::Error))
        .count();
    let warning_count = ecosystem_reports.iter()
        .flat_map(|r| &r.issues)
        .filter(|i| matches!(i.severity, IssueSeverity::Warning))
        .count();
    let overall_score = (100u8).saturating_sub((error_count * 20 + warning_count * 5) as u8);

    Ok(DoctorV2Report {
        ecosystem_reports,
        cross_ecosystem,
        cas_health,
        overall_score,
        issues: all_issues.into_iter().map(|msg| DoctorIssue {
            severity: IssueSeverity::Info,
            category: "summary".to_string(),
            message: msg,
            fix_command: None,
        }).collect(),
    })
}

fn home_cas_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".better").join("cas")
}

fn count_files(dir: &Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                count += count_files(&p);
            } else {
                count += 1;
            }
        }
    }
    count
}

fn dir_size_approx(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size_approx(&p);
            } else if let Ok(meta) = std::fs::metadata(&p) {
                total += meta.len();
            }
        }
    }
    total
}
