// crates/better-core/src/intelligence/mod.rs
// ML-powered dependency intelligence — signal aggregation, risk prediction

pub mod supply_chain;
pub mod audit_fix;
pub mod signals;
pub mod scoring;
pub mod impact;
pub mod predict;
pub mod changelog;
pub mod smart_upgrade;

pub use signals::PackageSignals;
pub use scoring::{ReputationScore, Grade, ScoreBreakdown, ReputationFlag, FlagType, FlagSeverity, compute_score};
pub use impact::{ImpactAnalysis, UsageAnalysis, RemovalImpact, AlternativePackage, ImpactRisk, MigrationEffort, analyze_impact};
pub use predict::{MaintenancePrediction, MaintenanceStatus, PredictionSignal, Trend, Action, predict_maintenance};

use serde::Serialize;

/// Aggregated intelligence score for a package.
#[derive(Debug, Clone, Serialize)]
pub struct PackageIntelligence {
    pub name: String,
    pub version: String,
    pub overall_score: f64,         // 0-100
    pub grade: String,              // A, B, C, D, F
    pub signals: IntelligenceSignals,
    pub recommendation: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct IntelligenceSignals {
    pub download_trend: DownloadTrend,
    pub maintenance_activity: f64,  // 0-1
    pub security_history: f64,      // 0-1 (1 = clean history)
    pub bus_factor: u32,            // number of key maintainers
    pub age_days: u64,
    pub release_frequency_days: f64,
    pub last_release_days_ago: u64,
    pub open_issues: Option<u64>,
    pub typosquat_risk: f64,        // 0-1
}

pub use signals::DownloadTrend;

impl PackageIntelligence {
    /// Compute overall grade from weighted signals.
    pub fn compute_grade(signals: &IntelligenceSignals) -> (f64, String) {
        let maintenance = signals.maintenance_activity * 30.0;
        let security = signals.security_history * 25.0;
        let activity = match signals.download_trend {
            DownloadTrend::Surging => 20.0,
            DownloadTrend::Growing => 17.0,
            DownloadTrend::Stable => 15.0,
            DownloadTrend::Declining => 8.0,
            DownloadTrend::Abandoned => 0.0,
            DownloadTrend::Anomalous => 5.0,
        };
        let freshness = if signals.last_release_days_ago < 90 {
            15.0
        } else if signals.last_release_days_ago < 365 {
            10.0
        } else if signals.last_release_days_ago < 730 {
            5.0
        } else {
            0.0
        };
        let bus_factor_score = if signals.bus_factor >= 3 {
            10.0
        } else if signals.bus_factor == 2 {
            7.0
        } else {
            3.0
        };

        let score = maintenance + security + activity + freshness + bus_factor_score;
        let grade = if score >= 85.0 { "A" }
            else if score >= 70.0 { "B" }
            else if score >= 55.0 { "C" }
            else if score >= 40.0 { "D" }
            else { "F" };

        (score, grade.to_string())
    }
}

/// Detect packages that are likely typosquats.
pub fn check_typosquat(name: &str, known_packages: &[String]) -> f64 {
    let mut min_distance = usize::MAX;
    for known in known_packages {
        let d = levenshtein(name, known);
        if d > 0 && d < min_distance {
            min_distance = d;
        }
    }
    // Risk: 1 char edit = 0.9 risk, 2 chars = 0.5, 3+ = 0
    match min_distance {
        1 => 0.9,
        2 => 0.5,
        3 => 0.2,
        _ => 0.0,
    }
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let m = a.len();
    let n = b.len();
    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in 0..=m { dp[i][0] = i; }
    for j in 0..=n { dp[0][j] = j; }
    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = if a[i-1] == b[j-1] {
                dp[i-1][j-1]
            } else {
                1 + dp[i-1][j].min(dp[i][j-1]).min(dp[i-1][j-1])
            };
        }
    }
    dp[m][n]
}

/// Predict maintenance risk from signals.
pub fn predict_maintenance_risk(signals: &IntelligenceSignals) -> &'static str {
    if signals.last_release_days_ago > 730 && signals.open_issues.map_or(false, |i| i > 50) {
        return "critical";
    }
    if signals.last_release_days_ago > 365 || signals.maintenance_activity < 0.2 {
        return "high";
    }
    if signals.last_release_days_ago > 180 || signals.maintenance_activity < 0.5 {
        return "medium";
    }
    "low"
}
