// crates/better-core/src/intelligence/predict.rs
//
// Predictive maintenance analysis (v1.5 Task 119).
//
// Derives a future maintenance prediction from already-collected PackageSignals,
// requiring no additional network I/O.  The caller is expected to populate
// `PackageSignals` from registry/GitHub data before calling `predict_maintenance`.

use serde::Serialize;

use super::signals::PackageSignals;
use super::impact::AlternativePackage;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct MaintenancePrediction {
    pub package: String,
    pub version: String,
    pub current_status: MaintenanceStatus,
    pub predicted_status_6mo: MaintenanceStatus,
    /// Confidence in the prediction (0.0–1.0)
    pub confidence: f64,
    pub risk_score: f64,
    pub signals: Vec<PredictionSignal>,
    pub recommended_action: Action,
    pub alternatives: Vec<AlternativePackage>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MaintenanceStatus {
    Active,
    SlowingDown,
    AtRisk,
    Unmaintained,
    Deprecated,
}

#[derive(Debug, Clone, Serialize)]
pub struct PredictionSignal {
    pub signal: String,
    pub trend: Trend,
    /// How much this signal contributes to the risk score (0.0–1.0)
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Trend {
    Improving,
    Stable,
    Declining,
    Critical,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    NoAction,
    Monitor,
    PlanMigration { to: String, effort: String },
    MigrateNow { to: String, reason: String },
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/// Predict future maintenance status from pre-collected signals.
///
/// Returns a `MaintenancePrediction` with current/6-month status, risk score,
/// individual signals, a recommended action, and known alternatives.
pub fn predict_maintenance(signals: &PackageSignals) -> MaintenancePrediction {
    let mut risk_score: f64 = 0.0;
    let mut signal_list: Vec<PredictionSignal> = Vec::new();

    // --- Commit activity ---
    let commit_trend = classify_commit_trend(signals.commit_frequency_30d);
    if commit_trend == Trend::Declining || commit_trend == Trend::Critical {
        let w = if commit_trend == Trend::Critical { 0.30 } else { 0.15 };
        risk_score += w;
        signal_list.push(PredictionSignal {
            signal: format!(
                "Commit frequency {:.1}/month — {}",
                signals.commit_frequency_30d * 30.0,
                if commit_trend == Trend::Critical { "no recent activity" } else { "declining" }
            ),
            trend: commit_trend,
            weight: w,
        });
    }

    // --- Release cadence ---
    let publish_trend = classify_publish_trend(signals.days_since_last_publish);
    let publish_weight = match publish_trend {
        Trend::Critical  => 0.30,
        Trend::Declining => 0.15,
        _                => 0.0,
    };
    if publish_weight > 0.0 {
        risk_score += publish_weight;
        signal_list.push(PredictionSignal {
            signal: format!(
                "No release for {} days",
                signals.days_since_last_publish
            ),
            trend: publish_trend,
            weight: publish_weight,
        });
    }

    // --- Issue response time ---
    let issue_trend = classify_issue_trend(signals.issue_response_time_median_hours);
    if issue_trend == Trend::Declining || issue_trend == Trend::Critical {
        let w = if issue_trend == Trend::Critical { 0.20 } else { 0.10 };
        risk_score += w;
        signal_list.push(PredictionSignal {
            signal: format!(
                "Median issue response {:.0}h",
                signals.issue_response_time_median_hours
            ),
            trend: issue_trend,
            weight: w,
        });
    }

    // --- Download trend ---
    use super::signals::DownloadTrend;
    let dl_weight = match &signals.download_trend {
        DownloadTrend::Abandoned => { 0.15 }
        DownloadTrend::Declining => { 0.05 }
        _ => 0.0,
    };
    if dl_weight > 0.0 {
        risk_score += dl_weight;
        signal_list.push(PredictionSignal {
            signal: format!("Download trend: {:?}", signals.download_trend),
            trend: if dl_weight >= 0.15 { Trend::Critical } else { Trend::Declining },
            weight: dl_weight,
        });
    }

    // --- Bus factor ---
    if signals.bus_factor == 0 {
        risk_score += 0.20;
        signal_list.push(PredictionSignal {
            signal: "No known maintainer".into(),
            trend: Trend::Critical,
            weight: 0.20,
        });
    } else if signals.bus_factor == 1 {
        risk_score += 0.10;
        signal_list.push(PredictionSignal {
            signal: "Single maintainer — high bus factor".into(),
            trend: Trend::Declining,
            weight: 0.10,
        });
    }

    // Clamp
    risk_score = risk_score.clamp(0.0, 1.0);

    // --- Current status ---
    let current_status = current_maintenance_status(signals);

    // --- Predicted 6-month status ---
    let predicted_status_6mo = predict_6mo_status(&current_status, risk_score);

    // --- Confidence: more signals → higher confidence ---
    let confidence = (0.5 + signal_list.len() as f64 * 0.08).clamp(0.4, 0.95);

    // --- Recommended action ---
    let alternatives = super::impact::known_alternatives_pub(&signals.package);
    let recommended_action = recommend_action(risk_score, &predicted_status_6mo, &alternatives);

    MaintenancePrediction {
        package: signals.package.clone(),
        version: signals.version.clone(),
        current_status,
        predicted_status_6mo,
        confidence,
        risk_score,
        signals: signal_list,
        recommended_action,
        alternatives,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn classify_commit_trend(freq_30d: f64) -> Trend {
    // freq_30d is average commits per day over last 30 days
    let monthly = freq_30d * 30.0;
    match monthly as u32 {
        0            => Trend::Critical,
        1..=2        => Trend::Declining,
        3..=10       => Trend::Stable,
        _            => Trend::Improving,
    }
}

fn classify_publish_trend(days_since: u32) -> Trend {
    match days_since {
        0..=60   => Trend::Stable,
        61..=180 => Trend::Declining,
        181..=365 => Trend::Declining,
        _ => Trend::Critical,  // > 1 year without release
    }
}

fn classify_issue_trend(median_hours: f64) -> Trend {
    match median_hours as u32 {
        0..=24   => Trend::Improving,
        25..=72  => Trend::Stable,
        73..=336 => Trend::Declining,  // up to 2 weeks
        _ => Trend::Critical,
    }
}

fn current_maintenance_status(signals: &PackageSignals) -> MaintenanceStatus {
    // Check for explicit unmaintained / deprecated signals
    if signals.bus_factor == 0 && signals.days_since_last_publish > 365 {
        return MaintenanceStatus::Unmaintained;
    }
    if signals.days_since_last_publish > 730 {
        return MaintenanceStatus::Unmaintained;
    }
    if signals.days_since_last_publish > 365 || signals.commit_frequency_30d * 30.0 < 1.0 {
        return MaintenanceStatus::AtRisk;
    }
    if signals.days_since_last_publish > 180 || signals.commit_frequency_30d * 30.0 < 3.0 {
        return MaintenanceStatus::SlowingDown;
    }
    MaintenanceStatus::Active
}

fn predict_6mo_status(current: &MaintenanceStatus, risk: f64) -> MaintenanceStatus {
    match current {
        MaintenanceStatus::Unmaintained => MaintenanceStatus::Unmaintained,
        MaintenanceStatus::Deprecated   => MaintenanceStatus::Deprecated,
        MaintenanceStatus::AtRisk if risk > 0.5 => MaintenanceStatus::Unmaintained,
        MaintenanceStatus::AtRisk       => MaintenanceStatus::AtRisk,
        MaintenanceStatus::SlowingDown if risk > 0.6 => MaintenanceStatus::AtRisk,
        MaintenanceStatus::SlowingDown  => MaintenanceStatus::SlowingDown,
        MaintenanceStatus::Active if risk > 0.4 => MaintenanceStatus::SlowingDown,
        MaintenanceStatus::Active       => MaintenanceStatus::Active,
    }
}

fn recommend_action(
    risk: f64,
    predicted: &MaintenanceStatus,
    alternatives: &[AlternativePackage],
) -> Action {
    let best_alt = alternatives.first().map(|a| a.name.clone()).unwrap_or_default();
    let effort   = alternatives.first()
        .map(|a| format!("{:?}", a.migration_effort))
        .unwrap_or_else(|| "Unknown".into());

    match predicted {
        MaintenanceStatus::Unmaintained | MaintenanceStatus::Deprecated => {
            if best_alt.is_empty() {
                Action::Monitor
            } else {
                Action::MigrateNow {
                    to: best_alt,
                    reason: "Package predicted unmaintained within 6 months".into(),
                }
            }
        }
        MaintenanceStatus::AtRisk if risk > 0.5 => {
            if best_alt.is_empty() {
                Action::Monitor
            } else {
                Action::PlanMigration { to: best_alt, effort }
            }
        }
        MaintenanceStatus::SlowingDown if risk > 0.3 => Action::Monitor,
        _ => Action::NoAction,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intelligence::signals::{PackageSignals, DownloadTrend};

    fn active_signals(pkg: &str) -> PackageSignals {
        PackageSignals {
            package: pkg.to_string(),
            ecosystem: "npm".to_string(),
            version: "1.0.0".to_string(),
            bus_factor: 3,
            maintainer_count: 3,
            commit_frequency_30d: 0.5, // ~15 commits/month
            days_since_last_publish: 30,
            issue_response_time_median_hours: 24.0,
            weekly_downloads: 100_000,
            download_trend: DownloadTrend::Stable,
            age_days: 730,
            ..Default::default()
        }
    }

    #[test]
    fn active_healthy_package_no_action() {
        let sig = active_signals("express");
        let pred = predict_maintenance(&sig);
        assert_eq!(pred.current_status, MaintenanceStatus::Active);
        assert!(matches!(pred.recommended_action, Action::NoAction));
        assert!(pred.risk_score < 0.3);
    }

    #[test]
    fn unmaintained_package_migrate_now() {
        let mut sig = active_signals("old-pkg");
        sig.days_since_last_publish = 800;
        sig.commit_frequency_30d = 0.0;
        sig.bus_factor = 0;
        sig.package = "moment".to_string(); // has known alternatives
        let pred = predict_maintenance(&sig);
        assert_eq!(pred.current_status, MaintenanceStatus::Unmaintained);
        assert!(matches!(pred.recommended_action, Action::MigrateNow { .. }));
    }

    #[test]
    fn slowing_down_raises_risk() {
        let mut sig = active_signals("medium-pkg");
        sig.days_since_last_publish = 200;
        sig.commit_frequency_30d = 0.05; // ~1.5 commits/month
        let pred = predict_maintenance(&sig);
        assert!(
            matches!(pred.current_status, MaintenanceStatus::SlowingDown | MaintenanceStatus::AtRisk),
            "got {:?}", pred.current_status
        );
        assert!(pred.risk_score > 0.0);
    }

    #[test]
    fn single_maintainer_adds_risk_signal() {
        let mut sig = active_signals("solo-pkg");
        sig.bus_factor = 1;
        sig.maintainer_count = 1;
        let pred = predict_maintenance(&sig);
        assert!(pred.signals.iter().any(|s| s.signal.contains("Single maintainer")));
    }

    #[test]
    fn known_alternative_for_moment() {
        let mut sig = active_signals("moment");
        sig.days_since_last_publish = 500;
        sig.commit_frequency_30d = 0.0;
        let pred = predict_maintenance(&sig);
        assert!(!pred.alternatives.is_empty());
        assert!(pred.alternatives.iter().any(|a| a.name == "dayjs"));
    }

    #[test]
    fn confidence_increases_with_more_signals() {
        let base   = predict_maintenance(&active_signals("clean-pkg")).confidence;
        let mut sig = active_signals("risky-pkg");
        sig.bus_factor = 0;
        sig.days_since_last_publish = 800;
        sig.commit_frequency_30d = 0.0;
        let risky  = predict_maintenance(&sig).confidence;
        assert!(risky >= base, "more signals should yield >= confidence");
    }

    #[test]
    fn risk_clamped_to_one() {
        let mut sig = active_signals("worst-pkg");
        sig.bus_factor = 0;
        sig.days_since_last_publish = 1000;
        sig.commit_frequency_30d = 0.0;
        sig.download_trend = DownloadTrend::Abandoned;
        sig.issue_response_time_median_hours = 10_000.0;
        let pred = predict_maintenance(&sig);
        assert!(pred.risk_score <= 1.0);
    }

    #[test]
    fn active_package_has_low_risk() {
        let sig = active_signals("healthy-pkg");
        let pred = predict_maintenance(&sig);
        assert!(pred.risk_score < 0.5, "healthy package should have risk < 0.5, got {}", pred.risk_score);
        assert_eq!(pred.current_status, MaintenanceStatus::Active);
    }
}
