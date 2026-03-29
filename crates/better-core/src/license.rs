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
