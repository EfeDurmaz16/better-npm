// crates/better-core/src/dedupe_fix.rs
//
// Duplicate dependency advisor (Task 27).
//
// Analyzes duplicated packages in node_modules, finds a single version that
// satisfies all requesters, and generates package.json `overrides` to fix them.

use std::collections::HashMap;

use serde::Serialize;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/// A single resolved package instance.
#[derive(Debug, Clone)]
pub struct ResolvedPkg {
    pub name: String,
    pub version: String,
    /// Packages that depend on this one and the range they requested
    pub requested_by: Vec<(String, String)>, // (requester_name, version_range)
    /// Approximate on-disk size in bytes (0 if unknown)
    pub size_bytes: u64,
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/// Analysis result for one duplicated package.
#[derive(Debug, Clone, Serialize)]
pub struct DupeAnalysis {
    pub package_name: String,
    /// All installed versions (sorted newest-first)
    pub versions: Vec<String>,
    /// All requesters with their ranges
    pub ranges_requesting: Vec<RangeInfo>,
    /// Suggested single version to consolidate on (None = manual resolution needed)
    pub suggested_version: Option<String>,
    /// True when `suggested_version` is set and can be applied automatically
    pub can_auto_fix: bool,
    /// Estimated bytes saved by deduplication
    pub savings_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RangeInfo {
    pub requested_by: String,
    pub range: String,
    pub resolved: String,
}

// ---------------------------------------------------------------------------
// Core analyser
// ---------------------------------------------------------------------------

/// Analyse a flat list of resolved packages and return one `DupeAnalysis`
/// per package that appears in more than one version.
pub fn analyze_dupes(packages: &[ResolvedPkg]) -> Vec<DupeAnalysis> {
    // Group by package name
    let mut by_name: HashMap<String, Vec<&ResolvedPkg>> = HashMap::new();
    for pkg in packages {
        by_name.entry(pkg.name.clone()).or_default().push(pkg);
    }

    let mut analyses: Vec<DupeAnalysis> = Vec::new();

    for (name, instances) in &by_name {
        if instances.len() <= 1 {
            continue;
        }

        let mut versions: Vec<String> = instances.iter().map(|p| p.version.clone()).collect();
        versions.sort_by(|a, b| compare_versions_desc(a, b));
        versions.dedup();

        let ranges_requesting: Vec<RangeInfo> = instances
            .iter()
            .flat_map(|p| {
                p.requested_by.iter().map(|(req_by, range)| RangeInfo {
                    requested_by: req_by.clone(),
                    range: range.clone(),
                    resolved: p.version.clone(),
                })
            })
            .collect();

        let suggested = find_compatible_version(&versions, &ranges_requesting);
        let can_auto_fix = suggested.is_some();

        // Savings: all instances minus 1 × average size
        let total_size: u64 = instances.iter().map(|p| p.size_bytes).sum();
        let avg_size = if !instances.is_empty() {
            total_size / instances.len() as u64
        } else {
            0
        };
        let savings_bytes = avg_size * (instances.len() as u64).saturating_sub(1);

        analyses.push(DupeAnalysis {
            package_name: name.clone(),
            versions,
            ranges_requesting,
            suggested_version: suggested,
            can_auto_fix,
            savings_bytes,
        });
    }

    // Sort by number of duplicates descending
    analyses.sort_by(|a, b| b.versions.len().cmp(&a.versions.len()));
    analyses
}

// ---------------------------------------------------------------------------
// Version compatibility
// ---------------------------------------------------------------------------

/// Find the highest version from `versions` that satisfies all `ranges`.
///
/// We implement a lightweight subset of semver range matching:
/// - `^X.Y.Z` — compatible minor/patch, same major
/// - `~X.Y.Z` — compatible patch, same major+minor
/// - `>=X.Y.Z` — at least this version
/// - `>X.Y.Z`  — strictly greater
/// - `X.Y.Z`   — exact
/// - `*` / `""` — any
fn find_compatible_version(versions: &[String], ranges: &[RangeInfo]) -> Option<String> {
    // Try each version (already sorted newest-first) and return the first
    // that satisfies all ranges.
    'outer: for ver in versions {
        let parsed = match parse_semver(ver) {
            Some(v) => v,
            None => continue,
        };
        for ri in ranges {
            if !range_matches(&parsed, &ri.range) {
                continue 'outer;
            }
        }
        return Some(ver.clone());
    }
    None
}

/// Parse a semver string into (major, minor, patch).
fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim_start_matches('v');
    // Strip pre-release / build metadata
    let v = v.split('-').next().unwrap_or(v);
    let v = v.split('+').next().unwrap_or(v);
    let parts: Vec<&str> = v.split('.').collect();
    let major = parts.first().and_then(|s| s.parse().ok())?;
    let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    Some((major, minor, patch))
}

/// Returns true if `ver` satisfies the version `range` string.
fn range_matches(ver: &(u64, u64, u64), range: &str) -> bool {
    let range = range.trim();
    if range.is_empty() || range == "*" || range == "latest" {
        return true;
    }
    // Handle space-separated AND clauses: ">=1.0.0 <2.0.0"
    if range.contains(' ') {
        return range
            .split_whitespace()
            .all(|part| range_matches(ver, part));
    }
    // ^ caret range
    if let Some(req) = range.strip_prefix('^') {
        if let Some(r) = parse_semver(req) {
            return caret_matches(ver, &r);
        }
    }
    // ~ tilde range
    if let Some(req) = range.strip_prefix('~') {
        if let Some(r) = parse_semver(req) {
            return tilde_matches(ver, &r);
        }
    }
    // >= lower bound
    if let Some(req) = range.strip_prefix(">=") {
        if let Some(r) = parse_semver(req) {
            return semver_ge(ver, &r);
        }
    }
    // > strictly greater
    if let Some(req) = range.strip_prefix('>') {
        if let Some(r) = parse_semver(req) {
            return semver_gt(ver, &r);
        }
    }
    // <= upper bound
    if let Some(req) = range.strip_prefix("<=") {
        if let Some(r) = parse_semver(req) {
            return semver_le(ver, &r);
        }
    }
    // < strictly less
    if let Some(req) = range.strip_prefix('<') {
        if let Some(r) = parse_semver(req) {
            return semver_lt(ver, &r);
        }
    }
    // exact match
    if let Some(r) = parse_semver(range) {
        return ver == &r;
    }
    // Fallback: treat as compatible if it parses at all
    false
}

fn caret_matches(ver: &(u64, u64, u64), req: &(u64, u64, u64)) -> bool {
    let (vmaj, vmin, vpat) = ver;
    let (rmaj, rmin, rpat) = req;
    if vmaj != rmaj { return false; }
    if *rmaj > 0 {
        semver_ge(ver, req)
    } else if *rmin > 0 {
        vmin == rmin && vpat >= rpat
    } else {
        vpat >= rpat
    }
}

fn tilde_matches(ver: &(u64, u64, u64), req: &(u64, u64, u64)) -> bool {
    let (vmaj, vmin, vpat) = ver;
    let (rmaj, rmin, rpat) = req;
    vmaj == rmaj && vmin == rmin && vpat >= rpat
}

fn semver_ge(a: &(u64, u64, u64), b: &(u64, u64, u64)) -> bool {
    a >= b
}
fn semver_gt(a: &(u64, u64, u64), b: &(u64, u64, u64)) -> bool {
    a > b
}
fn semver_le(a: &(u64, u64, u64), b: &(u64, u64, u64)) -> bool {
    a <= b
}
fn semver_lt(a: &(u64, u64, u64), b: &(u64, u64, u64)) -> bool {
    a < b
}

/// Newest-first comparator for version strings.
fn compare_versions_desc(a: &str, b: &str) -> std::cmp::Ordering {
    let pa = parse_semver(a).unwrap_or((0, 0, 0));
    let pb = parse_semver(b).unwrap_or((0, 0, 0));
    pb.cmp(&pa)
}

// ---------------------------------------------------------------------------
// Override generation
// ---------------------------------------------------------------------------

/// Generate a `package.json` `overrides` patch to resolve duplicates.
/// Returns a map of `package_name -> version` for auto-fixable dupes.
pub fn generate_overrides(analyses: &[DupeAnalysis]) -> HashMap<String, String> {
    analyses
        .iter()
        .filter(|a| a.can_auto_fix)
        .filter_map(|a| {
            a.suggested_version
                .as_ref()
                .map(|v| (a.package_name.clone(), v.clone()))
        })
        .collect()
}

/// Summary of a dedupe-fix operation.
#[derive(Debug, Serialize)]
pub struct DedupeFixSummary {
    pub total_duplicated: usize,
    pub auto_fixable: usize,
    pub manual_review_needed: usize,
    pub total_savings_bytes: u64,
    pub overrides: HashMap<String, String>,
}

/// Build a summary from a list of analyses.
pub fn build_fix_summary(analyses: &[DupeAnalysis]) -> DedupeFixSummary {
    let auto_fixable: Vec<&DupeAnalysis> = analyses.iter().filter(|a| a.can_auto_fix).collect();
    let manual: Vec<&DupeAnalysis> = analyses.iter().filter(|a| !a.can_auto_fix).collect();
    let savings: u64 = analyses.iter().map(|a| a.savings_bytes).sum();
    let overrides = generate_overrides(analyses);

    DedupeFixSummary {
        total_duplicated: analyses.len(),
        auto_fixable: auto_fixable.len(),
        manual_review_needed: manual.len(),
        total_savings_bytes: savings,
        overrides,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pkg(name: &str, version: &str, reqs: &[(&str, &str)]) -> ResolvedPkg {
        ResolvedPkg {
            name: name.to_string(),
            version: version.to_string(),
            requested_by: reqs.iter().map(|(r, v)| (r.to_string(), v.to_string())).collect(),
            size_bytes: 10_000,
        }
    }

    #[test]
    fn no_dupes_returns_empty() {
        let pkgs = vec![make_pkg("lodash", "4.17.21", &[("root", "^4.0.0")])];
        let analyses = analyze_dupes(&pkgs);
        assert!(analyses.is_empty());
    }

    #[test]
    fn dupe_detected() {
        let pkgs = vec![
            make_pkg("lodash", "4.17.20", &[("a", "^4.0.0")]),
            make_pkg("lodash", "4.17.21", &[("b", "^4.0.0")]),
        ];
        let analyses = analyze_dupes(&pkgs);
        assert_eq!(analyses.len(), 1);
        assert_eq!(analyses[0].package_name, "lodash");
        assert_eq!(analyses[0].versions.len(), 2);
    }

    #[test]
    fn auto_fix_when_ranges_compatible() {
        let pkgs = vec![
            make_pkg("lodash", "4.17.20", &[("a", "^4.0.0")]),
            make_pkg("lodash", "4.17.21", &[("b", "^4.17.0")]),
        ];
        let analyses = analyze_dupes(&pkgs);
        assert_eq!(analyses.len(), 1);
        assert!(analyses[0].can_auto_fix);
        assert!(analyses[0].suggested_version.is_some());
    }

    #[test]
    fn no_auto_fix_for_incompatible_majors() {
        let pkgs = vec![
            make_pkg("semver", "6.3.0", &[("a", "^6.0.0")]),
            make_pkg("semver", "7.5.0", &[("b", "^7.0.0")]),
        ];
        let analyses = analyze_dupes(&pkgs);
        assert_eq!(analyses.len(), 1);
        assert!(!analyses[0].can_auto_fix);
    }

    #[test]
    fn savings_calculated() {
        let pkgs = vec![
            make_pkg("react", "17.0.0", &[("a", "^17.0.0")]),
            make_pkg("react", "18.0.0", &[("b", "^18.0.0")]),
        ];
        let analyses = analyze_dupes(&pkgs);
        assert!(analyses[0].savings_bytes > 0);
    }

    #[test]
    fn generate_overrides_for_fixable() {
        let analyses = vec![
            DupeAnalysis {
                package_name: "lodash".to_string(),
                versions: vec!["4.17.21".to_string(), "4.17.20".to_string()],
                ranges_requesting: vec![],
                suggested_version: Some("4.17.21".to_string()),
                can_auto_fix: true,
                savings_bytes: 10_000,
            },
            DupeAnalysis {
                package_name: "semver".to_string(),
                versions: vec!["7.0.0".to_string(), "6.0.0".to_string()],
                ranges_requesting: vec![],
                suggested_version: None,
                can_auto_fix: false,
                savings_bytes: 5_000,
            },
        ];
        let overrides = generate_overrides(&analyses);
        assert_eq!(overrides.len(), 1);
        assert_eq!(overrides["lodash"], "4.17.21");
        assert!(!overrides.contains_key("semver"));
    }

    #[test]
    fn caret_range_match() {
        assert!(range_matches(&(4, 17, 21), "^4.17.0"));
        assert!(!range_matches(&(4, 17, 21), "^5.0.0"));
        assert!(range_matches(&(4, 17, 21), ">=4.0.0"));
    }

    #[test]
    fn tilde_range_match() {
        assert!(range_matches(&(4, 17, 21), "~4.17.20"));
        assert!(!range_matches(&(4, 18, 0), "~4.17.20"));
    }
}
