use std::fs;
use std::path::Path;

use crate::types::{DoctorFinding, DoctorReport};
use crate::analyze;

pub fn run_doctor(project_root: &Path, threshold: i32) -> Result<DoctorReport, String> {
    let mut findings = Vec::new();
    let mut deductions = 0i32;

    // Check 1: Duplicates
    let node_modules = project_root.join("node_modules");
    if node_modules.exists() {
        if let Ok(report) = analyze(project_root, false) {
            for d in &report.duplicates {
                deductions += 2;
                findings.push(DoctorFinding {
                    id: format!("dup-{}", d.name),
                    title: format!("Duplicate package: {} ({} versions)", d.name, d.versions.len()),
                    severity: "warning".to_string(),
                    impact: -2,
                    recommendation: format!("Run `npm dedupe` to reduce {} instances", d.count),
                });
            }

            // Check deep nesting
            if report.depth.max_depth > 5 {
                deductions += 3;
                findings.push(DoctorFinding {
                    id: "deep-nesting".to_string(),
                    title: format!("Deep nesting detected (max depth: {})", report.depth.max_depth),
                    severity: "warning".to_string(),
                    impact: -3,
                    recommendation: "Consider flattening dependencies".to_string(),
                });
            }
        }
    } else {
        deductions += 15;
        findings.push(DoctorFinding {
            id: "missing-node-modules".to_string(),
            title: "node_modules directory not found".to_string(),
            severity: "critical".to_string(),
            impact: -15,
            recommendation: "Run `better-core install` to install dependencies".to_string(),
        });
    }

    // Check 2: Lockfile freshness
    let pkg_json = project_root.join("package.json");
    let lockfile = project_root.join("package-lock.json");
    if lockfile.exists() && pkg_json.exists() {
        let lock_mtime = fs::metadata(&lockfile).and_then(|m| m.modified()).ok();
        let pkg_mtime = fs::metadata(&pkg_json).and_then(|m| m.modified()).ok();
        if let (Some(lock_t), Some(pkg_t)) = (lock_mtime, pkg_mtime) {
            if pkg_t > lock_t {
                deductions += 10;
                findings.push(DoctorFinding {
                    id: "stale-lockfile".to_string(),
                    title: "package-lock.json is older than package.json".to_string(),
                    severity: "error".to_string(),
                    impact: -10,
                    recommendation: "Run `npm install` to update lockfile".to_string(),
                });
            }
        }
    } else if !lockfile.exists() {
        deductions += 10;
        findings.push(DoctorFinding {
            id: "missing-lockfile".to_string(),
            title: "No package-lock.json found".to_string(),
            severity: "error".to_string(),
            impact: -10,
            recommendation: "Run `npm install` to generate a lockfile".to_string(),
        });
    }

    // Check 3: Deprecated packages (look for "deprecated" field in lockfile)
    if lockfile.exists() {
        if let Ok(lock_content) = fs::read_to_string(&lockfile) {
            let deprecated_count = lock_content.matches("\"deprecated\"").count();
            if deprecated_count > 0 {
                deductions += (deprecated_count as i32).min(25);
                findings.push(DoctorFinding {
                    id: "deprecated-packages".to_string(),
                    title: format!("{} deprecated package(s) found", deprecated_count),
                    severity: "warning".to_string(),
                    impact: -(deprecated_count as i32).min(25),
                    recommendation: "Update deprecated packages to maintained alternatives".to_string(),
                });
            }
        }
    }

    // Check 4: .npmrc exists
    if !project_root.join(".npmrc").exists() {
        // Not a deduction, just a suggestion
        findings.push(DoctorFinding {
            id: "no-npmrc".to_string(),
            title: "No .npmrc configuration file".to_string(),
            severity: "info".to_string(),
            impact: 0,
            recommendation: "Consider adding .npmrc for reproducible builds".to_string(),
        });
    }

    let score = (100 - deductions).max(0);
    Ok(DoctorReport { score, threshold, findings })
}

