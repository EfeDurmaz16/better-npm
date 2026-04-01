use std::fs;
use std::path::Path;

use crate::types::ResolvedPackage;
use crate::{extract_json_field, JsonWriter};

// === Dependency firewall: typosquat detection, binary blob scanning, zero-day publisher warnings ===

/// Top 100 popular npm packages for typosquat detection.
const POPULAR_PACKAGES: &[&str] = &[
    "react", "react-dom", "next", "vue", "angular", "svelte",
    "lodash", "underscore", "ramda", "immutable",
    "express", "koa", "fastify", "hapi", "restify",
    "axios", "node-fetch", "got", "superagent", "request",
    "webpack", "rollup", "vite", "esbuild", "parcel",
    "typescript", "babel", "eslint", "prettier", "jest",
    "mocha", "chai", "jasmine", "karma", "cypress",
    "moment", "dayjs", "date-fns", "luxon",
    "chalk", "commander", "yargs", "inquirer", "ora",
    "fs-extra", "glob", "rimraf", "mkdirp", "chokidar",
    "uuid", "nanoid", "cuid", "shortid",
    "dotenv", "config", "convict", "nconf",
    "mongoose", "sequelize", "knex", "prisma", "typeorm",
    "redis", "ioredis", "memcached",
    "jsonwebtoken", "bcrypt", "argon2", "passport", "helmet",
    "socket.io", "ws", "mqtt", "amqplib",
    "winston", "pino", "bunyan", "morgan", "debug",
    "async", "bluebird", "rxjs", "p-limit",
    "body-parser", "cors", "cookie-parser", "multer", "compression",
    "sharp", "jimp", "canvas", "pdf-lib",
    "cheerio", "puppeteer", "playwright",
    "nodemailer", "twilio", "stripe",
    "aws-sdk", "firebase", "googleapis",
    "tailwindcss", "bootstrap", "styled-components", "emotion",
    "classnames", "clsx",
    "zod", "joi", "yup", "ajv",
    "semver", "minimatch", "micromatch",
];

/// Binary file extensions that should raise suspicion.
const BINARY_EXTENSIONS: &[&str] = &[
    ".exe", ".dll", ".so", ".dylib", ".bin", ".bat", ".cmd",
    ".msi", ".scr", ".com", ".pif", ".vbs", ".ps1",
];

#[derive(Debug, Clone)]
pub struct FirewallAlert {
    pub package: String,
    pub version: String,
    pub alert_type: String,
    pub severity: String,
    pub message: String,
    pub details: Option<String>,
}

#[derive(Debug)]
pub struct FirewallReport {
    pub total_checked: u64,
    pub alerts: Vec<FirewallAlert>,
    pub blocked: u64,
    pub warnings: u64,
}

#[derive(Debug, Clone)]
pub struct FirewallConfig {
    pub enabled: bool,
    pub typosquat_detection: bool,
    pub binary_detection: bool,
    pub new_package_warning: bool,
    pub max_levenshtein_distance: usize,
    pub new_package_days: u64,
}

impl Default for FirewallConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            typosquat_detection: true,
            binary_detection: true,
            new_package_warning: true,
            max_levenshtein_distance: 2,
            new_package_days: 7,
        }
    }
}

/// Compute Levenshtein distance between two strings.
fn levenshtein(a: &str, b: &str) -> usize {
    let a_len = a.len();
    let b_len = b.len();
    if a_len == 0 {
        return b_len;
    }
    if b_len == 0 {
        return a_len;
    }

    let mut prev_row: Vec<usize> = (0..=b_len).collect();
    let mut curr_row = vec![0usize; b_len + 1];

    for (i, a_char) in a.chars().enumerate() {
        curr_row[0] = i + 1;
        for (j, b_char) in b.chars().enumerate() {
            let cost = if a_char == b_char { 0 } else { 1 };
            curr_row[j + 1] = (prev_row[j + 1] + 1)
                .min(curr_row[j] + 1)
                .min(prev_row[j] + cost);
        }
        std::mem::swap(&mut prev_row, &mut curr_row);
    }
    prev_row[b_len]
}

/// Check if a package name is a potential typosquat of a popular package.
fn check_typosquat(name: &str) -> Option<(String, usize)> {
    // Skip if the name itself is a popular package
    if POPULAR_PACKAGES.contains(&name) {
        return None;
    }
    // Strip scope for comparison
    let bare_name = if name.starts_with('@') {
        name.split('/').nth(1).unwrap_or(name)
    } else {
        name
    };

    let mut best_match: Option<(String, usize)> = None;
    for &popular in POPULAR_PACKAGES {
        let dist = levenshtein(bare_name, popular);
        if dist > 0 && dist <= 2 {
            match &best_match {
                Some((_, best_dist)) if dist < *best_dist => {
                    best_match = Some((popular.to_string(), dist));
                }
                None => {
                    best_match = Some((popular.to_string(), dist));
                }
                _ => {}
            }
        }
    }
    best_match
}

/// Check if a package contains suspicious binary files.
fn check_binary_blobs(
    package_name: &str,
    node_modules: &Path,
) -> Vec<String> {
    let mut found = Vec::new();

    // Determine package directory
    let pkg_dir = if package_name.starts_with('@') {
        let parts: Vec<&str> = package_name.splitn(2, '/').collect();
        if parts.len() == 2 {
            node_modules.join(parts[0]).join(parts[1])
        } else {
            node_modules.join(package_name)
        }
    } else {
        node_modules.join(package_name)
    };

    if !pkg_dir.exists() {
        return found;
    }

    // Scan files (up to 2 levels deep to avoid huge traversals)
    scan_dir_for_binaries(&pkg_dir, 0, 2, &mut found);
    found
}

fn scan_dir_for_binaries(dir: &Path, depth: usize, max_depth: usize, found: &mut Vec<String>) {
    if depth > max_depth {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name != "node_modules" && !name.starts_with('.') {
                scan_dir_for_binaries(&path, depth + 1, max_depth, found);
            }
        } else if let Some(file_name) = path.file_name() {
            let name = file_name.to_string_lossy().to_lowercase();
            for ext in BINARY_EXTENSIONS {
                if name.ends_with(ext) {
                    found.push(path.to_string_lossy().to_string());
                    break;
                }
            }
        }
    }
}

/// Check if package was published recently (< N days) by examining registry metadata.
fn check_new_package(name: &str, version: &str, max_days: u64) -> Option<String> {
    let encoded_name = name.replace('/', "%2F");
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return None,
    };
    // Fetch full package metadata to check the `time` field
    let full_url = format!("https://registry.npmjs.org/{}", encoded_name);
    let resp = match client.get(&full_url).send() {
        Ok(r) => r,
        Err(_) => return None,
    };
    if !resp.status().is_success() {
        return None;
    }
    let full_body = match resp.text() {
        Ok(b) => b,
        Err(_) => return None,
    };

    // Look for time.version in the package metadata
    if let Some(time_obj) = crate::extract_json_object_raw(&full_body, "time") {
        if let Some(pub_time) = extract_json_field(&time_obj, version) {
            // Parse ISO date and check if it's within max_days
            // Simple check: compare the date prefix (YYYY-MM-DD)
            if pub_time.len() >= 10 {
                let pub_date = &pub_time[..10];
                let now = crate::chrono_now();
                if now.len() >= 10 {
                    let now_date = &now[..10];
                    // Rough comparison: if dates are very close, warn
                    if let Some(days_diff) = rough_day_diff(pub_date, now_date) {
                        if days_diff < max_days {
                            return Some(format!(
                                "published {} days ago ({})",
                                days_diff, pub_date
                            ));
                        }
                    }
                }
            }
        }
    }

    None
}

/// Rough day difference calculation from YYYY-MM-DD strings.
fn rough_day_diff(earlier: &str, later: &str) -> Option<u64> {
    let parse = |s: &str| -> Option<(i64, i64, i64)> {
        let parts: Vec<&str> = s.split('-').collect();
        if parts.len() != 3 {
            return None;
        }
        let y = parts[0].parse::<i64>().ok()?;
        let m = parts[1].parse::<i64>().ok()?;
        let d = parts[2].parse::<i64>().ok()?;
        Some((y, m, d))
    };
    let (y1, m1, d1) = parse(earlier)?;
    let (y2, m2, d2) = parse(later)?;
    let days1 = y1 * 365 + m1 * 30 + d1;
    let days2 = y2 * 365 + m2 * 30 + d2;
    Some((days2 - days1).unsigned_abs())
}

/// Run firewall checks on resolved packages.
pub fn run_firewall(
    packages: &[ResolvedPackage],
    project_root: &Path,
    config: &FirewallConfig,
) -> FirewallReport {
    let mut alerts = Vec::new();
    let node_modules = project_root.join("node_modules");

    for pkg in packages {
        // 1. Typosquat detection
        if config.typosquat_detection {
            if let Some((similar_to, distance)) = check_typosquat(&pkg.name) {
                alerts.push(FirewallAlert {
                    package: pkg.name.clone(),
                    version: pkg.version.clone(),
                    alert_type: "typosquat".into(),
                    severity: "high".into(),
                    message: format!(
                        "\"{}\" is similar to popular package \"{}\" (edit distance: {})",
                        pkg.name, similar_to, distance
                    ),
                    details: Some(format!("similar_to={}, distance={}", similar_to, distance)),
                });
            }
        }

        // 2. Binary blob detection
        if config.binary_detection {
            let binaries = check_binary_blobs(&pkg.name, &node_modules);
            if !binaries.is_empty() {
                alerts.push(FirewallAlert {
                    package: pkg.name.clone(),
                    version: pkg.version.clone(),
                    alert_type: "binary_blob".into(),
                    severity: "medium".into(),
                    message: format!(
                        "\"{}\" contains {} suspicious binary file(s)",
                        pkg.name,
                        binaries.len()
                    ),
                    details: Some(binaries.join(", ")),
                });
            }
        }

        // 3. Zero-day publisher warning
        if config.new_package_warning {
            if let Some(info) = check_new_package(&pkg.name, &pkg.version, config.new_package_days) {
                alerts.push(FirewallAlert {
                    package: pkg.name.clone(),
                    version: pkg.version.clone(),
                    alert_type: "new_package".into(),
                    severity: "low".into(),
                    message: format!("\"{}@{}\" was recently {}", pkg.name, pkg.version, info),
                    details: None,
                });
            }
        }
    }

    let blocked = alerts.iter().filter(|a| a.severity == "high").count() as u64;
    let warnings = alerts.len() as u64 - blocked;

    FirewallReport {
        total_checked: packages.len() as u64,
        alerts,
        blocked,
        warnings,
    }
}

/// Load firewall config from .better-firewall.json or return defaults.
pub fn load_firewall_config(project_root: &Path) -> FirewallConfig {
    let config_path = project_root.join(".better-firewall.json");
    if !config_path.exists() {
        return FirewallConfig::default();
    }
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return FirewallConfig::default(),
    };
    parse_firewall_config(&content)
}

fn parse_firewall_config(json: &str) -> FirewallConfig {
    let mut config = FirewallConfig::default();
    // Parse boolean fields
    if json.contains("\"enabled\"") {
        if json.contains("\"enabled\":false") || json.contains("\"enabled\": false") {
            config.enabled = false;
        }
    }
    if json.contains("\"typosquat_detection\":false") || json.contains("\"typosquat_detection\": false") {
        config.typosquat_detection = false;
    }
    if json.contains("\"binary_detection\":false") || json.contains("\"binary_detection\": false") {
        config.binary_detection = false;
    }
    if json.contains("\"new_package_warning\":false") || json.contains("\"new_package_warning\": false") {
        config.new_package_warning = false;
    }
    if let Some(days) = crate::extract_json_number(json, "new_package_days") {
        config.new_package_days = days;
    }
    if let Some(dist) = crate::extract_json_number(json, "max_levenshtein_distance") {
        config.max_levenshtein_distance = dist as usize;
    }
    config
}

/// Save firewall config to .better-firewall.json.
pub fn save_firewall_config(project_root: &Path, config: &FirewallConfig) -> Result<(), String> {
    let json = write_firewall_config_json(config);
    let config_path = project_root.join(".better-firewall.json");
    fs::write(&config_path, json).map_err(|e| format!("Failed to write firewall config: {}", e))
}

fn write_firewall_config_json(config: &FirewallConfig) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("enabled");
    w.value_bool(config.enabled);
    w.key("typosquat_detection");
    w.value_bool(config.typosquat_detection);
    w.key("binary_detection");
    w.value_bool(config.binary_detection);
    w.key("new_package_warning");
    w.value_bool(config.new_package_warning);
    w.key("max_levenshtein_distance");
    w.value_u64(config.max_levenshtein_distance as u64);
    w.key("new_package_days");
    w.value_u64(config.new_package_days);
    w.end_object();
    w.finish()
}

/// Write firewall report as JSON.
pub fn write_firewall_json(report: &FirewallReport) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("kind");
    w.value_string("better.firewall.report");
    w.key("totalChecked");
    w.value_u64(report.total_checked);
    w.key("blocked");
    w.value_u64(report.blocked);
    w.key("warnings");
    w.value_u64(report.warnings);
    w.key("alerts");
    w.begin_array();
    for alert in &report.alerts {
        w.begin_object();
        w.key("package");
        w.value_string(&alert.package);
        w.key("version");
        w.value_string(&alert.version);
        w.key("type");
        w.value_string(&alert.alert_type);
        w.key("severity");
        w.value_string(&alert.severity);
        w.key("message");
        w.value_string(&alert.message);
        if let Some(ref details) = alert.details {
            w.key("details");
            w.value_string(details);
        }
        w.end_object();
    }
    w.end_array();
    w.end_object();
    w.finish()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ResolvedPackage;

    fn pkg(name: &str) -> ResolvedPackage {
        ResolvedPackage {
            name: name.to_string(),
            version: "1.0.0".to_string(),
            rel_path: format!("node_modules/{}", name),
            resolved_url: String::new(),
            integrity: String::new(),
        }
    }

    #[test]
    fn typosquat_lodash_detected() {
        let result = check_typosquat("lodahs");
        assert!(result.is_some());
        let (name, dist) = result.unwrap();
        assert_eq!(name, "lodash");
        assert_eq!(dist, 2);
    }

    #[test]
    fn popular_package_not_flagged() {
        // lodash itself should not be flagged
        assert!(check_typosquat("lodash").is_none());
    }

    #[test]
    fn unrelated_package_not_flagged() {
        assert!(check_typosquat("my-completely-unique-package-xyz").is_none());
    }

    #[test]
    fn run_firewall_empty_packages() {
        let config = FirewallConfig::default();
        let report = run_firewall(&[], std::path::Path::new("/tmp"), &config);
        assert_eq!(report.total_checked, 0);
        assert!(report.alerts.is_empty());
    }

    #[test]
    fn run_firewall_typosquat_flagged() {
        let config = FirewallConfig {
            typosquat_detection: true,
            binary_detection: false,
            new_package_warning: false,
            ..Default::default()
        };
        let packages = vec![pkg("lodahs")];
        let report = run_firewall(&packages, std::path::Path::new("/tmp"), &config);
        assert!(!report.alerts.is_empty());
        assert!(report.alerts.iter().any(|a| a.alert_type == "typosquat"));
    }

    #[test]
    fn firewall_blocked_count_matches_high_severity() {
        let config = FirewallConfig {
            typosquat_detection: true,
            binary_detection: false,
            new_package_warning: false,
            ..Default::default()
        };
        let packages = vec![pkg("lodahs"), pkg("reect")]; // two typosquats
        let report = run_firewall(&packages, std::path::Path::new("/tmp"), &config);
        // All typosquats are "high" severity → should be blocked
        assert_eq!(report.blocked, report.alerts.iter().filter(|a| a.severity == "high").count() as u64);
    }
}
