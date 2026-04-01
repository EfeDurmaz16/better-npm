use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::types::{LicenseInfo, LicenseReport};
use crate::{extract_json_field, list_packages_in_node_modules};

pub fn scan_licenses(node_modules: &Path, allow: &[String], deny: &[String]) -> Result<LicenseReport, String> {
    let pkg_dirs = list_packages_in_node_modules(node_modules)?;
    let mut packages = Vec::new();
    let mut by_license: BTreeMap<String, u64> = BTreeMap::new();
    let mut violations = Vec::new();

    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let name = extract_json_field(&content, "name").unwrap_or_else(|| "unknown".to_string());
        let version = extract_json_field(&content, "version").unwrap_or_else(|| "0.0.0".to_string());
        let license = extract_json_field(&content, "license").unwrap_or_else(|| "UNLICENSED".to_string());

        *by_license.entry(license.clone()).or_insert(0) += 1;

        let info = LicenseInfo { name, version, license: license.clone() };

        let is_violation = if !deny.is_empty() {
            deny.iter().any(|d| d.eq_ignore_ascii_case(&license))
        } else if !allow.is_empty() {
            !allow.iter().any(|a| a.eq_ignore_ascii_case(&license))
        } else {
            false
        };
        if is_violation {
            violations.push(info.clone());
        }

        packages.push(info);
    }

    let total = packages.len() as u64;
    Ok(LicenseReport { packages, by_license, total_packages: total, violations })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pkg_dir(root: &std::path::Path, name: &str, version: &str, license: &str) {
        let pkg_dir = root.join("node_modules").join(name);
        std::fs::create_dir_all(&pkg_dir).unwrap();
        let pkg_json = format!(
            r#"{{"name":"{}","version":"{}","license":"{}"}}"#,
            name, version, license
        );
        std::fs::write(pkg_dir.join("package.json"), pkg_json).unwrap();
    }

    #[test]
    fn scan_missing_node_modules_returns_empty() {
        let result = scan_licenses(
            std::path::Path::new("/nonexistent-license-project/node_modules"),
            &[],
            &[],
        );
        // list_packages_in_node_modules returns Ok([]) for absent dirs
        assert!(result.is_ok());
        assert_eq!(result.unwrap().total_packages, 0);
    }

    #[test]
    fn scan_mit_package_no_violations() {
        let tmp = std::env::temp_dir().join("license-test-mit");
        make_pkg_dir(&tmp, "lodash", "4.17.21", "MIT");
        let nm = tmp.join("node_modules");
        let report = scan_licenses(&nm, &[], &[]).unwrap();
        assert_eq!(report.total_packages, 1);
        assert!(report.violations.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn deny_list_creates_violation() {
        let tmp = std::env::temp_dir().join("license-test-deny");
        make_pkg_dir(&tmp, "gpl-pkg", "1.0.0", "GPL-3.0");
        let nm = tmp.join("node_modules");
        let deny = vec!["GPL-3.0".to_string()];
        let report = scan_licenses(&nm, &[], &deny).unwrap();
        assert_eq!(report.violations.len(), 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn allow_list_filters_unlicensed() {
        let tmp = std::env::temp_dir().join("license-test-allow");
        make_pkg_dir(&tmp, "unlicensed-pkg", "1.0.0", "UNLICENSED");
        let nm = tmp.join("node_modules");
        let allow = vec!["MIT".to_string()];
        let report = scan_licenses(&nm, &allow, &[]).unwrap();
        assert_eq!(report.violations.len(), 1); // UNLICENSED not in allow list
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
