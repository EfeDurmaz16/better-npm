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
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
// Network signal collection
// ---------------------------------------------------------------------------

fn signal_http_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .user_agent("better-npm/1.0 (reputation-signals)")
            .build()
            .unwrap_or_default()
    })
}

fn get_json(url: &str) -> Option<serde_json::Value> {
    let text = signal_http_client()
        .get(url)
        .send()
        .ok()
        .and_then(|r| if r.status().is_success() { r.text().ok() } else { None })?;
    serde_json::from_str(&text).ok()
}

fn post_json_body(url: &str, body: String) -> Option<serde_json::Value> {
    let text = signal_http_client()
        .post(url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .ok()
        .and_then(|r| if r.status().is_success() { r.text().ok() } else { None })?;
    serde_json::from_str(&text).ok()
}

/// Fetch raw npm registry metadata for a package.
fn fetch_npm_metadata(package: &str) -> Option<serde_json::Value> {
    let url = format!("https://registry.npmjs.org/{}", urlencoding_simple(package));
    get_json(&url)
}

/// Fetch npm download counts for the last month (weekly buckets).
fn fetch_npm_downloads(package: &str) -> Vec<u64> {
    let url = format!(
        "https://api.npmjs.org/downloads/range/last-month/{}",
        urlencoding_simple(package)
    );
    let json: Option<serde_json::Value> = get_json(&url);

    json.as_ref()
        .and_then(|v| v["downloads"].as_array())
        .map(|days| {
            // Group daily counts into weekly buckets
            days.iter()
                .filter_map(|d| d["downloads"].as_u64())
                .collect::<Vec<_>>()
                .chunks(7)
                .map(|week| week.iter().sum())
                .collect()
        })
        .unwrap_or_default()
}

/// Query OSV for known vulnerabilities affecting package@version.
fn fetch_osv_vuln_count(package: &str, version: &str, ecosystem: &str) -> (u32, u32) {
    #[derive(serde::Serialize)]
    struct OsvQuery {
        package: OsvPkg,
        version: String,
    }
    #[derive(serde::Serialize)]
    struct OsvPkg {
        name: String,
        ecosystem: String,
    }
    #[derive(serde::Deserialize)]
    struct OsvResp {
        vulns: Option<Vec<serde_json::Value>>,
    }

    let eco = match ecosystem {
        "npm" => "npm",
        "python" => "PyPI",
        "cargo" => "crates.io",
        "go" => "Go",
        _ => "npm",
    };

    let body = serde_json::to_string(&OsvQuery {
        package: OsvPkg { name: package.to_string(), ecosystem: eco.to_string() },
        version: version.to_string(),
    }).unwrap_or_default();

    let resp_val = post_json_body("https://api.osv.dev/v1/query", body);
    let resp: Option<OsvResp> = resp_val.and_then(|v| serde_json::from_value(v).ok());

    let vulns = resp.and_then(|r| r.vulns).unwrap_or_default();
    let total = vulns.len() as u32;
    // Count unpatched: those where the version range includes the queried version
    // (OSV returns vulns affecting this version, so all are "patched-or-unpatched")
    // Conservative: treat all as unpatched since we can't easily parse fix versions here
    (total, total)
}

fn urlencoding_simple(s: &str) -> String {
    s.replace('/', "%2F").replace('@', "%40")
}

fn days_since_iso(iso_str: &str) -> Option<u32> {
    // Parse "2023-04-01T12:00:00.000Z" → days since then
    let ts = iso_str.trim_end_matches('Z');
    // Extract YYYY-MM-DD
    let date_part = ts.get(..10)?;
    let parts: Vec<&str> = date_part.split('-').collect();
    if parts.len() != 3 { return None; }
    let y: i64 = parts[0].parse().ok()?;
    let m: i64 = parts[1].parse().ok()?;
    let d: i64 = parts[2].parse().ok()?;
    // Days since epoch (rough approximation)
    let jdn = (1461 * (y + 4800 + (m - 14) / 12)) / 4
        + (367 * (m - 2 - 12 * ((m - 14) / 12))) / 12
        - (3 * ((y + 4900 + (m - 14) / 12) / 100)) / 4
        + d - 32075;
    let epoch_jdn = 2440588i64; // 1970-01-01
    let target_days = jdn - epoch_jdn;
    let now_days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64 / 86400;
    Some((now_days - target_days).max(0) as u32)
}

/// Collect package signals from public network APIs (npm, OSV).
///
/// Best-effort: network failures are silently absorbed and missing fields
/// fall back to conservative defaults. Caller should treat the result as
/// approximate.
pub fn collect_signals(package: &str, ecosystem: &str, version: &str) -> PackageSignals {
    let mut signals = PackageSignals {
        package: package.to_string(),
        ecosystem: ecosystem.to_string(),
        version: version.to_string(),
        ..Default::default()
    };

    // --- npm registry metadata ---
    if ecosystem == "npm" {
        if let Some(meta) = fetch_npm_metadata(package) {
            // Maintainers
            let maintainer_count = meta["maintainers"]
                .as_array()
                .map(|a| a.len() as u32)
                .unwrap_or(1);
            signals.maintainer_count = maintainer_count;
            signals.bus_factor = maintainer_count.min(3);

            // License
            signals.license = meta["license"].as_str().map(|s| s.to_string());

            // Created date → age_days
            if let Some(created) = meta["time"]["created"].as_str() {
                signals.age_days = days_since_iso(created).unwrap_or(365);
            }

            // Days since last publish
            if let Some(modified) = meta["time"]["modified"].as_str() {
                signals.days_since_last_publish = days_since_iso(modified).unwrap_or(90);
            }

            // Version-specific data
            if let Some(ver_data) = meta["versions"][version].as_object() {
                signals.has_types = ver_data.contains_key("types")
                    || ver_data.contains_key("typings")
                    || ver_data.get("name").and_then(|n| n.as_str())
                        .map(|n| n.starts_with("@types/"))
                        .unwrap_or(false);
                signals.has_provenance = ver_data.contains_key("dist")
                    && ver_data["dist"].as_object()
                        .map(|d| d.contains_key("signatures"))
                        .unwrap_or(false);
            }

            // README presence and length
            signals.readme_length = meta["readme"]
                .as_str()
                .map(|s| s.len() as u32)
                .unwrap_or(0);
        }
    }

    // --- Download statistics ---
    if ecosystem == "npm" {
        let weekly_buckets = fetch_npm_downloads(package);
        signals.weekly_downloads = weekly_buckets.last().copied().unwrap_or(0) * 7;
        signals.download_trend = PackageSignals::classify_trend(&weekly_buckets);
        // Simple anomaly score: ratio of max to median
        if weekly_buckets.len() >= 4 {
            let mut sorted = weekly_buckets.clone();
            sorted.sort_unstable();
            let median = sorted[sorted.len() / 2] as f64;
            let max = *sorted.last().unwrap_or(&0) as f64;
            signals.download_anomaly_score = if median > 0.0 {
                ((max / median) - 1.0).max(0.0).min(1.0) / 9.0  // normalize to [0,1]
            } else {
                0.0
            };
        }
    }

    // --- OSV vulnerability data ---
    let (total_cves, unpatched_cves) = fetch_osv_vuln_count(package, version, ecosystem);
    signals.total_cves = total_cves;
    signals.unpatched_cves = unpatched_cves;

    signals
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

    #[test]
    fn trend_stable() {
        let history = vec![100u64, 102, 98, 101, 100, 103];
        assert_eq!(PackageSignals::classify_trend(&history), DownloadTrend::Stable);
    }

    #[test]
    fn trend_too_short_returns_stable() {
        let history = vec![100u64, 200];
        assert_eq!(PackageSignals::classify_trend(&history), DownloadTrend::Stable);
    }

    #[test]
    fn compute_typosquat_empty_popular_returns_max() {
        let dist = PackageSignals::compute_typosquat_distance("lodash", &[]);
        assert_eq!(dist, u32::MAX);
    }

    #[test]
    fn from_local_builds_signal() {
        let sig = PackageSignals::from_local(
            "react", "npm", "18.0.0", 3, true, true, Some("MIT".into()), 2000, 1_000_000,
        );
        assert_eq!(sig.package, "react");
        assert_eq!(sig.ecosystem, "npm");
        assert_eq!(sig.weekly_downloads, 1_000_000);
        assert!(sig.has_provenance);
    }

    #[test]
    fn download_trend_default_is_stable() {
        let trend: DownloadTrend = Default::default();
        assert_eq!(trend, DownloadTrend::Stable);
    }

    #[test]
    fn collect_signals_returns_valid_struct() {
        // collect_signals always returns a struct (network failures are absorbed)
        let signals = collect_signals("nonexistent-pkg-xyz-123", "npm", "0.0.0");
        assert_eq!(signals.package, "nonexistent-pkg-xyz-123");
        assert_eq!(signals.ecosystem, "npm");
        assert_eq!(signals.version, "0.0.0");
        // Defaults on failure: everything zero/none
        assert_eq!(signals.total_cves, 0);
    }

    #[test]
    fn days_since_iso_future_returns_zero() {
        // A date far in the future should yield 0 days (clamped by max(0))
        let days = days_since_iso("2099-01-01T00:00:00.000Z");
        assert_eq!(days, Some(0));
    }

    #[test]
    fn days_since_iso_invalid_returns_none() {
        assert_eq!(days_since_iso("not-a-date"), None);
    }

    #[test]
    fn days_since_iso_old_date_positive() {
        let days = days_since_iso("2020-01-01T00:00:00.000Z");
        assert!(days.unwrap_or(0) > 1000, "should be many days since 2020");
    }

    #[test]
    fn urlencoding_simple_escapes_slash() {
        assert_eq!(urlencoding_simple("@babel/core"), "%40babel%2Fcore");
    }

    #[test]
    fn collect_signals_npm_ecosystem_field() {
        let sig = collect_signals("react", "npm", "18.0.0");
        assert_eq!(sig.ecosystem, "npm");
        assert_eq!(sig.version, "18.0.0");
    }

    #[test]
    fn collect_signals_non_npm_skips_downloads() {
        // For non-npm ecosystems, download stats should be empty (weekly_downloads = 0)
        let sig = collect_signals("serde", "cargo", "1.0.0");
        // weekly_downloads starts at 0 and only npm path populates it
        assert_eq!(sig.weekly_downloads, 0);
    }
}
