// crates/better-core/src/cross_project.rs
//
// Cross-project dependency intelligence — analyze patterns across multiple
// projects to identify shared upgrade opportunities, common vulnerabilities,
// and dependency drift.

use std::path::PathBuf;
use std::collections::HashMap;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectScan {
    pub root: PathBuf,
    pub packages: Vec<PackageSummary>,
    pub ecosystem: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PackageSummary {
    pub name: String,
    pub version: String,
    pub is_direct: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CrossProjectReport {
    pub projects_scanned: usize,
    pub total_packages: usize,
    pub shared_packages: Vec<SharedPackage>,
    pub version_drift: Vec<VersionDrift>,
    pub upgrade_opportunities: Vec<UpgradeOpportunity>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SharedPackage {
    pub name: String,
    pub versions_used: Vec<String>,
    pub project_count: usize,
    pub recommendation: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VersionDrift {
    pub package: String,
    pub min_version: String,
    pub max_version: String,
    pub drift_major: bool,
    pub projects: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpgradeOpportunity {
    pub package: String,
    pub current_versions: Vec<String>,
    pub latest_version: String,
    pub projects_affected: usize,
    pub update_type: String,
}

/// Scan multiple project directories and build cross-project intelligence.
pub fn scan_projects(roots: &[PathBuf]) -> CrossProjectReport {
    let mut scans = Vec::new();

    for root in roots {
        if let Some(scan) = scan_project(root) {
            scans.push(scan);
        }
    }

    let projects_scanned = scans.len();

    // Aggregate package versions across projects
    let mut package_versions: HashMap<String, Vec<(String, String)>> = HashMap::new(); // name → [(version, project)]

    for scan in &scans {
        for pkg in &scan.packages {
            package_versions
                .entry(pkg.name.clone())
                .or_default()
                .push((pkg.version.clone(), scan.root.to_string_lossy().to_string()));
        }
    }

    let total_packages = package_versions.len();

    // Find shared packages (in 2+ projects)
    let mut shared_packages = Vec::new();
    let mut version_drift = Vec::new();

    for (name, versions_and_projects) in &package_versions {
        if versions_and_projects.len() < 2 { continue; }

        let unique_versions: Vec<String> = {
            let mut v: Vec<_> = versions_and_projects.iter().map(|(ver, _)| ver.clone()).collect();
            v.sort();
            v.dedup();
            v
        };

        let project_count = versions_and_projects.len();
        let rec = if unique_versions.len() == 1 {
            "Consistent across all projects".to_string()
        } else {
            format!("Standardize to {}", unique_versions.last().unwrap_or(&"unknown".to_string()))
        };

        shared_packages.push(SharedPackage {
            name: name.clone(),
            versions_used: unique_versions.clone(),
            project_count,
            recommendation: rec,
        });

        if unique_versions.len() > 1 {
            let min_ver = unique_versions.first().unwrap_or(&String::new()).clone();
            let max_ver = unique_versions.last().unwrap_or(&String::new()).clone();
            let min_major = min_ver.split('.').next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            let max_major = max_ver.split('.').next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);

            let projects: Vec<String> = versions_and_projects.iter()
                .map(|(_, p)| p.clone())
                .collect();

            version_drift.push(VersionDrift {
                package: name.clone(),
                min_version: min_ver,
                max_version: max_ver,
                drift_major: max_major > min_major,
                projects,
            });
        }
    }

    // Sort by impact
    shared_packages.sort_by(|a, b| b.project_count.cmp(&a.project_count));
    version_drift.sort_by(|a, b| b.drift_major.cmp(&a.drift_major));

    CrossProjectReport {
        projects_scanned,
        total_packages,
        shared_packages: shared_packages.into_iter().take(50).collect(),
        version_drift: version_drift.into_iter().take(20).collect(),
        upgrade_opportunities: vec![], // Would require registry calls
    }
}

fn scan_project(root: &PathBuf) -> Option<ProjectScan> {
    // Try npm
    let pkg_lock = root.join("package-lock.json");
    if pkg_lock.exists() {
        if let Ok(content) = std::fs::read_to_string(&pkg_lock) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let mut packages = Vec::new();
                if let Some(pkgs) = v["packages"].as_object() {
                    for (key, val) in pkgs {
                        if key.is_empty() { continue; }
                        let name = key.trim_start_matches("node_modules/").to_string();
                        let version = val["version"].as_str().unwrap_or("").to_string();
                        if !name.is_empty() && !version.is_empty() {
                            packages.push(PackageSummary { name, version, is_direct: false });
                        }
                    }
                }
                return Some(ProjectScan { root: root.clone(), packages, ecosystem: "npm".to_string() });
            }
        }
    }

    // Try Python
    if root.join("pyproject.toml").exists() || root.join("requirements.txt").exists() {
        return Some(ProjectScan { root: root.clone(), packages: vec![], ecosystem: "python".to_string() });
    }

    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_empty_roots_returns_zero_projects() {
        let report = scan_projects(&[]);
        assert_eq!(report.projects_scanned, 0);
        assert!(report.shared_packages.is_empty());
    }

    #[test]
    fn scan_dir_without_project_files_returns_zero() {
        let tmp = std::env::temp_dir().join("cross-project-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        let report = scan_projects(&[tmp.clone()]);
        assert_eq!(report.projects_scanned, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn scan_npm_project_with_lockfile_is_detected() {
        let tmp = std::env::temp_dir().join("cross-project-test-npm");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), r#"{"name":"app","dependencies":{}}"#).unwrap();
        std::fs::write(tmp.join("package-lock.json"), r#"{"lockfileVersion":3,"packages":{}}"#).unwrap();
        let report = scan_projects(&[tmp.clone()]);
        assert_eq!(report.projects_scanned, 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
