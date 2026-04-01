use std::collections::HashMap;
use std::path::Path;

use crate::types::*;
use crate::{resolve_from_lockfile, extract_json_field};

// --- B.5: Outdated Checker ---

#[derive(Debug, Clone)]
pub struct SemVer {
    major: u64,
    minor: u64,
    patch: u64,
}

pub fn parse_semver(v: &str) -> Option<SemVer> {
    let v = v.trim_start_matches('v');
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() < 3 { return None; }
    Some(SemVer {
        major: parts[0].parse().ok()?,
        minor: parts[1].parse().ok()?,
        patch: parts[2].split('-').next()?.parse().ok()?,
    })
}

/// Check if a version satisfies a semver constraint string.
/// Supports: >=X.Y.Z, >X.Y.Z, <=X.Y.Z, <X.Y.Z, ^X.Y.Z (same major), ~X.Y.Z (same major.minor), exact.
pub fn check_semver_range(version: &SemVer, constraint: &str) -> bool {
    let constraint = constraint.trim();
    if constraint.is_empty() { return true; }
    // Handle || (OR) ranges
    if constraint.contains("||") {
        return constraint.split("||").any(|part| check_semver_range(version, part.trim()));
    }
    // Handle space-separated (AND) ranges
    if constraint.contains(' ') && !constraint.starts_with('>') && !constraint.starts_with('<') && !constraint.starts_with('^') && !constraint.starts_with('~') {
        let parts: Vec<&str> = constraint.split_whitespace().collect();
        if parts.len() >= 2 { return parts.iter().all(|p| check_semver_range(version, p)); }
    }
    if let Some(rest) = constraint.strip_prefix(">=") {
        if let Some(req) = parse_semver(rest.trim()) {
            return (version.major, version.minor, version.patch) >= (req.major, req.minor, req.patch);
        }
    } else if let Some(rest) = constraint.strip_prefix('>') {
        if let Some(req) = parse_semver(rest.trim()) {
            return (version.major, version.minor, version.patch) > (req.major, req.minor, req.patch);
        }
    } else if let Some(rest) = constraint.strip_prefix("<=") {
        if let Some(req) = parse_semver(rest.trim()) {
            return (version.major, version.minor, version.patch) <= (req.major, req.minor, req.patch);
        }
    } else if let Some(rest) = constraint.strip_prefix('<') {
        if let Some(req) = parse_semver(rest.trim()) {
            return (version.major, version.minor, version.patch) < (req.major, req.minor, req.patch);
        }
    } else if let Some(rest) = constraint.strip_prefix('^') {
        if let Some(req) = parse_semver(rest.trim()) {
            return version.major == req.major
                && (version.major, version.minor, version.patch) >= (req.major, req.minor, req.patch);
        }
    } else if let Some(rest) = constraint.strip_prefix('~') {
        if let Some(req) = parse_semver(rest.trim()) {
            return version.major == req.major && version.minor == req.minor && version.patch >= req.patch;
        }
    } else if let Some(req) = parse_semver(constraint) {
        return version.major == req.major && version.minor == req.minor && version.patch == req.patch;
    }
    true // unparseable constraint → pass
}

fn classify_update(current: &SemVer, latest: &SemVer) -> &'static str {
    if latest.major > current.major { "major" }
    else if latest.minor > current.minor { "minor" }
    else if latest.patch > current.patch { "patch" }
    else { "current" }
}

pub fn check_outdated(_project_root: &Path, lockfile: &Path) -> Result<OutdatedReport, String> {
    use rayon::prelude::*;

    // Get packages from lockfile
    let resolve_result = resolve_from_lockfile(lockfile)?;

    // Deduplicate by name (only check each package once)
    let mut unique: HashMap<String, String> = HashMap::new();
    for pkg in &resolve_result.packages {
        unique.entry(pkg.name.clone()).or_insert_with(|| pkg.version.clone());
    }
    let pkg_list: Vec<(String, String)> = unique.into_iter().collect();

    let http_client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .http2_adaptive_window(true)
        .pool_max_idle_per_host(10)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Fetch latest versions in parallel
    let results: Vec<Option<OutdatedEntry>> = pkg_list.par_iter().map(|(name, current_version)| {
        let url = if name.starts_with('@') {
            format!("https://registry.npmjs.org/{}", name.replace('/', "%2F"))
        } else {
            format!("https://registry.npmjs.org/{}", name)
        };

        let resp = match http_client.get(&url).send() {
            Ok(r) => r,
            Err(_) => return None,
        };
        let body = match resp.text() {
            Ok(b) => b,
            Err(_) => return None,
        };

        // Extract dist-tags.latest
        let dist_tags_pos = match body.find("\"dist-tags\"") {
            Some(p) => p,
            None => return None,
        };
        let dist_section = &body[dist_tags_pos..];
        let latest = match extract_json_field(dist_section, "latest") {
            Some(v) => v,
            None => return None,
        };

        if latest == *current_version {
            return None;
        }

        let current_sv = parse_semver(current_version);
        let latest_sv = parse_semver(&latest);
        let update_type = match (current_sv.as_ref(), latest_sv.as_ref()) {
            (Some(c), Some(l)) => classify_update(c, l).to_string(),
            _ => "unknown".to_string(),
        };

        if update_type == "current" { return None; }

        Some(OutdatedEntry {
            name: name.clone(),
            current: current_version.clone(),
            latest,
            update_type,
        })
    }).collect();

    let mut packages: Vec<OutdatedEntry> = results.into_iter().flatten().collect();
    packages.sort_by(|a, b| a.name.cmp(&b.name));

    let total_checked = pkg_list.len() as u64;
    let outdated = packages.len() as u64;
    let major = packages.iter().filter(|p| p.update_type == "major").count() as u64;
    let minor = packages.iter().filter(|p| p.update_type == "minor").count() as u64;
    let patch = packages.iter().filter(|p| p.update_type == "patch").count() as u64;

    Ok(OutdatedReport { packages, total_checked, outdated, major, minor, patch })
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_semver_valid() {
        let v = parse_semver("1.2.3").unwrap();
        assert_eq!(v.major, 1);
        assert_eq!(v.minor, 2);
        assert_eq!(v.patch, 3);
    }

    #[test]
    fn parse_semver_strips_v_prefix() {
        let v = parse_semver("v2.0.0").unwrap();
        assert_eq!(v.major, 2);
    }

    #[test]
    fn parse_semver_strips_prerelease() {
        let v = parse_semver("1.0.0-beta.1").unwrap();
        assert_eq!(v.patch, 0);
    }

    #[test]
    fn check_semver_range_gte() {
        let v = parse_semver("18.0.0").unwrap();
        assert!(check_semver_range(&v, ">=16.0.0"));
        assert!(!check_semver_range(&v, ">=20.0.0"));
    }

    #[test]
    fn check_semver_range_caret() {
        let v = parse_semver("18.5.0").unwrap();
        assert!(check_semver_range(&v, "^18.0.0"));
        assert!(!check_semver_range(&v, "^19.0.0"));
    }

    #[test]
    fn check_outdated_missing_lockfile_errors() {
        let tmp = std::env::temp_dir().join("outdated-test-nolock");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), r#"{"dependencies":{"lodash":"^4.0.0"}}"#).unwrap();
        // No lockfile → should error
        let fake_lock = tmp.join("package-lock.json");
        let result = check_outdated(&tmp, &fake_lock);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
