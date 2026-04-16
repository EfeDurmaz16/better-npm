use super::scoring::{DepContext, ScoredVuln, Severity};

/// Filter configuration for smart audit output.
#[derive(Debug, Clone)]
pub struct AuditFilter {
    /// Only show vulnerabilities affecting production deps
    pub prod_only: bool,
    /// Minimum effective score to report (0.0 - 10.0)
    pub min_score: f64,
    /// Exclude dev dependencies entirely
    pub ignore_dev: bool,
    /// Exclude build dependencies
    pub ignore_build: bool,
    /// Only show vulns with available fixes
    pub fixable_only: bool,
    /// Severity floor: only show vulns at or above this level
    pub min_severity: Option<Severity>,
}

impl Default for AuditFilter {
    fn default() -> Self {
        Self {
            prod_only: false,
            min_score: 0.0,
            ignore_dev: false,
            ignore_build: false,
            fixable_only: false,
            min_severity: None,
        }
    }
}

impl AuditFilter {
    /// Parse filter from CLI flags.
    pub fn from_args(
        prod_only: bool,
        min_score: Option<f64>,
        ignore_dev: bool,
        fixable_only: bool,
    ) -> Self {
        let mut f = Self::default();
        f.prod_only = prod_only;
        if let Some(s) = min_score {
            f.min_score = s;
        }
        f.ignore_dev = ignore_dev || prod_only;
        f.ignore_build = prod_only;
        f.fixable_only = fixable_only;
        f
    }

    /// Apply this filter to a list of scored vulnerabilities.
    pub fn apply(&self, vulns: &[ScoredVuln]) -> Vec<ScoredVuln> {
        vulns
            .iter()
            .filter(|v| {
                if self.prod_only
                    && v.context != DepContext::Production
                    && v.context != DepContext::Transitive
                {
                    return false;
                }
                if self.ignore_dev && v.context == DepContext::Dev {
                    return false;
                }
                if self.ignore_build && v.context == DepContext::Build {
                    return false;
                }
                if v.effective_score < self.min_score {
                    return false;
                }
                if self.fixable_only && v.fix_available.is_none() {
                    return false;
                }
                if let Some(ref min_sev) = self.min_severity {
                    if v.severity < *min_sev {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::scoring::score_vuln;

    fn make_vuln(pkg_key: &str, severity: Severity, context: DepContext) -> ScoredVuln {
        let parts: Vec<&str> = pkg_key.splitn(2, '@').collect();
        let name = parts[0].to_string();
        let version = parts.get(1).unwrap_or(&"1.0.0").to_string();
        ScoredVuln {
            id: format!("GHSA-{}", name),
            aliases: vec![],
            summary: format!("Vuln in {}", name),
            severity,
            base_score: severity.base_score(),
            context,
            context_weight: context.weight(),
            effective_score: score_vuln(severity, context),
            package_name: name,
            package_version: version,
            fix_available: Some("999.0.0".to_string()),
        }
    }

    #[test]
    fn prod_only_excludes_dev() {
        let vulns = vec![
            make_vuln("lodash@4.17.21", Severity::High, DepContext::Production),
            make_vuln("jest@29.0.0", Severity::High, DepContext::Dev),
        ];
        let filter = AuditFilter::from_args(true, None, false, false);
        let result = filter.apply(&vulns);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].package_name, "lodash");
    }

    #[test]
    fn min_score_threshold() {
        let vulns = vec![
            make_vuln("a@1.0.0", Severity::Critical, DepContext::Production), // 10.0
            make_vuln("b@1.0.0", Severity::Low, DepContext::Production),      // 1.0
        ];
        let filter = AuditFilter::from_args(false, Some(5.0), false, false);
        let result = filter.apply(&vulns);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].package_name, "a");
    }

    #[test]
    fn fixable_only_filter() {
        let mut vulns = vec![
            make_vuln("a@1.0.0", Severity::High, DepContext::Production),
            make_vuln("b@1.0.0", Severity::High, DepContext::Production),
        ];
        vulns[1].fix_available = None;
        let filter = AuditFilter::from_args(false, None, false, true);
        let result = filter.apply(&vulns);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].package_name, "a");
    }

    #[test]
    fn combined_filters() {
        let vulns = vec![
            make_vuln("a@1.0.0", Severity::Critical, DepContext::Production),  // 10.0
            make_vuln("b@1.0.0", Severity::Low, DepContext::Dev),              // 0.15
            make_vuln("c@1.0.0", Severity::High, DepContext::Transitive),      // 4.2
        ];
        // prod-only + min-score 5.0
        let filter = AuditFilter::from_args(true, Some(5.0), false, false);
        let result = filter.apply(&vulns);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].package_name, "a");
    }

    #[test]
    fn ignore_dev_keeps_build() {
        let vulns = vec![
            make_vuln("webpack@5.0.0", Severity::High, DepContext::Build),
            make_vuln("jest@29.0.0", Severity::High, DepContext::Dev),
            make_vuln("express@4.0.0", Severity::High, DepContext::Production),
        ];
        let filter = AuditFilter::from_args(false, None, true, false);
        let result = filter.apply(&vulns);
        assert_eq!(result.len(), 2);
        let names: Vec<&str> = result.iter().map(|v| v.package_name.as_str()).collect();
        assert!(names.contains(&"webpack"));
        assert!(names.contains(&"express"));
    }

    #[test]
    fn default_filter_keeps_everything() {
        let vulns = vec![
            make_vuln("a@1.0.0", Severity::Low, DepContext::Dev),
            make_vuln("b@1.0.0", Severity::Critical, DepContext::Production),
        ];
        let filter = AuditFilter::default();
        let result = filter.apply(&vulns);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn min_severity_filter() {
        let vulns = vec![
            make_vuln("a@1.0.0", Severity::Critical, DepContext::Production),
            make_vuln("b@1.0.0", Severity::Low, DepContext::Production),
            make_vuln("c@1.0.0", Severity::Medium, DepContext::Production),
        ];
        let mut filter = AuditFilter::default();
        filter.min_severity = Some(Severity::High);
        let result = filter.apply(&vulns);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].package_name, "a");
    }

    #[test]
    fn from_args_prod_only_implies_ignore_dev_and_build() {
        let filter = AuditFilter::from_args(true, None, false, false);
        assert!(filter.ignore_dev);
        assert!(filter.ignore_build);
        assert!(filter.prod_only);
    }
}
