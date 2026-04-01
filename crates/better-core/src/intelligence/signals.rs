// crates/better-core/src/intelligence/signals.rs
//
// Raw signal collectors for package reputation scoring (v1.5 Task 114.1).
//
// Each signal is collected from a different source:
//   - Registry metadata (npm, PyPI, crates.io)
//   - GitHub activity (commits, issues, CI)
//   - OSV vulnerability database
//   - Download statistics

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Signal types
// ---------------------------------------------------------------------------

/// Raw signals collected for a single package version.
/// All fields have zero/None defaults so partial collection still produces a score.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PackageSignals {
    pub package: String,
    pub ecosystem: String,
    pub version: String,

    // --- Maintainer health ---
    /// Number of unique publishers/maintainers
    pub maintainer_count: u32,
    /// Days in last 90d where at least one maintainer was active
    pub maintainer_active_days_90: u32,
    /// Whether all maintainers have 2FA enabled (None = unknown)
    pub maintainer_has_2fa: Option<bool>,
    /// Effective bus factor (capped at 3 for scoring)
    pub bus_factor: u32,

    // --- Activity ---
    pub days_since_last_publish: u32,
    pub publish_frequency_30d: f64,
    pub commit_frequency_30d: f64,
    pub open_issues: u32,
    pub issue_response_time_median_hours: f64,
    pub open_prs: u32,

    // --- Downloads ---
    pub weekly_downloads: u64,
    pub download_trend: DownloadTrend,
    /// 0.0 = normal, 1.0 = extremely anomalous (sudden spike/drop)
    pub download_anomaly_score: f64,

    // --- Security ---
    pub total_cves: u32,
    pub unpatched_cves: u32,
    pub days_since_last_cve: Option<u32>,
    pub has_provenance: bool,
    pub has_signature: bool,

    // --- Quality ---
    pub has_types: bool,
    pub has_tests: bool,
    pub has_ci: bool,
    pub license: Option<String>,
    pub readme_length: u32,

    // --- Typosquat ---
    pub typosquat_distance_min: u32,
    pub typosquat_suspect: bool,
    pub age_days: u32,
}

/// Download trend for a package over recent weeks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum DownloadTrend {
    Surging,    // >50% growth
    Growing,    // 10-50% growth
    #[default]
    Stable,     // ±10%
    Declining,  // -10 to -50%
    Abandoned,  // <-50% or 0 downloads
    /// Sudden spike/drop inconsistent with organic growth
    Anomalous,
}

// ---------------------------------------------------------------------------
// Signal construction helpers
// ---------------------------------------------------------------------------

impl PackageSignals {
    /// Create a minimal signal set from the data available in the local project
    /// (no network calls required).
    pub fn from_local(
        package: &str,
        ecosystem: &str,
        version: &str,
        maintainer_count: u32,
        has_types: bool,
        has_provenance: bool,
        license: Option<String>,
        age_days: u32,
        weekly_downloads: u64,
    ) -> Self {
        Self {
            package: package.to_string(),
            ecosystem: ecosystem.to_string(),
            version: version.to_string(),
            maintainer_count,
            bus_factor: maintainer_count.min(3),
            has_types,
            has_provenance,
            license,
            age_days,
            weekly_downloads,
            // Defaults for unknown signals
            days_since_last_publish: 30,
            issue_response_time_median_hours: 72.0,
            ..Default::default()
        }
    }

    /// Classify the download trend from weekly download history.
    ///
    /// `history`: weekly download counts, oldest first, at least 4 weeks.
    pub fn classify_trend(history: &[u64]) -> DownloadTrend {
        if history.len() < 4 {
            return DownloadTrend::Stable;
        }
        let recent: f64 = history[history.len() - 2..].iter().map(|&v| v as f64).sum::<f64>() / 2.0;
        let older: f64 = history[..history.len() / 2].iter().map(|&v| v as f64).sum::<f64>()
            / (history.len() / 2) as f64;

        if older == 0.0 {
            return DownloadTrend::Anomalous;
        }
        let ratio = recent / older;

        // Sudden spike or near-zero crash → anomalous
        if ratio > 10.0 || ratio < 0.05 {
            return DownloadTrend::Anomalous;
        }
        match ratio as u32 {
            _ if ratio > 1.5 => DownloadTrend::Growing,
            _ if ratio > 0.5 => DownloadTrend::Stable,
            _ => DownloadTrend::Declining,
        }
    }

    /// Compute typosquat distance from a set of popular package names.
    pub fn compute_typosquat_distance(package: &str, popular: &[&str]) -> u32 {
        popular
            .iter()
            .map(|p| levenshtein(package, p))
            .min()
            .unwrap_or(u32::MAX)
    }
}

// ---------------------------------------------------------------------------
// Levenshtein distance (for typosquat detection)
// ---------------------------------------------------------------------------

pub fn levenshtein(a: &str, b: &str) -> u32 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let m = a.len();
    let n = b.len();

    if m == 0 { return n as u32; }
    if n == 0 { return m as u32; }

    let mut dp = vec![vec![0u32; n + 1]; m + 1];
    for i in 0..=m { dp[i][0] = i as u32; }
    for j in 0..=n { dp[0][j] = j as u32; }

    for i in 1..=m {
        for j in 1..=n {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            dp[i][j] = (dp[i - 1][j] + 1)
                .min(dp[i][j - 1] + 1)
                .min(dp[i - 1][j - 1] + cost);
        }
    }
    dp[m][n]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levenshtein_identical() {
        assert_eq!(levenshtein("lodash", "lodash"), 0);
    }

    #[test]
    fn levenshtein_one_edit() {
        assert_eq!(levenshtein("react", "reect"), 1);
        assert_eq!(levenshtein("lodash", "lodsh"), 1);
    }

    #[test]
    fn levenshtein_insertion() {
        assert_eq!(levenshtein("express", "expresss"), 1);
    }

    #[test]
    fn typosquat_detection() {
        let popular = ["lodash", "react", "express"];
        let dist = PackageSignals::compute_typosquat_distance("lodahs", &popular);
        assert!(dist <= 2, "lodahs should be close to lodash");
    }

    #[test]
    fn trend_growing() {
        let history = vec![100u64, 110, 120, 180, 200, 210];
        assert_eq!(PackageSignals::classify_trend(&history), DownloadTrend::Growing);
    }

    #[test]
    fn trend_declining() {
        let history = vec![1000u64, 900, 500, 100, 80, 60];
        assert_eq!(PackageSignals::classify_trend(&history), DownloadTrend::Declining);
    }

    #[test]
    fn trend_anomalous_spike() {
        let history = vec![100u64, 100, 100, 100, 100, 10000];
        assert_eq!(PackageSignals::classify_trend(&history), DownloadTrend::Anomalous);
    }
}
