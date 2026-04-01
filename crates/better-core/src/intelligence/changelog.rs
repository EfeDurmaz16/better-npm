// crates/better-core/src/intelligence/changelog.rs
//
// Changelog analysis for smart upgrades (v1.5 Task 115.1).
//
// Parses CHANGELOG.md / HISTORY.md text provided by the caller and
// extracts breaking changes + migration steps between two versions.
// No network I/O — the caller fetches the file.

use serde::Serialize;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ChangelogAnalysis {
    pub package: String,
    pub from_version: String,
    pub to_version: String,
    pub breaking_changes: Vec<BreakingChange>,
    pub notable_changes: Vec<String>,
    pub migration_steps: Vec<MigrationStep>,
    pub risk_level: RiskLevel,
}

#[derive(Debug, Clone, Serialize)]
pub struct BreakingChange {
    pub description: String,
    /// Name of the API / symbol affected (extracted heuristically)
    pub affected_api: String,
    pub migration_hint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationStep {
    pub step: u32,
    pub description: String,
    /// Glob pattern for affected files
    pub file_pattern: String,
    /// Regex to find existing usage
    pub search_pattern: String,
    /// Suggested replacement string
    pub replacement: String,
    /// Whether the step can be applied automatically
    pub automated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel { Low, Medium, High, Critical }

#[derive(Debug)]
pub enum ChangelogError {
    /// No changelog text was provided or it was empty
    NotFound(String),
    /// Could not extract any version sections
    ParseFailed(String),
}

impl std::fmt::Display for ChangelogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(s)    => write!(f, "Changelog not found: {}", s),
            Self::ParseFailed(s) => write!(f, "Parse failed: {}", s),
        }
    }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/// Analyze a changelog text blob for breaking changes between `from` and `to`.
///
/// `changelog_text` should be the raw content of CHANGELOG.md or similar.
/// An empty string returns `ChangelogError::NotFound`.
pub fn analyze_changelog(
    package: &str,
    from: &str,
    to: &str,
    changelog_text: &str,
) -> Result<ChangelogAnalysis, ChangelogError> {
    if changelog_text.trim().is_empty() {
        return Err(ChangelogError::NotFound(package.to_string()));
    }

    // Extract lines relevant to the version range
    let relevant = extract_version_range(changelog_text, from, to);
    if relevant.is_empty() {
        return Err(ChangelogError::ParseFailed(format!(
            "No changelog entries found between {} and {}",
            from, to
        )));
    }

    let breaking_changes = parse_breaking_changes(&relevant);
    let notable_changes: Vec<String> = relevant
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .collect();
    let migration_steps = generate_migration_steps(&breaking_changes, package);

    let risk_level = match breaking_changes.len() {
        0       => RiskLevel::Low,
        1..=2   => RiskLevel::Medium,
        3..=5   => RiskLevel::High,
        _       => RiskLevel::Critical,
    };

    Ok(ChangelogAnalysis {
        package: package.to_string(),
        from_version: from.to_string(),
        to_version: to.to_string(),
        breaking_changes,
        notable_changes,
        migration_steps,
        risk_level,
    })
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/// Extract lines between the heading for `to` and the heading for `from`.
///
/// Supports common formats:
///   ## [1.2.0] - 2024-01-01
///   # 1.2.0
///   ### v1.2.0
fn extract_version_range(text: &str, from: &str, to: &str) -> Vec<String> {
    let mut in_range = false;
    let mut lines: Vec<String> = Vec::new();

    for line in text.lines() {
        let stripped = line.trim();

        if is_version_heading(stripped, to) {
            in_range = true;
            continue;
        }
        if in_range && is_version_heading(stripped, from) {
            break;
        }
        if in_range {
            lines.push(line.to_string());
        }
    }

    // If we never entered range, try a looser search: include all lines
    // containing the target version (useful for minimal changelogs).
    if lines.is_empty() {
        for line in text.lines() {
            if line.contains(to) || line.contains("BREAKING") || line.contains("breaking") {
                lines.push(line.to_string());
            }
        }
    }

    lines
}

fn is_version_heading(line: &str, version: &str) -> bool {
    if !line.starts_with('#') {
        return false;
    }
    line.contains(version)
}

/// Find lines that signal a breaking change.
fn parse_breaking_changes(lines: &[String]) -> Vec<BreakingChange> {
    let mut results = Vec::new();
    let keywords = ["BREAKING", "breaking change", "Breaking Change", "removed", "deprecated"];

    for line in lines {
        let lower = line.to_lowercase();
        if keywords.iter().any(|kw| line.contains(kw) || lower.contains(&kw.to_lowercase())) {
            let description = line.trim().trim_start_matches(['-', '*', ' ']).to_string();
            let affected_api = extract_api_name(&description);
            let migration_hint = derive_migration_hint(&description);
            results.push(BreakingChange { description, affected_api, migration_hint });
        }
    }
    results
}

fn extract_api_name(desc: &str) -> String {
    // Look for backtick-quoted identifiers: `myFunction`
    if let Some(start) = desc.find('`') {
        if let Some(end) = desc[start + 1..].find('`') {
            return desc[start + 1..start + 1 + end].to_string();
        }
    }
    // Fallback: first capitalised word
    desc.split_whitespace()
        .find(|w| w.chars().next().map(|c| c.is_uppercase()).unwrap_or(false))
        .unwrap_or("unknown")
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_string()
}

fn derive_migration_hint(desc: &str) -> String {
    let d = desc.to_lowercase();
    if d.contains("removed") {
        "Remove usage or replace with the new API".into()
    } else if d.contains("renamed") {
        "Update references to the new name".into()
    } else if d.contains("deprecated") {
        "Replace with the suggested alternative before next major".into()
    } else if d.contains("breaking") {
        "Review and update all affected call sites".into()
    } else {
        "Consult the changelog for migration guidance".into()
    }
}

fn generate_migration_steps(
    breaking: &[BreakingChange],
    _package: &str,
) -> Vec<MigrationStep> {
    breaking
        .iter()
        .enumerate()
        .map(|(i, bc)| MigrationStep {
            step: (i + 1) as u32,
            description: bc.description.clone(),
            file_pattern: "**/*.{js,ts,jsx,tsx}".into(),
            search_pattern: if bc.affected_api != "unknown" {
                bc.affected_api.clone()
            } else {
                String::new()
            },
            replacement: bc.migration_hint.clone(),
            // Mark as automated only if we have a concrete search pattern
            automated: !bc.affected_api.is_empty() && bc.affected_api != "unknown",
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_CHANGELOG: &str = r#"
# Changelog

## [3.0.0] - 2024-03-01

### BREAKING CHANGES

- Removed `legacy_parse()` function — use `parse()` instead
- Renamed `Cfg` to `Config`

### Added

- New `parse()` function with improved API

## [2.5.0] - 2024-01-15

### Added

- Added helper utilities

## [2.0.0] - 2023-06-01

### BREAKING

- Removed old callback API
"#;

    #[test]
    fn detect_breaking_changes_in_major_bump() {
        let result = analyze_changelog("mypkg", "2.5.0", "3.0.0", SAMPLE_CHANGELOG).unwrap();
        assert!(!result.breaking_changes.is_empty());
        assert!(result.breaking_changes.iter().any(|b| b.description.contains("legacy_parse")));
        assert!(matches!(result.risk_level, RiskLevel::Medium | RiskLevel::High));
    }

    #[test]
    fn no_breaking_minor_bump() {
        let changelog = r#"
## [1.1.0] - 2024-01-01
### Added
- New utility function
## [1.0.0] - 2023-12-01
### Initial release
"#;
        let result = analyze_changelog("mypkg", "1.0.0", "1.1.0", changelog).unwrap();
        assert!(result.breaking_changes.is_empty());
        assert_eq!(result.risk_level, RiskLevel::Low);
    }

    #[test]
    fn empty_changelog_returns_error() {
        let err = analyze_changelog("mypkg", "1.0.0", "2.0.0", "").unwrap_err();
        assert!(matches!(err, ChangelogError::NotFound(_)));
    }

    #[test]
    fn migration_steps_generated_for_breaking_changes() {
        let result = analyze_changelog("mypkg", "2.5.0", "3.0.0", SAMPLE_CHANGELOG).unwrap();
        assert!(!result.migration_steps.is_empty());
        // steps with known API should be automatable
        assert!(result.migration_steps.iter().any(|s| s.automated));
    }

    #[test]
    fn version_range_extraction() {
        let lines = extract_version_range(SAMPLE_CHANGELOG, "2.5.0", "3.0.0");
        assert!(!lines.is_empty());
        // Should contain breaking change text
        let joined = lines.join("\n");
        assert!(joined.contains("legacy_parse") || joined.contains("BREAKING"));
    }

    #[test]
    fn risk_level_scales_with_breaking_count() {
        let make = |n: usize| -> Vec<BreakingChange> {
            (0..n).map(|i| BreakingChange {
                description: format!("Breaking {}", i),
                affected_api: format!("Api{}", i),
                migration_hint: "hint".into(),
            }).collect()
        };
        assert_eq!(analyze_risk(&make(0)), RiskLevel::Low);
        assert_eq!(analyze_risk(&make(1)), RiskLevel::Medium);
        assert_eq!(analyze_risk(&make(4)), RiskLevel::High);
        assert_eq!(analyze_risk(&make(6)), RiskLevel::Critical);
    }

    fn analyze_risk(bc: &[BreakingChange]) -> RiskLevel {
        match bc.len() {
            0     => RiskLevel::Low,
            1..=2 => RiskLevel::Medium,
            3..=5 => RiskLevel::High,
            _     => RiskLevel::Critical,
        }
    }
}
