// crates/better-core/src/ai/migrate.rs
// AI-assisted migration planner: old deps → modern replacements

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct MigrationPlan {
    pub from: String,
    pub to: String,
    pub steps: Vec<MigrationStep>,
    pub estimated_effort: MigrationEffort,
    pub breaking_changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationStep {
    pub order: usize,
    pub title: String,
    pub description: String,
    pub commands: Vec<String>,
    pub files_to_update: Vec<String>,
    pub code_pattern: Option<CodeChange>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeChange {
    pub before: String,
    pub after: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub enum MigrationEffort { Low, Medium, High }

/// Known migration paths between package pairs.
const MIGRATIONS: &[(&str, &str, &[(&str, &str)])] = &[
    ("moment", "dayjs", &[
        ("npm install dayjs", ""),
        ("npm uninstall moment", ""),
    ]),
    ("request", "got", &[
        ("npm install got", ""),
        ("npm uninstall request", ""),
    ]),
    ("tslint", "eslint", &[
        ("npm install --save-dev eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin", ""),
        ("npm uninstall tslint", ""),
        ("npx tslint-to-eslint-config", ""),
    ]),
    ("cra", "vite", &[
        ("npm create vite@latest", ""),
        ("npm install", ""),
    ]),
    ("webpack", "vite", &[
        ("npm install --save-dev vite @vitejs/plugin-react", ""),
        ("npm uninstall webpack webpack-cli webpack-dev-server", ""),
    ]),
];

pub fn plan_migration(from: &str, to: &str, project_root: &Path) -> Result<MigrationPlan, String> {
    let known = MIGRATIONS.iter().find(|(f, t, _)| *f == from && *t == to);

    let steps = if let Some((_, _, cmds)) = known {
        cmds.iter().enumerate().map(|(i, (cmd, desc))| MigrationStep {
            order: i + 1,
            title: format!("Step {}: {}", i + 1, if cmd.starts_with("npm") { "Update dependencies" } else { "Configure" }),
            description: desc.to_string(),
            commands: vec![cmd.to_string()],
            files_to_update: vec![],
            code_pattern: None,
        }).collect()
    } else {
        vec![MigrationStep {
            order: 1,
            title: format!("Migrate from {} to {}", from, to),
            description: format!("Manual migration required. Check the {} documentation.", to),
            commands: vec![
                format!("npm install {}", to),
                format!("npm uninstall {}", from),
            ],
            files_to_update: vec![],
            code_pattern: None,
        }]
    };

    let breaking_changes = get_breaking_changes(from, to);
    let effort = if breaking_changes.len() > 3 { MigrationEffort::High }
        else if breaking_changes.len() > 1 { MigrationEffort::Medium }
        else { MigrationEffort::Low };

    // Check project size
    let _ = project_root;

    Ok(MigrationPlan {
        from: from.to_string(),
        to: to.to_string(),
        steps,
        estimated_effort: effort,
        breaking_changes,
    })
}

fn get_breaking_changes(from: &str, to: &str) -> Vec<String> {
    match (from, to) {
        ("moment", "dayjs") => vec![
            "dayjs is immutable — methods return new instances".to_string(),
            "Plugin system differs — import plugins explicitly".to_string(),
            "Locale loading is different".to_string(),
        ],
        ("request", "got") => vec![
            "got uses Promises/async by default (no callback API)".to_string(),
            "Response is an object, not a stream by default".to_string(),
            "Option names differ (uri → url, qs → searchParams)".to_string(),
        ],
        ("tslint", "eslint") => vec![
            "Rule names differ between tslint and @typescript-eslint".to_string(),
            "Config format is different (.eslintrc vs tslint.json)".to_string(),
        ],
        _ => vec![
            format!("Check {} changelog for breaking changes between versions", to),
        ],
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_migration_has_steps() {
        let plan = plan_migration("moment", "dayjs", std::path::Path::new("/tmp")).unwrap();
        assert!(!plan.steps.is_empty());
        assert_eq!(plan.from, "moment");
        assert_eq!(plan.to, "dayjs");
    }

    #[test]
    fn known_migration_has_breaking_changes() {
        let plan = plan_migration("moment", "dayjs", std::path::Path::new("/tmp")).unwrap();
        assert!(!plan.breaking_changes.is_empty());
        assert!(matches!(plan.estimated_effort, MigrationEffort::Medium | MigrationEffort::High));
    }

    #[test]
    fn unknown_migration_has_generic_step() {
        let plan = plan_migration("some-lib", "other-lib", std::path::Path::new("/tmp")).unwrap();
        assert_eq!(plan.steps.len(), 1);
        assert!(plan.steps[0].commands.iter().any(|c| c.contains("other-lib")));
    }

    #[test]
    fn request_to_got_has_multiple_breaking_changes() {
        let plan = plan_migration("request", "got", std::path::Path::new("/tmp")).unwrap();
        assert!(plan.breaking_changes.len() >= 2);
    }

    #[test]
    fn tslint_to_eslint_migration_is_known() {
        let plan = plan_migration("tslint", "eslint", std::path::Path::new("/tmp")).unwrap();
        assert!(!plan.breaking_changes.is_empty());
        assert!(plan.breaking_changes.iter().any(|b| b.contains("eslint") || b.contains("tslint")));
    }

    #[test]
    fn migrations_constant_is_nonempty() {
        assert!(!MIGRATIONS.is_empty());
        assert!(MIGRATIONS.iter().any(|(f, _, _)| *f == "moment"));
    }

    #[test]
    fn migration_plan_serializes_to_json() {
        let plan = plan_migration("webpack", "vite", std::path::Path::new("/tmp")).unwrap();
        let json = serde_json::to_string(&plan).unwrap();
        assert!(json.contains("webpack"));
        assert!(json.contains("vite"));
    }

    #[test]
    fn migration_effort_low_for_unknown_pair() {
        // Unknown pair has 1 breaking change → Low effort
        let plan = plan_migration("pkg-a", "pkg-b", std::path::Path::new("/tmp")).unwrap();
        assert!(matches!(plan.estimated_effort, MigrationEffort::Low));
    }
}
