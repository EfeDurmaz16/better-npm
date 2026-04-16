// crates/better-core/src/intelligence/impact.rs
//
// Dependency impact analysis (v1.5 Task 116).
//
// `better impact <pkg>` answers:
//   - How many source files import this package?
//   - Which exports are used?
//   - What transitive packages would be removed?
//   - What is the removal risk?
//   - What are the best alternatives?

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/// Full impact analysis for one package.
#[derive(Debug, Clone, Serialize)]
pub struct ImpactAnalysis {
    pub package: String,
    pub version: String,
    pub usage: UsageAnalysis,
    pub removal_impact: RemovalImpact,
    pub alternatives: Vec<AlternativePackage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageAnalysis {
    /// Number of project source files that directly import this package
    pub direct_imports: usize,
    /// Number of packages in the dependency graph that depend on this package
    pub transitive_dependents: usize,
    /// Source file paths containing imports
    pub import_files: Vec<String>,
    /// Export names used from this package (e.g. "get", "set" for lodash)
    pub imported_exports: Vec<String>,
    /// How deep in the dependency graph (0 = direct dep)
    pub depth_in_graph: u32,
    /// Dependency names that depend on this package
    pub dependents: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemovalImpact {
    pub files_affected: usize,
    pub imports_to_replace: usize,
    pub transitive_packages_removed: usize,
    pub size_reduction_bytes: u64,
    pub risk: ImpactRisk,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImpactRisk {
    /// Used in 0 source files, safe to remove
    Safe,
    /// Used in a few files with replaceable API
    Moderate,
    /// Heavily used, replacement requires significant work
    High,
    /// Core to the project, removal would break many things
    Critical,
}

#[derive(Debug, Clone, Serialize)]
pub struct AlternativePackage {
    pub name: String,
    pub description: String,
    pub reputation_score: u8,
    pub weekly_downloads: u64,
    pub migration_effort: MigrationEffort,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationEffort { Trivial, Easy, Moderate, Hard }

// ---------------------------------------------------------------------------
// Analyser
// ---------------------------------------------------------------------------

/// Analyse the impact of removing `package` from the project at `project_root`.
///
/// `dependents`: map of pkg_name → list of pkg_names that depend on it
///              (from the resolved lock graph).
/// `pkg_size_bytes`: on-disk size of the package (0 if unknown).
pub fn analyze_impact(
    project_root: &Path,
    package: &str,
    version: &str,
    dependents: &[String],
    transitive_remove_count: usize,
    pkg_size_bytes: u64,
) -> ImpactAnalysis {
    let scan = scan_imports(project_root, package);

    let risk = classify_risk(scan.files.len(), dependents.len(), scan.exports_used.len());

    ImpactAnalysis {
        package: package.to_string(),
        version: version.to_string(),
        usage: UsageAnalysis {
            direct_imports: scan.files.len(),
            transitive_dependents: dependents.len(),
            import_files: scan.files.clone(),
            imported_exports: scan.exports_used.clone(),
            depth_in_graph: if dependents.is_empty() { 0 } else { 1 },
            dependents: dependents.to_vec(),
        },
        removal_impact: RemovalImpact {
            files_affected: scan.files.len(),
            imports_to_replace: scan.exports_used.len().max(1) * scan.files.len(),
            transitive_packages_removed: transitive_remove_count,
            size_reduction_bytes: pkg_size_bytes,
            risk,
        },
        alternatives: known_alternatives(package),
    }
}

// ---------------------------------------------------------------------------
// Import scanner
// ---------------------------------------------------------------------------

struct ImportScan {
    files: Vec<String>,
    exports_used: Vec<String>,
}

/// Walk source files under `project_root` and find those that reference `package`.
fn scan_imports(project_root: &Path, package: &str) -> ImportScan {
    let mut files: Vec<String> = Vec::new();
    let mut exports: HashSet<String> = HashSet::new();

    walk_source_files(project_root, &mut |path, content| {
        if content.contains(package) {
            files.push(path.to_string());
            for exp in extract_used_exports(content, package) {
                exports.insert(exp);
            }
        }
    });

    let mut exports_used: Vec<String> = exports.into_iter().collect();
    exports_used.sort();

    ImportScan { files, exports_used }
}

/// Walk all source files under `root`, calling `f(relative_path, content)`.
fn walk_source_files(root: &Path, f: &mut impl FnMut(&str, &str)) {
    walk_dir(root, root, f);
}

fn walk_dir(root: &Path, dir: &Path, f: &mut impl FnMut(&str, &str)) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

        // Skip common noise directories
        if matches!(name.as_str(), "node_modules" | "target" | ".git" | "dist" | "build" | ".better") {
            continue;
        }

        if path.is_dir() {
            walk_dir(root, &path, f);
        } else if is_source_file(&path) {
            if let Ok(content) = std::fs::read_to_string(&path) {
                let rel = path.strip_prefix(root)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| path.display().to_string());
                f(&rel, &content);
            }
        }
    }
}

fn is_source_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("js" | "ts" | "jsx" | "tsx" | "cjs" | "mjs" | "py" | "rs" | "go" | "rb" | "php")
    )
}

/// Extract export names used from `content` for `package`.
///
/// Recognises patterns:
///   import { get, set } from 'lodash'
///   const { get, debounce } = require('lodash')
fn extract_used_exports(content: &str, package: &str) -> Vec<String> {
    let mut exports = Vec::new();

    for line in content.lines() {
        // ES import: import { ... } from 'pkg'
        if line.contains("import") && line.contains(package) {
            if let Some(inner) = extract_braces(line) {
                for name in inner.split(',') {
                    let n = name.trim().split(" as ").next().unwrap_or("").trim();
                    if !n.is_empty() && is_valid_ident(n) {
                        exports.push(n.to_string());
                    }
                }
            }
        }
        // CJS destructure: const { get } = require('pkg')
        if line.contains("require") && line.contains(package) {
            if let Some(inner) = extract_braces(line) {
                for name in inner.split(',') {
                    let n = name.trim().split(':').next().unwrap_or("").trim();
                    if !n.is_empty() && is_valid_ident(n) {
                        exports.push(n.to_string());
                    }
                }
            }
        }
    }

    exports.sort();
    exports.dedup();
    exports
}

fn extract_braces(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let end = s[start..].find('}')? + start;
    Some(&s[start + 1..end])
}

fn is_valid_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
        && s.chars().next().map(|c| !c.is_ascii_digit()).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

fn classify_risk(files: usize, dependents: usize, exports: usize) -> ImpactRisk {
    let score = files + dependents * 2 + exports;
    match score {
        0 => ImpactRisk::Safe,
        1..=5 => ImpactRisk::Moderate,
        6..=20 => ImpactRisk::High,
        _ => ImpactRisk::Critical,
    }
}

// ---------------------------------------------------------------------------
// Known alternatives database (static, curated)
// ---------------------------------------------------------------------------

/// Public alias used by `predict.rs`.
pub fn known_alternatives_pub(package: &str) -> Vec<AlternativePackage> {
    known_alternatives(package)
}

fn known_alternatives(package: &str) -> Vec<AlternativePackage> {
    match package {
        "moment" => vec![
            alt("dayjs", "Fast 2kB day.js date library", 95, 15_000_000, MigrationEffort::Trivial),
            alt("date-fns", "Modern date utility library", 92, 8_000_000, MigrationEffort::Easy),
            alt("luxon", "Powerful date/time library", 88, 3_000_000, MigrationEffort::Moderate),
        ],
        "lodash" | "underscore" => vec![
            alt("es-toolkit", "Modern JS utility library, tree-shakeable", 90, 500_000, MigrationEffort::Easy),
            alt("radash", "Radical TypeScript utility library", 85, 200_000, MigrationEffort::Easy),
        ],
        "request" | "node-fetch" | "axios" => vec![
            alt("got", "Human-friendly HTTP requests", 92, 5_000_000, MigrationEffort::Moderate),
            alt("ky", "Tiny HTTP client based on Fetch", 88, 1_000_000, MigrationEffort::Moderate),
        ],
        "uuid" => vec![
            alt("nanoid", "Tiny, secure, URL-friendly UUID", 95, 20_000_000, MigrationEffort::Trivial),
        ],
        "chalk" | "colors" | "ansi-colors" => vec![
            alt("kleur", "Faster & lighter chalk alternative", 87, 2_000_000, MigrationEffort::Easy),
            alt("picocolors", "Smallest & fastest colors library", 89, 5_000_000, MigrationEffort::Easy),
        ],
        _ => vec![],
    }
}

fn alt(name: &str, desc: &str, rep: u8, dl: u64, effort: MigrationEffort) -> AlternativePackage {
    AlternativePackage {
        name: name.to_string(),
        description: desc.to_string(),
        reputation_score: rep,
        weekly_downloads: dl,
        migration_effort: effort,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_files_is_safe() {
        let analysis = analyze_impact(
            Path::new("/nonexistent"),
            "unused-pkg",
            "1.0.0",
            &[],
            0,
            0,
        );
        assert!(matches!(analysis.removal_impact.risk, ImpactRisk::Safe));
        assert_eq!(analysis.usage.direct_imports, 0);
    }

    #[test]
    fn known_alternatives_for_moment() {
        let alts = known_alternatives("moment");
        assert!(!alts.is_empty());
        assert!(alts.iter().any(|a| a.name == "dayjs"));
    }

    #[test]
    fn extract_es_imports() {
        let content = "import { get, set, debounce } from 'lodash';\n";
        let exports = extract_used_exports(content, "lodash");
        assert!(exports.contains(&"get".to_string()));
        assert!(exports.contains(&"set".to_string()));
        assert!(exports.contains(&"debounce".to_string()));
    }

    #[test]
    fn extract_cjs_destructure() {
        let content = "const { pick, omit } = require('lodash');\n";
        let exports = extract_used_exports(content, "lodash");
        assert!(exports.contains(&"pick".to_string()));
        assert!(exports.contains(&"omit".to_string()));
    }

    #[test]
    fn risk_scales_with_usage() {
        assert!(matches!(classify_risk(0, 0, 0), ImpactRisk::Safe));
        assert!(matches!(classify_risk(10, 5, 3), ImpactRisk::Critical));
    }

    #[test]
    fn is_valid_ident_alphanumeric() {
        assert!(is_valid_ident("get"));
        assert!(is_valid_ident("_private"));
        assert!(is_valid_ident("$jQuery"));
    }

    #[test]
    fn is_valid_ident_rejects_invalid() {
        assert!(!is_valid_ident(""));
        assert!(!is_valid_ident("123abc")); // starts with digit
        assert!(!is_valid_ident("hello-world")); // hyphen
    }

    #[test]
    fn extract_braces_extracts_inner() {
        let s = "import { foo, bar } from 'pkg'";
        let inner = extract_braces(s).unwrap();
        assert!(inner.contains("foo"));
        assert!(inner.contains("bar"));
    }

    #[test]
    fn extract_braces_no_braces_returns_none() {
        let s = "import something from 'pkg'";
        assert!(extract_braces(s).is_none());
    }

    #[test]
    fn classify_risk_moderate_range() {
        // 1-5 score range
        assert!(matches!(classify_risk(1, 0, 0), ImpactRisk::Moderate));
        assert!(matches!(classify_risk(0, 2, 0), ImpactRisk::Moderate)); // 2*2=4
    }

    #[test]
    fn known_alternatives_unknown_package_returns_empty() {
        let alts = known_alternatives("totally-unknown-pkg-xyz");
        assert!(alts.is_empty());
    }

    #[test]
    fn known_alternatives_for_lodash() {
        let alts = known_alternatives("lodash");
        assert!(!alts.is_empty());
        // All should have a name and description
        for alt in &alts {
            assert!(!alt.name.is_empty());
            assert!(!alt.description.is_empty());
        }
    }
}
