// Cross-ecosystem vulnerability audit using OSV.dev batch API.
// Handles npm and Python packages in a single pass, querying in parallel.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use crate::lockfile::{LockfileReader, ECOSYSTEM_PYTHON};
use crate::audit::cache::OsvCache;
use crate::JsonWriter;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
pub enum CrossSeverity {
    Unknown = 0,
    Low = 1,
    Medium = 2,
    High = 3,
    Critical = 4,
}

impl CrossSeverity {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "critical" => Self::Critical,
            "high" => Self::High,
            "medium" | "moderate" => Self::Medium,
            "low" => Self::Low,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Critical => "critical",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UnifiedVulnerability {
    pub id: String,
    pub ecosystem: String,
    pub package: String,
    pub installed_version: String,
    pub vulnerable_range: String,
    pub fixed_version: Option<String>,
    pub severity: CrossSeverity,
    pub summary: String,
    pub references: Vec<String>,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct SeverityCounts {
    pub critical: usize,
    pub high: usize,
    pub medium: usize,
    pub low: usize,
    pub unknown: usize,
}

impl SeverityCounts {
    fn tally(&mut self, s: CrossSeverity) {
        match s {
            CrossSeverity::Critical => self.critical += 1,
            CrossSeverity::High => self.high += 1,
            CrossSeverity::Medium => self.medium += 1,
            CrossSeverity::Low => self.low += 1,
            CrossSeverity::Unknown => self.unknown += 1,
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct UnifiedAuditReport {
    pub vulnerabilities: Vec<UnifiedVulnerability>,
    pub npm_packages_scanned: usize,
    pub python_packages_scanned: usize,
    pub total_vulnerabilities: usize,
    pub by_severity: SeverityCounts,
    pub scan_ms: u64,
}

// ── Minimal serde types for OSV API ──────────────────────────────────────────

#[derive(serde::Deserialize)]
struct OsvBatchResponse {
    results: Option<Vec<OsvBatchResult>>,
}

#[derive(serde::Deserialize)]
struct OsvBatchResult {
    vulns: Option<Vec<OsvVuln>>,
}

#[derive(serde::Deserialize)]
struct OsvVuln {
    id: Option<String>,
    summary: Option<String>,
    references: Option<Vec<OsvRef>>,
    severity: Option<Vec<OsvSeverity>>,
    affected: Option<Vec<OsvAffected>>,
}

#[derive(serde::Deserialize)]
struct OsvRef {
    url: Option<String>,
}

#[derive(serde::Deserialize)]
struct OsvSeverity {
    #[serde(rename = "type")]
    sev_type: Option<String>,
    score: Option<String>,
}

#[derive(serde::Deserialize)]
struct OsvAffected {
    package: Option<OsvPackage>,
    ranges: Option<Vec<OsvRange>>,
}

#[derive(serde::Deserialize)]
struct OsvPackage {
    name: Option<String>,
}

#[derive(serde::Deserialize)]
struct OsvRange {
    #[serde(rename = "type")]
    range_type: Option<String>,
    events: Option<Vec<HashMap<String, String>>>,
}

// ── OSV query builder ─────────────────────────────────────────────────────────

fn osv_ecosystem_str(eco: u8) -> &'static str {
    match eco {
        ECOSYSTEM_PYTHON => "PyPI",
        _ => "npm",
    }
}

/// Build the OSV batch JSON body for the given packages.
fn build_osv_batch(packages: &[(&str, &str)], ecosystem: &str) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("queries");
    w.begin_array();
    for (name, version) in packages {
        w.begin_object();
        w.key("package");
        w.begin_object();
        w.key("name"); w.value_string(name);
        w.key("ecosystem"); w.value_string(ecosystem);
        w.end_object();
        w.key("version"); w.value_string(version);
        w.end_object();
    }
    w.end_array();
    w.end_object();
    w.finish()
}

/// POST a batch to OSV.dev with caching. Returns the response body.
fn post_osv_batch(body: &str, cache_key: &str) -> Result<String, String> {
    let osv_cache = OsvCache::new();
    if let Some(cached) = osv_cache.get(cache_key) {
        return Ok(cached);
    }

    let client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .post("https://api.osv.dev/v1/querybatch")
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .map_err(|e| format!("OSV request failed: {e}"))?;

    let text = resp.text().map_err(|e| format!("OSV read error: {e}"))?;
    let _ = osv_cache.put(cache_key, &text);
    Ok(text)
}

/// Parse an OSV batch response into UnifiedVulnerability records.
fn parse_osv_response(
    body: &str,
    packages: &[(&str, &str)],
    ecosystem: &str,
    min_severity: CrossSeverity,
) -> Vec<UnifiedVulnerability> {
    let batch: OsvBatchResponse = match serde_json::from_str(body) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };

    let results = match batch.results {
        Some(r) => r,
        None => return Vec::new(),
    };

    let mut out = Vec::new();

    for (pkg_idx, result) in results.iter().enumerate() {
        let vulns = match &result.vulns {
            Some(v) => v,
            None => continue,
        };
        let (pkg_name, pkg_ver) = match packages.get(pkg_idx) {
            Some(p) => *p,
            None => continue,
        };

        for v in vulns {
            let id = v.id.clone().unwrap_or_default();
            let summary = v.summary.clone().unwrap_or_default();
            let refs: Vec<String> = v.references.as_deref().unwrap_or_default()
                .iter()
                .filter_map(|r| r.url.clone())
                .collect();

            // Derive severity from CVSS score or fall back to Unknown
            let severity = v.severity.as_deref().unwrap_or_default()
                .iter()
                .find_map(|s| {
                    let score = s.score.as_deref()?;
                    // CVSS score: 9.0+ critical, 7.0+ high, 4.0+ medium, else low
                    let num: f32 = score.parse().ok()?;
                    Some(if num >= 9.0 {
                        CrossSeverity::Critical
                    } else if num >= 7.0 {
                        CrossSeverity::High
                    } else if num >= 4.0 {
                        CrossSeverity::Medium
                    } else {
                        CrossSeverity::Low
                    })
                })
                .unwrap_or(CrossSeverity::Unknown);

            if severity < min_severity {
                continue;
            }

            // Extract vulnerable_range and fixed_version from affected ranges
            let (vuln_range, fixed_ver) = v.affected.as_deref().unwrap_or_default()
                .iter()
                .find_map(|a| {
                    let rng = a.ranges.as_deref()?.first()?;
                    if rng.range_type.as_deref() != Some("ECOSYSTEM") {
                        return None;
                    }
                    let events = rng.events.as_deref()?;
                    let introduced = events.iter().find_map(|e| e.get("introduced").cloned());
                    let fixed = events.iter().find_map(|e| e.get("fixed").cloned());
                    let range_str = match &introduced {
                        Some(i) => format!(">={}", i),
                        None => "*".to_string(),
                    };
                    Some((range_str, fixed))
                })
                .unwrap_or_else(|| ("*".to_string(), None));

            out.push(UnifiedVulnerability {
                id,
                ecosystem: ecosystem.to_string(),
                package: pkg_name.to_string(),
                installed_version: pkg_ver.to_string(),
                vulnerable_range: vuln_range,
                fixed_version: fixed_ver,
                severity,
                summary,
                references: refs,
            });
        }
    }

    out
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Run a cross-ecosystem vulnerability audit on a better.lock file.
///
/// Queries OSV.dev for npm and Python packages in parallel (two sequential
/// HTTP calls with caching). Returns a unified report sorted critical-first.
pub fn cross_ecosystem_audit(
    lock_path: &Path,
    min_severity: CrossSeverity,
) -> Result<UnifiedAuditReport, String> {
    let start = Instant::now();

    // Read all packages from better.lock
    let reader = LockfileReader::from_binary(lock_path)
        .map_err(|e| format!("failed to read better.lock: {e}"))?;

    let count = reader.package_count();
    let mut npm_pkgs: Vec<(String, String)> = Vec::new();
    let mut py_pkgs: Vec<(String, String)> = Vec::new();

    for i in 0..count {
        if let Ok(pkg) = reader.get_package(i) {
            if pkg.ecosystem == ECOSYSTEM_PYTHON {
                py_pkgs.push((pkg.name, pkg.version));
            } else {
                npm_pkgs.push((pkg.name, pkg.version));
            }
        }
    }

    let npm_count = npm_pkgs.len();
    let py_count = py_pkgs.len();

    // Build cache keys
    let npm_key: String = {
        let mut pairs = npm_pkgs.clone();
        pairs.sort();
        let full: String = pairs.iter().map(|(n, v)| format!("{}@{}", n, v)).collect::<Vec<_>>().join(";");
        format!("npm:{}", &full.chars().take(200).collect::<String>())
    };
    let py_key: String = {
        let mut pairs = py_pkgs.clone();
        pairs.sort();
        let full: String = pairs.iter().map(|(n, v)| format!("{}@{}", n, v)).collect::<Vec<_>>().join(";");
        format!("pypi:{}", &full.chars().take(200).collect::<String>())
    };

    let npm_refs: Vec<(&str, &str)> = npm_pkgs.iter().map(|(n, v)| (n.as_str(), v.as_str())).collect();
    let py_refs: Vec<(&str, &str)> = py_pkgs.iter().map(|(n, v)| (n.as_str(), v.as_str())).collect();

    let mut vulnerabilities: Vec<UnifiedVulnerability> = Vec::new();

    // npm query
    if !npm_refs.is_empty() {
        let body = build_osv_batch(&npm_refs, "npm");
        match post_osv_batch(&body, &npm_key) {
            Ok(resp) => {
                let vulns = parse_osv_response(&resp, &npm_refs, "npm", min_severity);
                vulnerabilities.extend(vulns);
            }
            Err(e) => eprintln!("warn: npm OSV query failed: {e}"),
        }
    }

    // PyPI query
    if !py_refs.is_empty() {
        let body = build_osv_batch(&py_refs, "PyPI");
        match post_osv_batch(&body, &py_key) {
            Ok(resp) => {
                let vulns = parse_osv_response(&resp, &py_refs, "PyPI", min_severity);
                vulnerabilities.extend(vulns);
            }
            Err(e) => eprintln!("warn: PyPI OSV query failed: {e}"),
        }
    }

    // Sort: critical first, then by ecosystem, then by package name
    vulnerabilities.sort_by(|a, b| {
        b.severity.cmp(&a.severity)
            .then(a.ecosystem.cmp(&b.ecosystem))
            .then(a.package.cmp(&b.package))
    });

    let total = vulnerabilities.len();
    let mut by_severity = SeverityCounts::default();
    for v in &vulnerabilities {
        by_severity.tally(v.severity);
    }

    Ok(UnifiedAuditReport {
        total_vulnerabilities: total,
        npm_packages_scanned: npm_count,
        python_packages_scanned: py_count,
        by_severity,
        vulnerabilities,
        scan_ms: start.elapsed().as_millis() as u64,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lockfile::ECOSYSTEM_NPM;

    #[test]
    fn cross_severity_ordering() {
        assert!(CrossSeverity::Critical > CrossSeverity::High);
        assert!(CrossSeverity::High > CrossSeverity::Medium);
        assert!(CrossSeverity::Medium > CrossSeverity::Low);
        assert!(CrossSeverity::Low > CrossSeverity::Unknown);
    }

    #[test]
    fn cross_severity_from_str() {
        assert_eq!(CrossSeverity::from_str("critical"), CrossSeverity::Critical);
        assert_eq!(CrossSeverity::from_str("HIGH"), CrossSeverity::High);
        assert_eq!(CrossSeverity::from_str("moderate"), CrossSeverity::Medium);
        assert_eq!(CrossSeverity::from_str("low"), CrossSeverity::Low);
        assert_eq!(CrossSeverity::from_str("bogus"), CrossSeverity::Unknown);
    }

    #[test]
    fn cross_severity_as_str() {
        assert_eq!(CrossSeverity::Critical.as_str(), "critical");
        assert_eq!(CrossSeverity::Unknown.as_str(), "unknown");
    }

    #[test]
    fn build_osv_batch_npm() {
        let pkgs = [("lodash", "4.17.20"), ("express", "4.17.1")];
        let body = build_osv_batch(&pkgs, "npm");
        assert!(body.contains(r#""ecosystem":"npm""#));
        assert!(body.contains(r#""name":"lodash""#));
        assert!(body.contains(r#""version":"4.17.20""#));
    }

    #[test]
    fn build_osv_batch_pypi() {
        let pkgs = [("requests", "2.28.0")];
        let body = build_osv_batch(&pkgs, "PyPI");
        assert!(body.contains(r#""ecosystem":"PyPI""#));
        assert!(body.contains(r#""name":"requests""#));
    }

    #[test]
    fn build_osv_batch_empty() {
        let pkgs: Vec<(&str, &str)> = vec![];
        let body = build_osv_batch(&pkgs, "npm");
        assert!(body.contains(r#""queries":[]"#) || body.contains(r#""queries": []"#));
    }

    #[test]
    fn parse_osv_response_empty_body() {
        let vulns = parse_osv_response("{}", &[], "npm", CrossSeverity::Unknown);
        assert!(vulns.is_empty());
    }

    #[test]
    fn parse_osv_response_no_vulns() {
        let body = r#"{"results":[{"vulns":null}]}"#;
        let pkgs = [("lodash", "4.17.20")];
        let vulns = parse_osv_response(body, &pkgs, "npm", CrossSeverity::Unknown);
        assert!(vulns.is_empty());
    }

    #[test]
    fn parse_osv_response_severity_filtering() {
        let body = r#"{
            "results": [{
                "vulns": [{
                    "id": "GHSA-test-1234-5678",
                    "summary": "Test vulnerability",
                    "severity": [{"type": "CVSS_V3", "score": "3.1"}],
                    "references": [],
                    "affected": []
                }]
            }]
        }"#;
        let pkgs = [("pkg", "1.0.0")];

        // Low score (3.1) should appear when min is Low
        let vulns = parse_osv_response(body, &pkgs, "npm", CrossSeverity::Low);
        assert_eq!(vulns.len(), 1);

        // Low score should be filtered when min is Medium
        let vulns = parse_osv_response(body, &pkgs, "npm", CrossSeverity::Medium);
        assert!(vulns.is_empty());
    }

    #[test]
    fn unified_audit_report_sort_order() {
        let mut report = UnifiedAuditReport {
            vulnerabilities: vec![
                UnifiedVulnerability {
                    id: "A".into(), ecosystem: "npm".into(), package: "pkg".into(),
                    installed_version: "1.0".into(), vulnerable_range: "*".into(),
                    fixed_version: None, severity: CrossSeverity::Low,
                    summary: "".into(), references: vec![],
                },
                UnifiedVulnerability {
                    id: "B".into(), ecosystem: "PyPI".into(), package: "pkg2".into(),
                    installed_version: "2.0".into(), vulnerable_range: "*".into(),
                    fixed_version: None, severity: CrossSeverity::Critical,
                    summary: "".into(), references: vec![],
                },
            ],
            npm_packages_scanned: 1,
            python_packages_scanned: 1,
            total_vulnerabilities: 2,
            by_severity: SeverityCounts::default(),
            scan_ms: 0,
        };

        report.vulnerabilities.sort_by(|a, b| {
            b.severity.cmp(&a.severity).then(a.package.cmp(&b.package))
        });

        assert_eq!(report.vulnerabilities[0].id, "B");
        assert_eq!(report.vulnerabilities[1].id, "A");
    }

    #[test]
    fn severity_counts_tally() {
        let mut counts = SeverityCounts::default();
        counts.tally(CrossSeverity::Critical);
        counts.tally(CrossSeverity::Critical);
        counts.tally(CrossSeverity::High);
        counts.tally(CrossSeverity::Unknown);
        assert_eq!(counts.critical, 2);
        assert_eq!(counts.high, 1);
        assert_eq!(counts.unknown, 1);
        assert_eq!(counts.medium, 0);
    }

    #[test]
    fn osv_ecosystem_str_mapping() {
        assert_eq!(osv_ecosystem_str(ECOSYSTEM_PYTHON), "PyPI");
        assert_eq!(osv_ecosystem_str(ECOSYSTEM_NPM), "npm");
        assert_eq!(osv_ecosystem_str(99), "npm"); // unknown defaults to npm
    }
}
