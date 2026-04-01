// crates/better-core/src/intelligence/scoring.rs
//
// Package reputation scoring model (v1.5 Task 114.2).
//
// Produces a 0-100 score with 4 equal-weight sub-scores:
//   - Maintainer Health  (0-25)
//   - Security Posture   (0-25)
//   - Activity Vitality  (0-25)
//   - Community Trust    (0-25)

use serde::Serialize;

use super::signals::{DownloadTrend, PackageSignals};
use DownloadTrend::Anomalous;

// ---------------------------------------------------------------------------
// Score types
// ---------------------------------------------------------------------------

/// Final reputation score for a package.
#[derive(Debug, Clone, Serialize)]
pub struct ReputationScore {
    pub package: String,
    pub version: String,
    /// Overall score 0-100
    pub score: u8,
    pub grade: Grade,
    pub breakdown: ScoreBreakdown,
    pub flags: Vec<ReputationFlag>,
    /// Unix timestamp when this score was computed
    pub computed_at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum Grade { A, B, C, D, F }

impl Grade {
    pub fn label(&self) -> &'static str {
        match self {
            Grade::A => "A",
            Grade::B => "B",
            Grade::C => "C",
            Grade::D => "D",
            Grade::F => "F",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ScoreBreakdown {
    pub maintainer_health: f64,   // 0-25
    pub security_posture: f64,    // 0-25
    pub activity_vitality: f64,   // 0-25
    pub community_trust: f64,     // 0-25
}

#[derive(Debug, Clone, Serialize)]
pub struct ReputationFlag {
    pub flag_type: FlagType,
    pub severity: FlagSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FlagType {
    SingleMaintainer,
    DownloadAnomaly,
    Typosquat,
    NoProvenance,
    UnpatchedVulns,
    Unmaintained,
    NewPackage,
    LowBusFactor,
    MissingLicense,
    NoTests,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum FlagSeverity { Critical, High, Medium, Low, Info }

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/// Compute a reputation score from pre-collected signals.
pub fn compute_score(signals: &PackageSignals) -> ReputationScore {
    let mut flags: Vec<ReputationFlag> = Vec::new();

    // === Maintainer Health (0-25) ===
    let maintainer_score: f64 = {
        let mut s = 0.0_f64;

        match signals.bus_factor {
            0 => {
                flags.push(mk_flag(FlagType::LowBusFactor, FlagSeverity::High,
                    "No known maintainer — effectively unmaintained"));
            }
            1 => {
                flags.push(mk_flag(FlagType::SingleMaintainer, FlagSeverity::Medium,
                    "Single maintainer — high bus factor risk"));
                s += 5.0;
            }
            2 => { s += 10.0; }
            _ => { s += 12.0; }
        }

        if signals.maintainer_has_2fa == Some(true) { s += 5.0; }
        s += (signals.maintainer_active_days_90 as f64 / 90.0 * 8.0).min(8.0);

        s.min(25.0)
    };

    // === Security Posture (0-25) ===
    let security_score: f64 = {
        let mut s = 25.0_f64;

        if signals.unpatched_cves > 0 {
            let penalty = (signals.unpatched_cves as f64 * 5.0).min(15.0);
            flags.push(mk_flag(FlagType::UnpatchedVulns, FlagSeverity::High,
                &format!("{} unpatched CVE(s)", signals.unpatched_cves)));
            s -= penalty;
        }
        if !signals.has_provenance {
            flags.push(mk_flag(FlagType::NoProvenance, FlagSeverity::Low,
                "No build provenance attestation (npm provenance / sigstore)"));
            s -= 3.0;
        }
        if !signals.has_signature { s -= 2.0; }

        if signals.typosquat_suspect {
            flags.push(mk_flag(FlagType::Typosquat, FlagSeverity::Critical,
                "Possible typosquat — name closely resembles a popular package, recently published"));
            s -= 15.0;
        }
        s.clamp(0.0, 25.0)
    };

    // === Activity Vitality (0-25) ===
    let activity_score: f64 = {
        let mut s = 0.0_f64;

        s += match signals.days_since_last_publish {
            0..=30  => 8.0,
            31..=90 => 6.0,
            91..=180 => 4.0,
            181..=365 => 2.0,
            _ => {
                flags.push(mk_flag(FlagType::Unmaintained, FlagSeverity::Medium,
                    &format!("No release in {} days", signals.days_since_last_publish)));
                0.0
            }
        };

        s += (signals.commit_frequency_30d * 2.0).min(8.0);

        s += if signals.issue_response_time_median_hours < 24.0       { 5.0 }
             else if signals.issue_response_time_median_hours < 72.0  { 3.0 }
             else if signals.issue_response_time_median_hours < 168.0 { 1.0 }
             else                                                       { 0.0 };

        if signals.has_ci    { s += 2.0; }
        if signals.has_tests { s += 2.0; }
        else {
            flags.push(mk_flag(FlagType::NoTests, FlagSeverity::Info, "No test suite detected"));
        }

        s.min(25.0)
    };

    // === Community Trust (0-25) ===
    let community_score: f64 = {
        let mut s = 0.0_f64;

        s += match signals.weekly_downloads {
            0..=100          => 2.0,
            101..=1_000      => 5.0,
            1_001..=10_000   => 8.0,
            10_001..=100_000 => 12.0,
            _                => 15.0,
        };

        if signals.download_anomaly_score > 0.7 {
            flags.push(mk_flag(FlagType::DownloadAnomaly, FlagSeverity::High,
                "Unusual download pattern — possible astroturfing or coordinated attack"));
            s -= 5.0;
        }
        if signals.download_trend == Anomalous && signals.download_anomaly_score <= 0.7 {
            s -= 2.0;
        }

        if signals.age_days < 7 {
            flags.push(mk_flag(FlagType::NewPackage, FlagSeverity::Info,
                "Published less than 7 days ago — insufficient history for full scoring"));
        }
        s += match signals.age_days {
            0..=7    => 0.0,
            8..=30   => 2.0,
            31..=365 => 5.0,
            _        => 8.0,
        };

        if signals.has_types { s += 1.0; }
        if signals.license.is_some() { s += 0.5; }
        else {
            flags.push(mk_flag(FlagType::MissingLicense, FlagSeverity::Low,
                "No license declared"));
        }
        if signals.readme_length > 500 { s += 0.5; }

        s.clamp(0.0, 25.0)
    };

    let total_f = maintainer_score + security_score + activity_score + community_score;
    let score = total_f.round().clamp(0.0, 100.0) as u8;

    let grade = match score {
        80..=100 => Grade::A,
        60..=79  => Grade::B,
        40..=59  => Grade::C,
        20..=39  => Grade::D,
        _        => Grade::F,
    };

    ReputationScore {
        package: signals.package.clone(),
        version: signals.version.clone(),
        score,
        grade,
        breakdown: ScoreBreakdown {
            maintainer_health: maintainer_score,
            security_posture: security_score,
            activity_vitality: activity_score,
            community_trust: community_score,
        },
        flags,
        computed_at: unix_timestamp_now(),
    }
}

fn mk_flag(flag_type: FlagType, severity: FlagSeverity, message: &str) -> ReputationFlag {
    ReputationFlag { flag_type, severity, message: message.to_string() }
}

fn unix_timestamp_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intelligence::signals::PackageSignals;

    fn ideal_signals(package: &str) -> PackageSignals {
        PackageSignals {
            package: package.to_string(),
            ecosystem: "npm".to_string(),
            version: "1.0.0".to_string(),
            maintainer_count: 5,
            bus_factor: 3,
            maintainer_active_days_90: 80,
            maintainer_has_2fa: Some(true),
            days_since_last_publish: 15,
            commit_frequency_30d: 4.0,
            has_ci: true,
            has_tests: true,
            issue_response_time_median_hours: 12.0,
            weekly_downloads: 50_000,
            age_days: 730,
            has_provenance: true,
            has_signature: true,
            has_types: true,
            license: Some("MIT".to_string()),
            readme_length: 1000,
            ..Default::default()
        }
    }

    #[test]
    fn ideal_package_scores_high() {
        let sig = ideal_signals("lodash");
        let score = compute_score(&sig);
        assert!(score.score >= 80, "ideal package should score A, got {}", score.score);
        assert_eq!(score.grade, Grade::A);
    }

    #[test]
    fn unpatched_cves_penalize() {
        let mut sig = ideal_signals("vulnerable-pkg");
        sig.unpatched_cves = 3;
        let score = compute_score(&sig);
        let base = compute_score(&ideal_signals("clean-pkg"));
        assert!(score.score < base.score, "vulns should lower score");
        assert!(score.flags.iter().any(|f| f.flag_type == FlagType::UnpatchedVulns));
    }

    #[test]
    fn single_maintainer_flags() {
        let mut sig = ideal_signals("solo-pkg");
        sig.bus_factor = 1;
        sig.maintainer_count = 1;
        let score = compute_score(&sig);
        assert!(score.flags.iter().any(|f| f.flag_type == FlagType::SingleMaintainer));
    }

    #[test]
    fn typosquat_critical_flag() {
        let mut sig = ideal_signals("l0dash");
        sig.typosquat_suspect = true;
        sig.age_days = 5;
        let base_score = compute_score(&ideal_signals("lodash")).score;
        let score = compute_score(&sig);
        assert!(score.flags.iter().any(|f| f.flag_type == FlagType::Typosquat));
        // Typosquat penalty must reduce score compared to clean package
        assert!(
            score.score < base_score,
            "typosquat should lower score (got {} vs base {})", score.score, base_score
        );
    }

    #[test]
    fn unmaintained_package_flagged() {
        let mut sig = ideal_signals("old-pkg");
        sig.days_since_last_publish = 800;
        let score = compute_score(&sig);
        assert!(score.flags.iter().any(|f| f.flag_type == FlagType::Unmaintained));
    }

    #[test]
    fn grade_mapping() {
        assert_eq!(Grade::A.label(), "A");
        assert_eq!(Grade::F.label(), "F");
    }

    #[test]
    fn no_license_flagged() {
        let mut sig = ideal_signals("unlicensed");
        sig.license = None;
        let score = compute_score(&sig);
        assert!(score.flags.iter().any(|f| f.flag_type == FlagType::MissingLicense));
    }
}
