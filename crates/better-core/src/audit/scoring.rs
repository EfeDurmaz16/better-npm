/// Dependency context — how a package is reachable in the dep graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DepContext {
    /// Listed in `dependencies` and reachable from app entry points
    Production,
    /// Listed in `devDependencies`
    Dev,
    /// Only used in build scripts / bundler plugins
    Build,
    /// Listed in `optionalDependencies`
    Optional,
    /// Not a direct dep — pulled in transitively
    Transitive,
}

impl DepContext {
    /// Weight multiplier for risk scoring.
    /// Production deps have full weight; dev deps are much lower.
    pub fn weight(&self) -> f64 {
        match self {
            Self::Production => 1.0,
            Self::Dev => 0.15,
            Self::Build => 0.2,
            Self::Optional => 0.3,
            Self::Transitive => 0.6,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Dev => "dev",
            Self::Build => "build",
            Self::Optional => "optional",
            Self::Transitive => "transitive",
        }
    }
}

/// CVSS-style severity mapped to numeric score.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Unknown,
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    pub fn base_score(&self) -> f64 {
        match self {
            Self::Critical => 10.0,
            Self::High => 7.0,
            Self::Medium => 4.0,
            Self::Low => 1.0,
            Self::Unknown => 2.0,
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "critical" => Self::Critical,
            "high" => Self::High,
            "medium" | "moderate" => Self::Medium,
            "low" => Self::Low,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Critical => "critical",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
            Self::Unknown => "unknown",
        }
    }
}

/// A single vulnerability with context-aware scoring.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScoredVuln {
    pub id: String,
    pub aliases: Vec<String>,
    pub summary: String,
    pub severity: Severity,
    pub base_score: f64,
    pub context: DepContext,
    pub context_weight: f64,
    pub effective_score: f64,
    pub package_name: String,
    pub package_version: String,
    pub fix_available: Option<String>,
}

/// Calculate effective score: severity_base * context_weight
pub fn score_vuln(severity: Severity, context: DepContext) -> f64 {
    severity.base_score() * context.weight()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prod_critical_scores_10() {
        assert_eq!(score_vuln(Severity::Critical, DepContext::Production), 10.0);
    }

    #[test]
    fn dev_critical_scores_1_5() {
        assert_eq!(score_vuln(Severity::Critical, DepContext::Dev), 1.5);
    }

    #[test]
    fn transitive_high_scores_4_2() {
        let score = score_vuln(Severity::High, DepContext::Transitive);
        assert!((score - 4.2).abs() < f64::EPSILON);
    }

    #[test]
    fn unknown_severity_has_base_2() {
        assert_eq!(Severity::Unknown.base_score(), 2.0);
    }

    #[test]
    fn severity_from_str_case_insensitive() {
        assert_eq!(Severity::from_str("CRITICAL"), Severity::Critical);
        assert_eq!(Severity::from_str("High"), Severity::High);
        assert_eq!(Severity::from_str("moderate"), Severity::Medium);
        assert_eq!(Severity::from_str("garbage"), Severity::Unknown);
    }

    #[test]
    fn context_weights() {
        assert_eq!(DepContext::Production.weight(), 1.0);
        assert_eq!(DepContext::Dev.weight(), 0.15);
        assert_eq!(DepContext::Build.weight(), 0.2);
        assert_eq!(DepContext::Optional.weight(), 0.3);
        assert_eq!(DepContext::Transitive.weight(), 0.6);
    }
}
