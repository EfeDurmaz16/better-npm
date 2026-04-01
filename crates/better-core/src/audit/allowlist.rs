// crates/better-core/src/audit/allowlist.rs
//
// Audit allow-list: per-CVE waivers with optional expiry and package scoping.
// Config file: .betterauditrc.json in project root.

use std::path::Path;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/// Root structure of `.betterauditrc.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditAllowList {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub waivers: Vec<Waiver>,
    #[serde(default, rename = "globalIgnore")]
    pub global_ignore: Option<GlobalIgnore>,
}

fn default_version() -> u32 { 1 }

/// A single waiver entry suppressing one CVE or GHSA advisory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Waiver {
    /// CVE or GHSA identifier, e.g. "GHSA-xxxx-yyyy-zzzz"
    pub id: String,
    /// Human-readable justification (required for --strict)
    #[serde(default)]
    pub reason: String,
    /// Who approved this waiver
    #[serde(default)]
    pub author: String,
    /// ISO-8601 expiry date "YYYY-MM-DD", `None` = permanent
    #[serde(default)]
    pub expires: Option<String>,
    /// Limit waiver to specific "name@version" keys; empty = all packages
    #[serde(default)]
    pub packages: Vec<String>,
    /// ISO date this waiver was created
    #[serde(default)]
    pub created: String,
}

/// Project-wide ignore rules applied before per-CVE matching.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalIgnore {
    /// Context names to ignore globally: "dev", "build", "optional"
    #[serde(default)]
    pub contexts: Vec<String>,
    /// Ignore all vulnerabilities at or below this severity
    #[serde(default, rename = "maxSeverity")]
    pub max_severity: Option<String>,
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/// Outcome of checking a single (vuln_id, package_key) pair.
#[derive(Debug)]
pub enum WaiverResult {
    /// Waiver is active and applicable.
    Waived(Waiver),
    /// Waiver matched but is past its expiry date.
    Expired(Waiver),
    /// No matching waiver found.
    NotWaived,
}

impl WaiverResult {
    pub fn is_suppressed(&self) -> bool {
        matches!(self, WaiverResult::Waived(_))
    }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum AuditAllowListError {
    Io(std::io::Error),
    Json(String),
}

impl std::fmt::Display for AuditAllowListError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O error: {}", e),
            Self::Json(s) => write!(f, "JSON parse error: {}", s),
        }
    }
}

impl From<std::io::Error> for AuditAllowListError {
    fn from(e: std::io::Error) -> Self { Self::Io(e) }
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

impl AuditAllowList {
    /// Load `.betterauditrc.json` from `project_root`.
    /// Returns an empty allow-list if the file does not exist.
    pub fn load(project_root: &Path) -> Result<Self, AuditAllowListError> {
        let path = project_root.join(".betterauditrc.json");
        if !path.exists() {
            return Ok(Self::empty());
        }
        let content = std::fs::read_to_string(&path)?;
        let list: Self = serde_json::from_str(&content)
            .map_err(|e| AuditAllowListError::Json(e.to_string()))?;
        Ok(list)
    }

    /// Check whether a vulnerability is waived for a given package.
    ///
    /// - `vuln_id`: CVE/GHSA identifier from the audit result
    /// - `package_key`: `"name@version"` string
    /// - `today_iso`: today's date as `"YYYY-MM-DD"` (string comparison works
    ///   because ISO dates are lexicographically ordered)
    pub fn is_waived(
        &self,
        vuln_id: &str,
        package_key: &str,
        today_iso: &str,
    ) -> WaiverResult {
        for waiver in &self.waivers {
            if waiver.id != vuln_id {
                continue;
            }
            // Package scope: if non-empty, must match
            if !waiver.packages.is_empty()
                && !waiver.packages.iter().any(|p| p == package_key)
            {
                continue;
            }
            // Expiry check — lexicographic ISO comparison
            if let Some(ref exp) = waiver.expires {
                if !exp.is_empty() && today_iso > exp.as_str() {
                    return WaiverResult::Expired(waiver.clone());
                }
            }
            return WaiverResult::Waived(waiver.clone());
        }
        WaiverResult::NotWaived
    }

    /// Check whether a context name (e.g. "dev") is globally ignored.
    pub fn is_context_globally_ignored(&self, context: &str) -> bool {
        self.global_ignore
            .as_ref()
            .map(|g| g.contexts.iter().any(|c| c == context))
            .unwrap_or(false)
    }

    /// Returns the global max-severity ceiling, if set.
    pub fn global_max_severity(&self) -> Option<&str> {
        self.global_ignore
            .as_ref()
            .and_then(|g| g.max_severity.as_deref())
    }

    /// Add or update a waiver in memory (call `save()` to persist).
    pub fn add_waiver(&mut self, waiver: Waiver) {
        // Replace existing waiver with the same id, otherwise append.
        if let Some(pos) = self.waivers.iter().position(|w| w.id == waiver.id) {
            self.waivers[pos] = waiver;
        } else {
            self.waivers.push(waiver);
        }
    }

    /// Persist this allow-list to `.betterauditrc.json` in `project_root`.
    pub fn save(&self, project_root: &Path) -> Result<(), AuditAllowListError> {
        let path = project_root.join(".betterauditrc.json");
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| AuditAllowListError::Json(e.to_string()))?;
        std::fs::write(&path, json + "\n")?;
        Ok(())
    }

    /// Validate for --strict mode:
    /// - Every waiver must have a non-empty `reason`
    /// - Every waiver must have an `expires` date
    /// Returns a list of validation error strings (empty = valid).
    pub fn validate_strict(&self) -> Vec<String> {
        let mut errors = Vec::new();
        for w in &self.waivers {
            if w.reason.trim().is_empty() {
                errors.push(format!("{}: missing `reason`", w.id));
            }
            if w.expires.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                errors.push(format!("{}: missing `expires` date", w.id));
            }
        }
        errors
    }

    /// Return waivers whose expiry date is in the past.
    pub fn expired_waivers(&self, today_iso: &str) -> Vec<&Waiver> {
        self.waivers
            .iter()
            .filter(|w| {
                w.expires
                    .as_deref()
                    .map(|e| !e.is_empty() && today_iso > e)
                    .unwrap_or(false)
            })
            .collect()
    }

    pub fn empty() -> Self {
        Self {
            version: 1,
            waivers: vec![],
            global_ignore: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_waiver(id: &str, expires: Option<&str>, packages: Vec<&str>) -> Waiver {
        Waiver {
            id: id.to_string(),
            reason: "test".to_string(),
            author: "tester".to_string(),
            expires: expires.map(|s| s.to_string()),
            packages: packages.into_iter().map(String::from).collect(),
            created: "2026-01-01".to_string(),
        }
    }

    fn make_list(waivers: Vec<Waiver>) -> AuditAllowList {
        AuditAllowList { version: 1, waivers, global_ignore: None }
    }

    #[test]
    fn matching_cve_is_waived() {
        let list = make_list(vec![
            make_waiver("GHSA-test-0001", None, vec![]),
        ]);
        assert!(list.is_waived("GHSA-test-0001", "lodash@4.17.21", "2026-04-01").is_suppressed());
    }

    #[test]
    fn non_matching_cve_not_waived() {
        let list = make_list(vec![
            make_waiver("GHSA-test-0001", None, vec![]),
        ]);
        assert!(matches!(
            list.is_waived("GHSA-other-9999", "lodash@4.17.21", "2026-04-01"),
            WaiverResult::NotWaived
        ));
    }

    #[test]
    fn expired_waiver_detected() {
        let list = make_list(vec![
            make_waiver("GHSA-expired", Some("2026-01-01"), vec![]),
        ]);
        assert!(matches!(
            list.is_waived("GHSA-expired", "pkg@1.0.0", "2026-04-01"),
            WaiverResult::Expired(_)
        ));
    }

    #[test]
    fn future_expiry_still_waived() {
        let list = make_list(vec![
            make_waiver("GHSA-future", Some("2027-12-31"), vec![]),
        ]);
        assert!(list.is_waived("GHSA-future", "pkg@1.0.0", "2026-04-01").is_suppressed());
    }

    #[test]
    fn package_scoped_waiver_matches() {
        let list = make_list(vec![
            make_waiver("GHSA-scoped", None, vec!["lodash@4.17.21"]),
        ]);
        assert!(list.is_waived("GHSA-scoped", "lodash@4.17.21", "2026-04-01").is_suppressed());
        assert!(matches!(
            list.is_waived("GHSA-scoped", "other@1.0.0", "2026-04-01"),
            WaiverResult::NotWaived
        ));
    }

    #[test]
    fn validate_strict_catches_missing_fields() {
        let mut list = make_list(vec![
            make_waiver("GHSA-bad", None, vec![]),
        ]);
        list.waivers[0].reason = String::new();
        let errors = list.validate_strict();
        assert!(!errors.is_empty());
        assert!(errors[0].contains("reason"));
    }

    #[test]
    fn expired_waivers_list() {
        let list = make_list(vec![
            make_waiver("GHSA-past", Some("2025-01-01"), vec![]),
            make_waiver("GHSA-future", Some("2027-01-01"), vec![]),
        ]);
        let expired = list.expired_waivers("2026-04-01");
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].id, "GHSA-past");
    }

    #[test]
    fn global_context_ignore() {
        let list = AuditAllowList {
            version: 1,
            waivers: vec![],
            global_ignore: Some(GlobalIgnore {
                contexts: vec!["dev".to_string(), "build".to_string()],
                max_severity: None,
            }),
        };
        assert!(list.is_context_globally_ignored("dev"));
        assert!(!list.is_context_globally_ignored("production"));
    }

    #[test]
    fn add_waiver_replaces_existing() {
        let mut list = make_list(vec![
            make_waiver("GHSA-replace", Some("2026-06-01"), vec![]),
        ]);
        let new_waiver = Waiver {
            id: "GHSA-replace".to_string(),
            reason: "updated reason".to_string(),
            author: "new-author".to_string(),
            expires: Some("2027-06-01".to_string()),
            packages: vec![],
            created: "2026-04-01".to_string(),
        };
        list.add_waiver(new_waiver);
        assert_eq!(list.waivers.len(), 1);
        assert_eq!(list.waivers[0].expires.as_deref(), Some("2027-06-01"));
    }
}
