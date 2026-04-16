use std::fs;
use std::path::Path;
use std::time::SystemTime;

use crate::JsonWriter;

// --- Audit allow-listing with CVE waivers ---

#[derive(Debug, Clone)]
pub struct AuditIgnoreEntry {
    pub id: String,
    pub reason: String,
    pub expires: Option<String>, // ISO date: "2026-06-01"
}

#[derive(Debug, Clone)]
pub struct AuditConfig {
    pub ignore: Vec<AuditIgnoreEntry>,
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self { ignore: Vec::new() }
    }
}

/// Load `.betterauditrc.json` from project root.
pub fn load_audit_config(project_root: &Path) -> AuditConfig {
    let config_path = project_root.join(".betterauditrc.json");
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return AuditConfig::default(),
    };
    parse_audit_config(&content)
}

fn parse_audit_config(json: &str) -> AuditConfig {
    let entries = extract_ignore_entries(json);
    AuditConfig { ignore: entries }
}

fn extract_ignore_entries(json: &str) -> Vec<AuditIgnoreEntry> {
    let mut entries = Vec::new();

    // Find "ignore" array
    let needle = "\"ignore\"";
    let start = match json.find(needle) {
        Some(pos) => pos,
        None => return entries,
    };
    let after = &json[start + needle.len()..];
    let arr_start = match after.find('[') {
        Some(pos) => pos,
        None => return entries,
    };
    let section = &after[arr_start..];

    // Find each object in the array
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut obj_start: Option<usize> = None;

    for (i, ch) in section.char_indices() {
        if esc { esc = false; continue; }
        if ch == '\\' && in_str { esc = true; continue; }
        if ch == '"' { in_str = !in_str; continue; }
        if in_str { continue; }
        match ch {
            '[' => { depth += 1; }
            ']' => {
                depth -= 1;
                if depth == 0 { break; }
            }
            '{' => {
                depth += 1;
                if depth == 2 { obj_start = Some(i); }
            }
            '}' => {
                if depth == 2 {
                    if let Some(start) = obj_start {
                        let obj_str = &section[start..=i];
                        let id = extract_field(obj_str, "id").unwrap_or_default();
                        let reason = extract_field(obj_str, "reason").unwrap_or_default();
                        let expires = extract_field(obj_str, "expires");
                        if !id.is_empty() {
                            entries.push(AuditIgnoreEntry { id, reason, expires });
                        }
                    }
                    obj_start = None;
                }
                depth -= 1;
            }
            _ => {}
        }
    }

    entries
}

fn extract_field(json: &str, field_name: &str) -> Option<String> {
    let needle = format!("\"{}\"", field_name);
    let start = json.find(&needle)?;
    let after = &json[start + needle.len()..];
    let colon = after.find(':')?;
    let mut rest = after[colon + 1..].trim_start();
    if !rest.starts_with('"') { return None; }
    rest = &rest[1..];
    let mut result = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => {
                if let Some(esc) = chars.next() {
                    result.push(match esc {
                        '"' => '"', '\\' => '\\', 'n' => '\n',
                        'r' => '\r', 't' => '\t', other => other,
                    });
                }
            }
            other => result.push(other),
        }
    }
    if result.is_empty() { None } else { Some(result) }
}

/// Check if a waiver has expired based on current date.
fn is_expired(expires: &str) -> bool {
    // Parse "YYYY-MM-DD" and compare with current date
    let parts: Vec<&str> = expires.split('-').collect();
    if parts.len() != 3 { return false; }
    let (y, m, d) = match (parts[0].parse::<u64>(), parts[1].parse::<u64>(), parts[2].parse::<u64>()) {
        (Ok(y), Ok(m), Ok(d)) => (y, m, d),
        _ => return false,
    };

    // Get current date as days since epoch (rough but sufficient)
    let expire_days = y * 365 + (y / 4) + m * 30 + d;

    let now_secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let now_days_epoch = now_secs / 86400;
    // Convert epoch days to comparable format
    let now_year = 1970 + now_days_epoch / 365;
    let remaining = now_days_epoch % 365;
    let now_month = remaining / 30 + 1;
    let now_day = remaining % 30 + 1;
    let now_comparable = now_year * 365 + (now_year / 4) + now_month * 30 + now_day;

    now_comparable > expire_days
}

/// Filter audit vulnerabilities, removing ignored CVEs.
/// Returns (filtered_vulns, ignored_count, expired_warnings).
pub fn filter_ignored_vulns(
    vulns: &[crate::AuditVulnerability],
    config: &AuditConfig,
) -> (Vec<crate::AuditVulnerability>, u64, Vec<String>) {
    let mut filtered = Vec::new();
    let mut ignored_count = 0u64;
    let mut expired_warnings = Vec::new();

    for vuln in vulns {
        if let Some(entry) = config.ignore.iter().find(|e| e.id == vuln.id) {
            // Check if waiver has expired
            if let Some(ref exp) = entry.expires {
                if is_expired(exp) {
                    expired_warnings.push(format!(
                        "Waiver for {} expired on {} (reason: {})",
                        entry.id, exp, entry.reason
                    ));
                    filtered.push(vuln.clone());
                    continue;
                }
            }
            ignored_count += 1;
        } else {
            filtered.push(vuln.clone());
        }
    }

    (filtered, ignored_count, expired_warnings)
}

/// Add a new ignore entry to `.betterauditrc.json`.
pub fn add_audit_ignore(project_root: &Path, cve_id: &str, reason: &str) -> Result<String, String> {
    let config_path = project_root.join(".betterauditrc.json");
    let mut config = load_audit_config(project_root);

    // Check if already exists
    if config.ignore.iter().any(|e| e.id == cve_id) {
        return Err(format!("{} is already in the ignore list", cve_id));
    }

    config.ignore.push(AuditIgnoreEntry {
        id: cve_id.to_string(),
        reason: reason.to_string(),
        expires: None,
    });

    write_audit_config(&config_path, &config)?;
    Ok(config_path.to_string_lossy().to_string())
}

fn write_audit_config(path: &Path, config: &AuditConfig) -> Result<(), String> {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("ignore");
    w.begin_array();
    for entry in &config.ignore {
        w.begin_object();
        w.key("id"); w.value_string(&entry.id);
        w.key("reason"); w.value_string(&entry.reason);
        if let Some(ref exp) = entry.expires {
            w.key("expires"); w.value_string(exp);
        }
        w.end_object();
    }
    w.end_array();
    w.end_object();
    w.out.push('\n');
    fs::write(path, w.finish()).map_err(|e| format!("Failed to write audit config: {}", e))
}

/// Run audit with allow-listing support.
/// Returns the report with ignored vulns filtered out (unless --strict).
pub fn run_audit_with_config(
    lockfile: &Path,
    project_root: &Path,
    min_severity: &str,
    strict: bool,
) -> Result<AuditReportWithConfig, String> {
    let report = crate::run_audit(lockfile, project_root, min_severity)?;
    let config = load_audit_config(project_root);

    let (filtered, ignored_count, expired_warnings) =
        filter_ignored_vulns(&report.vulnerabilities, &config);

    // In strict mode, any non-ignored vulnerability is a failure
    let strict_fail = strict && !filtered.is_empty();

    let total = filtered.len() as u64;
    let critical = filtered.iter().filter(|v| v.severity == "CRITICAL").count() as u64;
    let high = filtered.iter().filter(|v| v.severity == "HIGH").count() as u64;
    let medium = filtered.iter().filter(|v| v.severity == "MEDIUM" || v.severity == "MODERATE").count() as u64;
    let low = filtered.iter().filter(|v| v.severity == "LOW").count() as u64;

    let risk_level = if critical > 0 { "critical" }
        else if high > 0 { "high" }
        else if medium > 0 { "medium" }
        else if low > 0 { "low" }
        else { "none" };

    Ok(AuditReportWithConfig {
        scanned_packages: report.scanned_packages,
        vulnerabilities: filtered,
        total, critical, high, medium, low,
        risk_level: risk_level.to_string(),
        ignored_count,
        expired_warnings,
        strict_fail,
    })
}

pub struct AuditReportWithConfig {
    pub scanned_packages: u64,
    pub vulnerabilities: Vec<crate::AuditVulnerability>,
    pub total: u64,
    pub critical: u64,
    pub high: u64,
    pub medium: u64,
    pub low: u64,
    pub risk_level: String,
    pub ignored_count: u64,
    pub expired_warnings: Vec<String>,
    pub strict_fail: bool,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AuditVulnerability;

    fn vuln(id: &str) -> AuditVulnerability {
        AuditVulnerability {
            id: id.to_string(),
            summary: "test vulnerability".to_string(),
            severity: "HIGH".to_string(),
            package: "some-pkg".to_string(),
            version: "1.0.0".to_string(),
            fixed: "2.0.0".to_string(),
        }
    }

    #[test]
    fn missing_config_file_returns_default() {
        let config = load_audit_config(std::path::Path::new("/nonexistent-audit-dir"));
        assert!(config.ignore.is_empty());
    }

    #[test]
    fn parse_single_ignore_entry() {
        let json = r#"{"ignore":[{"id":"CVE-2024-0001","reason":"not affected"}]}"#;
        let mut c = AuditConfig::default();
        c = parse_audit_config(json);
        assert_eq!(c.ignore.len(), 1);
        assert_eq!(c.ignore[0].id, "CVE-2024-0001");
        assert_eq!(c.ignore[0].reason, "not affected");
        assert!(c.ignore[0].expires.is_none());
    }

    #[test]
    fn parse_ignore_entry_with_expiry() {
        let json = r#"{"ignore":[{"id":"CVE-2024-0002","reason":"patched","expires":"2030-01-01"}]}"#;
        let c = parse_audit_config(json);
        assert_eq!(c.ignore.len(), 1);
        assert_eq!(c.ignore[0].expires.as_deref(), Some("2030-01-01"));
    }

    #[test]
    fn filter_ignored_vulns_removes_matching_cve() {
        let mut config = AuditConfig::default();
        config.ignore.push(AuditIgnoreEntry {
            id: "CVE-2024-0001".to_string(),
            reason: "test".to_string(),
            expires: None,
        });
        let vulns = vec![vuln("CVE-2024-0001"), vuln("CVE-2024-9999")];
        let (filtered, ignored_count, warnings) = filter_ignored_vulns(&vulns, &config);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "CVE-2024-9999");
        assert_eq!(ignored_count, 1);
        assert!(warnings.is_empty());
    }

    #[test]
    fn filter_expired_waiver_keeps_vuln() {
        let mut config = AuditConfig::default();
        config.ignore.push(AuditIgnoreEntry {
            id: "CVE-2020-0001".to_string(),
            reason: "old waiver".to_string(),
            expires: Some("2020-01-01".to_string()), // expired
        });
        let vulns = vec![vuln("CVE-2020-0001")];
        let (filtered, ignored_count, warnings) = filter_ignored_vulns(&vulns, &config);
        assert_eq!(filtered.len(), 1); // vuln kept because waiver expired
        assert_eq!(ignored_count, 0);
        assert!(!warnings.is_empty());
    }

    #[test]
    fn add_audit_ignore_writes_and_reads_back() {
        let tmp = std::env::temp_dir().join("audit-config-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let _ = std::fs::remove_file(tmp.join(".betterauditrc.json"));
        add_audit_ignore(&tmp, "CVE-2024-1234", "test reason").unwrap();
        let config = load_audit_config(&tmp);
        assert!(config.ignore.iter().any(|e| e.id == "CVE-2024-1234"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn add_audit_ignore_twice_returns_error() {
        let tmp = std::env::temp_dir().join("audit-config-test-dup");
        std::fs::create_dir_all(&tmp).unwrap();
        add_audit_ignore(&tmp, "CVE-2024-5555", "reason").unwrap();
        let result = add_audit_ignore(&tmp, "CVE-2024-5555", "reason again");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already in the ignore list"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn is_expired_past_date_returns_true() {
        assert!(is_expired("2020-01-01"));
    }

    #[test]
    fn is_expired_future_date_returns_false() {
        assert!(!is_expired("2099-12-31"));
    }

    #[test]
    fn is_expired_invalid_format_returns_false() {
        assert!(!is_expired("not-a-date"));
        assert!(!is_expired(""));
    }

    #[test]
    fn filter_no_ignore_config_keeps_all_vulns() {
        let config = AuditConfig::default();
        let vulns = vec![vuln("CVE-2024-0001"), vuln("CVE-2024-0002")];
        let (filtered, ignored_count, _) = filter_ignored_vulns(&vulns, &config);
        assert_eq!(filtered.len(), 2);
        assert_eq!(ignored_count, 0);
    }
}
