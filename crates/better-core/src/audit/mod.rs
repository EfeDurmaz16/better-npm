pub mod scoring;
pub mod classifier;
pub mod filter;

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::types::*;
use crate::{resolve_from_lockfile, JsonWriter};

pub use scoring::{DepContext, Severity, ScoredVuln, score_vuln};
pub use classifier::DepClassifier;
pub use filter::AuditFilter;

// --- B.8: Security Audit ---

// OSV API response types for serde deserialization
#[derive(serde::Deserialize, Debug)]
pub(crate) struct OsvBatchResponse {
    pub(crate) results: Option<Vec<OsvBatchResult>>,
}

#[derive(serde::Deserialize, Debug)]
pub(crate) struct OsvBatchResult {
    pub(crate) vulns: Option<Vec<OsvVuln>>,
}

#[derive(serde::Deserialize, Debug)]
pub(crate) struct OsvVuln {
    pub(crate) id: Option<String>,
    pub(crate) summary: Option<String>,
    pub(crate) details: Option<String>,
    pub(crate) severity: Option<Vec<OsvSeverity>>,
    pub(crate) affected: Option<Vec<OsvAffected>>,
}

#[derive(serde::Deserialize, Debug)]
#[allow(dead_code)]
pub(crate) struct OsvSeverity {
    #[serde(rename = "type")]
    pub(crate) severity_type: Option<String>,
    pub(crate) score: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
#[allow(dead_code)]
pub(crate) struct OsvAffected {
    pub(crate) package: Option<OsvPackage>,
    pub(crate) ranges: Option<Vec<OsvRange>>,
}

#[derive(serde::Deserialize, Debug)]
#[allow(dead_code)]
pub(crate) struct OsvPackage {
    pub(crate) name: Option<String>,
    pub(crate) ecosystem: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
#[allow(dead_code)]
pub(crate) struct OsvRange {
    #[serde(rename = "type")]
    pub(crate) range_type: Option<String>,
    pub(crate) events: Option<Vec<serde_json::Value>>,
}

pub fn run_audit(lockfile: &Path, _project_root: &Path, min_severity: &str) -> Result<AuditReport, String> {
    let resolve_result = resolve_from_lockfile(lockfile)?;

    // Build OSV batch query
    let mut query = JsonWriter::new();
    query.begin_object();
    query.key("queries");
    query.begin_array();

    // Deduplicate packages
    let mut seen: HashSet<String> = HashSet::new();
    let mut query_count = 0u64;
    for pkg in &resolve_result.packages {
        let key = format!("{}@{}", pkg.name, pkg.version);
        if seen.insert(key) {
            query.begin_object();
            query.key("package");
            query.begin_object();
            query.key("name");
            query.value_string(&pkg.name);
            query.key("ecosystem");
            query.value_string("npm");
            query.end_object();
            query.key("version");
            query.value_string(&pkg.version);
            query.end_object();
            query_count += 1;
        }
    }

    query.end_array();
    query.end_object();
    let body = query.finish();

    // POST to OSV.dev
    let osv_client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let resp = osv_client.post("https://api.osv.dev/v1/querybatch")
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|e| format!("OSV API request failed: {}", e))?;

    let resp_body = resp.text()
        .map_err(|e| format!("Failed to read OSV response: {}", e))?;

    // Parse response using serde_json
    let mut vulns: Vec<AuditVulnerability> = Vec::new();

    let severity_rank = |s: &str| -> u8 {
        match s.to_lowercase().as_str() {
            "critical" => 4,
            "high" => 3,
            "medium" | "moderate" => 2,
            "low" => 1,
            _ => 0,
        }
    };
    let min_rank = severity_rank(min_severity);

    // Build ordered list of unique packages (matches query order)
    let mut pkg_names: Vec<(String, String)> = Vec::new();
    let mut seen2: HashSet<String> = HashSet::new();
    for pkg in &resolve_result.packages {
        let key = format!("{}@{}", pkg.name, pkg.version);
        if seen2.insert(key) {
            pkg_names.push((pkg.name.clone(), pkg.version.clone()));
        }
    }

    let batch_response: OsvBatchResponse = serde_json::from_str(&resp_body)
        .unwrap_or(OsvBatchResponse { results: None });

    if let Some(results) = batch_response.results {
        for (pkg_idx, result) in results.iter().enumerate() {
            let (pkg_name, pkg_version) = if pkg_idx < pkg_names.len() {
                (pkg_names[pkg_idx].0.clone(), pkg_names[pkg_idx].1.clone())
            } else {
                ("unknown".to_string(), "0.0.0".to_string())
            };

            if let Some(ref osv_vulns) = result.vulns {
                for v in osv_vulns {
                    let id = v.id.clone().unwrap_or_default();
                    let summary = v.summary.clone()
                        .or_else(|| v.details.clone())
                        .unwrap_or_else(|| "No description".to_string());

                    // Extract severity from CVSS score or severity array
                    let severity = v.severity.as_ref()
                        .and_then(|sevs| sevs.first())
                        .and_then(|s| s.score.as_ref())
                        .and_then(|score| {
                            // Parse CVSS score to severity label
                            score.parse::<f64>().ok().map(|val| {
                                if val >= 9.0 { "CRITICAL".to_string() }
                                else if val >= 7.0 { "HIGH".to_string() }
                                else if val >= 4.0 { "MEDIUM".to_string() }
                                else { "LOW".to_string() }
                            }).or_else(|| {
                                // Score might be a CVSS vector string; extract base score
                                // e.g. "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
                                // Fall back to checking for severity keywords
                                let upper = score.to_uppercase();
                                if upper.contains("CRITICAL") { Some("CRITICAL".to_string()) }
                                else if upper.contains("HIGH") { Some("HIGH".to_string()) }
                                else if upper.contains("MEDIUM") || upper.contains("MODERATE") { Some("MEDIUM".to_string()) }
                                else { Some("LOW".to_string()) }
                            })
                        })
                        .unwrap_or_else(|| "LOW".to_string());

                    // Extract fixed version from ranges events
                    let fixed = v.affected.as_ref()
                        .and_then(|aff| aff.first())
                        .and_then(|a| a.ranges.as_ref())
                        .and_then(|ranges| ranges.first())
                        .and_then(|r| r.events.as_ref())
                        .and_then(|events| {
                            events.iter().find_map(|ev| {
                                ev.get("fixed").and_then(|f| f.as_str()).map(|s| s.to_string())
                            })
                        })
                        .unwrap_or_default();

                    if severity_rank(&severity) >= min_rank {
                        vulns.push(AuditVulnerability {
                            id,
                            summary,
                            severity: severity.to_uppercase(),
                            package: pkg_name.clone(),
                            version: pkg_version.clone(),
                            fixed,
                        });
                    }
                }
            }
        }
    }

    let total = vulns.len() as u64;
    let critical = vulns.iter().filter(|v| v.severity == "CRITICAL").count() as u64;
    let high = vulns.iter().filter(|v| v.severity == "HIGH").count() as u64;
    let medium = vulns.iter().filter(|v| v.severity == "MEDIUM" || v.severity == "MODERATE").count() as u64;
    let low = vulns.iter().filter(|v| v.severity == "LOW").count() as u64;

    let risk_level = if critical > 0 { "critical" }
        else if high > 0 { "high" }
        else if medium > 0 { "medium" }
        else if low > 0 { "low" }
        else { "none" };

    Ok(AuditReport {
        scanned_packages: query_count,
        vulnerabilities: vulns,
        total, critical, high, medium, low,
        risk_level: risk_level.to_string(),
    })
}

/// Result of a context-aware smart audit.
#[derive(Debug)]
pub struct SmartAuditReport {
    pub total: u64,
    pub filtered: u64,
    pub vulns: Vec<ScoredVuln>,
    pub scanned_packages: u64,
    pub risk_level: String,
}

/// Run a context-aware smart audit.
///
/// Takes the raw audit vulnerabilities + package.json dep maps, classifies each
/// dep by context (prod/dev/build/optional/transitive), scores each vuln by
/// severity x context weight, then applies the given filter.
pub fn smart_audit(
    raw_vulns: &[AuditVulnerability],
    root_deps: &HashMap<String, String>,
    root_dev_deps: &HashMap<String, String>,
    root_optional_deps: &HashMap<String, String>,
    dep_graph: &HashMap<String, Vec<String>>,
    resolved_versions: &HashMap<String, String>,
    audit_filter: &AuditFilter,
) -> SmartAuditReport {
    let classifier = DepClassifier::classify(
        root_deps,
        root_dev_deps,
        root_optional_deps,
        dep_graph,
        resolved_versions,
    );

    let scored: Vec<ScoredVuln> = raw_vulns
        .iter()
        .map(|v| {
            let pkg_key = format!("{}@{}", v.package, v.version);
            let ctx = classifier.get(&pkg_key);
            let sev = Severity::from_str(&v.severity);
            let eff = score_vuln(sev, ctx);
            ScoredVuln {
                id: v.id.clone(),
                aliases: vec![],
                summary: v.summary.clone(),
                severity: sev,
                base_score: sev.base_score(),
                context: ctx,
                context_weight: ctx.weight(),
                effective_score: eff,
                package_name: v.package.clone(),
                package_version: v.version.clone(),
                fix_available: if v.fixed.is_empty() {
                    None
                } else {
                    Some(v.fixed.clone())
                },
            }
        })
        .collect();

    let total = scored.len() as u64;
    let filtered_vulns = audit_filter.apply(&scored);
    let filtered = filtered_vulns.len() as u64;

    let risk_level = if filtered_vulns.iter().any(|v| v.severity == Severity::Critical) {
        "critical"
    } else if filtered_vulns.iter().any(|v| v.severity == Severity::High) {
        "high"
    } else if filtered_vulns.iter().any(|v| v.severity == Severity::Medium) {
        "medium"
    } else if filtered_vulns.iter().any(|v| v.severity == Severity::Low) {
        "low"
    } else {
        "none"
    };

    SmartAuditReport {
        total,
        filtered,
        vulns: filtered_vulns,
        scanned_packages: 0,
        risk_level: risk_level.to_string(),
    }
}

