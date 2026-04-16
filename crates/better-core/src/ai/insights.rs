// crates/better-core/src/ai/insights.rs
// Cross-Project Intelligence — org-level dependency analysis

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct OrgInsights {
    pub projects_analyzed: usize,
    pub total_unique_deps: usize,
    pub total_dep_instances: usize,
    pub version_inconsistencies: Vec<VersionInconsistency>,
    pub consolidation_opportunities: Vec<ConsolidationOpportunity>,
    pub standardization_score: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionInconsistency {
    pub package: String,
    pub versions: HashMap<String, Vec<String>>,  // version -> [project names]
    pub recommended: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConsolidationOpportunity {
    pub category: String,
    pub packages: Vec<String>,
    pub projects: Vec<String>,
    pub recommended: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
struct ProjectDeps {
    name: String,
    path: PathBuf,
    deps: HashMap<String, String>,  // name -> version
}

// Known consolidation patterns
const CONSOLIDATIONS: &[(&str, &[&str], &str)] = &[
    ("http-client", &["axios", "node-fetch", "got", "superagent", "ky"], "Pick one HTTP client org-wide"),
    ("date-library", &["moment", "date-fns", "dayjs", "luxon"], "Use date-fns or dayjs everywhere"),
    ("test-framework", &["jest", "mocha", "vitest", "jasmine"], "Standardize on one test framework"),
    ("bundler", &["webpack", "vite", "rollup", "parcel", "esbuild"], "Standardize on one bundler"),
    ("logger", &["winston", "pino", "bunyan", "log4js"], "Standardize on one logger"),
    ("orm", &["sequelize", "typeorm", "prisma", "drizzle-orm", "mongoose"], "Standardize on one ORM"),
];

/// Analyze dependencies across all projects in a directory.
pub fn analyze_org(root_dir: &Path) -> Result<OrgInsights, String> {
    let projects = discover_projects(root_dir)?;
    if projects.is_empty() {
        return Ok(OrgInsights {
            projects_analyzed: 0,
            total_unique_deps: 0,
            total_dep_instances: 0,
            version_inconsistencies: vec![],
            consolidation_opportunities: vec![],
            standardization_score: 100,
        });
    }

    let mut all_deps: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
    let mut total_instances = 0;

    for project in &projects {
        for (dep, version) in &project.deps {
            total_instances += 1;
            all_deps
                .entry(dep.clone())
                .or_default()
                .entry(version.clone())
                .or_default()
                .push(project.name.clone());
        }
    }

    // Find version inconsistencies (same package, different versions across projects)
    let mut inconsistencies = vec![];
    for (pkg, versions) in &all_deps {
        if versions.len() > 1 {
            // Find the most common version as recommendation
            let recommended = versions.iter()
                .max_by_key(|(_, projects)| projects.len())
                .map(|(v, _)| v.clone())
                .unwrap_or_default();

            inconsistencies.push(VersionInconsistency {
                package: pkg.clone(),
                versions: versions.clone(),
                recommended,
            });
        }
    }
    inconsistencies.sort_by(|a, b| b.versions.len().cmp(&a.versions.len()));

    // Find consolidation opportunities
    let mut consolidations = vec![];
    for (category, packages, reason) in CONSOLIDATIONS {
        let found: Vec<(&str, Vec<String>)> = packages.iter()
            .filter_map(|&pkg| {
                all_deps.get(pkg).map(|versions| {
                    let projects: Vec<String> = versions.values().flatten().cloned().collect();
                    (pkg, projects)
                })
            })
            .collect();

        if found.len() > 1 {
            let all_projects: Vec<String> = found.iter()
                .flat_map(|(_, ps)| ps.iter().cloned())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
            let pkg_names: Vec<String> = found.iter().map(|(p, _)| p.to_string()).collect();

            consolidations.push(ConsolidationOpportunity {
                category: category.to_string(),
                packages: pkg_names,
                projects: all_projects,
                recommended: found.iter().max_by_key(|(_, ps)| ps.len())
                    .map(|(p, _)| p.to_string())
                    .unwrap_or_default(),
                reason: reason.to_string(),
            });
        }
    }

    // Standardization score: penalize per inconsistency and per consolidation opportunity
    let score = (100i32
        - inconsistencies.len() as i32 * 5
        - consolidations.len() as i32 * 10)
        .max(0) as u8;

    Ok(OrgInsights {
        projects_analyzed: projects.len(),
        total_unique_deps: all_deps.len(),
        total_dep_instances: total_instances,
        version_inconsistencies: inconsistencies,
        consolidation_opportunities: consolidations,
        standardization_score: score,
    })
}

fn discover_projects(root: &Path) -> Result<Vec<ProjectDeps>, String> {
    let mut projects = vec![];

    let entries = std::fs::read_dir(root)
        .map_err(|e| format!("Cannot read directory: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" { continue; }

        let pkg_path = path.join("package.json");
        if pkg_path.exists() {
            if let Some(deps) = read_npm_deps(&pkg_path) {
                projects.push(ProjectDeps { name, path, deps });
            }
        }
    }

    Ok(projects)
}

fn read_npm_deps(pkg_path: &Path) -> Option<HashMap<String, String>> {
    let content = std::fs::read_to_string(pkg_path).ok()?;
    let pkg: serde_json::Value = serde_json::from_str(&content).ok()?;
    let mut deps = HashMap::new();
    for key in &["dependencies", "devDependencies"] {
        if let Some(obj) = pkg.get(key).and_then(|v| v.as_object()) {
            for (k, v) in obj {
                if let Some(ver) = v.as_str() {
                    deps.insert(k.clone(), ver.to_string());
                }
            }
        }
    }
    Some(deps)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_pkg(dir: &std::path::Path, content: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let mut f = std::fs::File::create(dir.join("package.json")).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn empty_dir_returns_zero_projects() {
        let tmp = std::env::temp_dir().join("insights-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        let insights = analyze_org(&tmp).unwrap();
        assert_eq!(insights.projects_analyzed, 0);
        assert_eq!(insights.standardization_score, 100);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn single_project_no_inconsistencies() {
        let tmp = std::env::temp_dir().join("insights-test-single");
        write_pkg(&tmp, r#"{"name":"app","version":"1.0.0","dependencies":{"lodash":"^4.17.21"}}"#);
        let insights = analyze_org(&tmp).unwrap();
        // Single project → no inconsistencies by definition
        assert!(insights.version_inconsistencies.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn version_inconsistency_detected_across_projects() {
        let tmp = std::env::temp_dir().join("insights-test-inconsistent");
        write_pkg(&tmp.join("app-a"), r#"{"name":"app-a","version":"1.0.0","dependencies":{"lodash":"4.17.20"}}"#);
        write_pkg(&tmp.join("app-b"), r#"{"name":"app-b","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}"#);
        let insights = analyze_org(&tmp).unwrap();
        assert!(!insights.version_inconsistencies.is_empty());
        assert!(insights.version_inconsistencies.iter().any(|i| i.package == "lodash"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn consolidation_opportunity_detected() {
        let tmp = std::env::temp_dir().join("insights-test-consolidate");
        write_pkg(&tmp.join("app-a"), r#"{"name":"app-a","version":"1.0.0","dependencies":{"moment":"^2.0.0"}}"#);
        write_pkg(&tmp.join("app-b"), r#"{"name":"app-b","version":"1.0.0","dependencies":{"dayjs":"^1.0.0"}}"#);
        let insights = analyze_org(&tmp).unwrap();
        assert!(!insights.consolidation_opportunities.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn consolidations_constant_is_nonempty() {
        assert!(!CONSOLIDATIONS.is_empty());
        assert!(CONSOLIDATIONS.iter().any(|(cat, _, _)| *cat == "http-client"));
    }

    #[test]
    fn analyze_org_same_version_no_inconsistencies() {
        let tmp = std::env::temp_dir().join("insights-test-same-ver");
        // Two projects, same dep, same version → no inconsistency
        write_pkg(&tmp.join("p1"), r#"{"name":"p1","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}"#);
        write_pkg(&tmp.join("p2"), r#"{"name":"p2","version":"1.0.0","dependencies":{"lodash":"4.17.21"}}"#);
        let insights = analyze_org(&tmp).unwrap();
        assert!(insights.version_inconsistencies.is_empty());
        assert_eq!(insights.projects_analyzed, 2);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn standardization_score_decreases_with_inconsistencies() {
        let tmp = std::env::temp_dir().join("insights-test-score");
        // 3 projects with lodash version differences → score < 100
        write_pkg(&tmp.join("pa"), r#"{"name":"pa","dependencies":{"lodash":"4.17.20"}}"#);
        write_pkg(&tmp.join("pb"), r#"{"name":"pb","dependencies":{"lodash":"4.17.21"}}"#);
        write_pkg(&tmp.join("pc"), r#"{"name":"pc","dependencies":{"lodash":"4.16.0"}}"#);
        let insights = analyze_org(&tmp).unwrap();
        assert!(insights.standardization_score < 100);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn analyze_org_counts_total_instances() {
        let tmp = std::env::temp_dir().join("insights-test-instances");
        write_pkg(&tmp.join("q1"), r#"{"name":"q1","dependencies":{"a":"1.0","b":"2.0"}}"#);
        write_pkg(&tmp.join("q2"), r#"{"name":"q2","dependencies":{"a":"1.0","c":"3.0"}}"#);
        let insights = analyze_org(&tmp).unwrap();
        // q1 has 2 deps, q2 has 2 deps → 4 total instances
        assert_eq!(insights.total_dep_instances, 4);
        // Unique: a, b, c → 3
        assert_eq!(insights.total_unique_deps, 3);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
