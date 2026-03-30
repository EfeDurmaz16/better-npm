// crates/better-core/src/ai/review.rs
// AI-powered dependency review — suggest consolidations, lighter alternatives, removals

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct DependencyReview {
    pub project: String,
    pub total_deps: usize,
    pub suggestions: Vec<ReviewSuggestion>,
    pub overall_health: OverallHealth,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewSuggestion {
    pub category: SuggestionCategory,
    pub severity: SuggestionSeverity,
    pub title: String,
    pub description: String,
    pub packages: Vec<String>,
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
pub enum SuggestionCategory {
    Consolidate,
    Downsize,
    Remove,
    Upgrade,
    Security,
    License,
}

#[derive(Debug, Clone, Serialize)]
pub enum SuggestionSeverity { High, Medium, Low }

#[derive(Debug, Clone, Serialize)]
pub struct OverallHealth {
    pub score: u8,
    pub dep_count_rating: String,
    pub freshness_rating: String,
    pub security_rating: String,
}

/// Well-known consolidations: if both A and B are present, suggest using just one.
const KNOWN_CONSOLIDATIONS: &[(&str, &[&str], &str)] = &[
    ("moment", &["date-fns", "dayjs", "luxon"], "date-fns or dayjs (lighter alternatives)"),
    ("lodash", &["underscore", "ramda"], "lodash already covers this; remove underscore/ramda"),
    ("axios", &["node-fetch", "got", "superagent"], "pick one HTTP client"),
    ("jest", &["mocha", "jasmine", "vitest"], "pick one test framework"),
    ("webpack", &["rollup", "vite", "parcel"], "pick one bundler"),
    ("eslint", &["tslint"], "tslint is deprecated; eslint covers TS via plugins"),
];

/// Lighter alternatives for heavy packages.
const LIGHTER_ALTERNATIVES: &[(&str, &str, &str)] = &[
    ("moment", "dayjs", "dayjs is 2KB vs moment's 67KB"),
    ("lodash", "lodash-es", "lodash-es is tree-shakeable"),
    ("uuid", "nanoid", "nanoid is smaller and faster for IDs"),
    ("bluebird", "", "use native Promises in modern Node.js"),
    ("express", "fastify", "fastify is 2x faster with similar API"),
    ("request", "got", "request is deprecated; use got or node-fetch"),
];

pub fn review_dependencies(project_root: &Path) -> Result<DependencyReview, String> {
    // Load package.json
    let pkg_path = project_root.join("package.json");
    let pkg_json = std::fs::read_to_string(&pkg_path)
        .map_err(|e| format!("Cannot read package.json: {}", e))?;
    let pkg: serde_json::Value = serde_json::from_str(&pkg_json)
        .map_err(|e| format!("Cannot parse package.json: {}", e))?;

    let mut all_deps: Vec<String> = vec![];
    for key in &["dependencies", "devDependencies", "peerDependencies"] {
        if let Some(obj) = pkg.get(key).and_then(|v| v.as_object()) {
            all_deps.extend(obj.keys().cloned());
        }
    }
    let total_deps = all_deps.len();

    let mut suggestions = vec![];

    // Check consolidations
    for (primary, alternatives, advice) in KNOWN_CONSOLIDATIONS {
        let has_primary = all_deps.iter().any(|d| d == primary);
        let has_alts: Vec<&str> = alternatives.iter().filter(|&&a| all_deps.iter().any(|d| d == a)).copied().collect();
        if has_primary && !has_alts.is_empty() {
            suggestions.push(ReviewSuggestion {
                category: SuggestionCategory::Consolidate,
                severity: SuggestionSeverity::Medium,
                title: format!("Consolidate: {} + {}", primary, has_alts.join(", ")),
                description: advice.to_string(),
                packages: std::iter::once(*primary).chain(has_alts.iter().copied()).map(|s| s.to_string()).collect(),
                action: format!("better why {}", primary),
            });
        }
    }

    // Check lighter alternatives
    for (heavy, lighter, reason) in LIGHTER_ALTERNATIVES {
        if all_deps.iter().any(|d| d == heavy) && !lighter.is_empty() {
            suggestions.push(ReviewSuggestion {
                category: SuggestionCategory::Downsize,
                severity: SuggestionSeverity::Low,
                title: format!("Consider {} instead of {}", lighter, heavy),
                description: reason.to_string(),
                packages: vec![heavy.to_string()],
                action: format!("npm install {} && npm uninstall {}", lighter, heavy),
            });
        }
    }

    // Check deprecated packages
    let deprecated = &["request", "node-uuid", "tslint", "cz-conventional-changelog",
                        "bower", "grunt-cli", "jade", "stylus"];
    for pkg_name in deprecated {
        if all_deps.iter().any(|d| d == pkg_name) {
            suggestions.push(ReviewSuggestion {
                category: SuggestionCategory::Remove,
                severity: SuggestionSeverity::High,
                title: format!("{} is deprecated", pkg_name),
                description: format!("{} has been deprecated. Find a modern replacement.", pkg_name),
                packages: vec![pkg_name.to_string()],
                action: format!("better why {}", pkg_name),
            });
        }
    }

    let score: u8 = std::cmp::max(0, 100i32 - suggestions.len() as i32 * 10) as u8;
    let dep_count_rating = if total_deps < 10 { "lean" } else if total_deps < 30 { "moderate" } else { "heavy" };
    let security_rating = if suggestions.iter().any(|s| matches!(s.category, SuggestionCategory::Security)) {
        "issues found"
    } else { "clean" };

    Ok(DependencyReview {
        project: project_root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        total_deps,
        suggestions,
        overall_health: OverallHealth {
            score,
            dep_count_rating: dep_count_rating.to_string(),
            freshness_rating: "needs check".to_string(),
            security_rating: security_rating.to_string(),
        },
    })
}
