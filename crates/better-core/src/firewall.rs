use std::fs;
use std::path::Path;

use crate::types::ResolvedPackage;
use crate::JsonWriter;

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
fn check_new_package(
    name: &str,
    version: &str,
    max_days: u64,
    config: &crate::types::NpmrcConfig,
) -> Result<Option<String>, String> {
    let (base, _) = crate::npmrc::registry_for_package(config, name);
    let url = crate::audit::evidence::registry_url(base, &[name])?;
    let token = crate::audit::evidence::registry_token(config, base, &url, name);
    let full_body = match crate::audit::evidence::registry_get(&url, token)? {
        crate::audit::evidence::RegistryEvidence::Present(body) => body,
        crate::audit::evidence::RegistryEvidence::Missing => {
            return Err("Registry has no publication-age evidence for this package".into());
        }
    };

    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "System clock is before the Unix epoch")?.as_secs();
    publication_age(&full_body, version, max_days, now)
}

/// Only a valid, nonfuture timestamp can establish publication age.
fn publication_age(body: &str, version: &str, max_days: u64, now: u64) -> Result<Option<String>, String> {
    let metadata: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "Invalid registry publication metadata")?;
    let timestamp = metadata.get("time").and_then(|time| time.get(version))
        .and_then(|time| time.as_str()).ok_or("Registry has no timestamp for this package version")?;
    let published = publication_timestamp(timestamp).ok_or("Registry publication timestamp is invalid")?;
    let age = i64::try_from(now).map_err(|_| "System clock exceeds supported range")?
        .checked_sub(published).filter(|age| *age >= 0)
        .ok_or("Registry publication timestamp is in the future")? as u64;
    let days = age / 86_400;
    if days < max_days {
        Ok(Some(format!("published {} days ago ({})", days, &timestamp[..10])))
    } else {
        Ok(None)
    }
}

/// Gregorian calendar day relative to 0001-01-01, with strict ASCII YYYY-MM-DD.
fn calendar_day(date: &str) -> Option<i64> {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-'
        || !bytes.iter().enumerate().all(|(i, byte)| i == 4 || i == 7 || byte.is_ascii_digit()) {
        return None;
    }
    let year = date[..4].parse::<i64>().ok()?;
    let month = date[5..7].parse::<usize>().ok()?;
    let day = date[8..10].parse::<i64>().ok()?;
    if year == 0 || !(1..=12).contains(&month) { return None; }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let lengths = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if day < 1 || day > lengths[month - 1] { return None; }
    let previous = year - 1;
    Some(previous * 365 + previous / 4 - previous / 100 + previous / 400
        + lengths[..month - 1].iter().sum::<i64>() + day - 1)
}

/// RFC3339 timestamp used by npm registry, including fractional seconds and offsets.
fn publication_timestamp(timestamp: &str) -> Option<i64> {
    let bytes = timestamp.as_bytes();
    if !timestamp.is_ascii() || bytes.len() < 20 || bytes[10] != b'T'
        || bytes[13] != b':' || bytes[16] != b':' { return None; }
    let day = calendar_day(&timestamp[..10])? - calendar_day("1970-01-01")?;
    let number = |part: &str| -> Option<i64> {
        if !part.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
        part.parse().ok()
    };
    let hour = number(&timestamp[11..13])?;
    let minute = number(&timestamp[14..16])?;
    let second = number(&timestamp[17..19])?;
    if hour > 23 || minute > 59 || second > 59 { return None; }
    let mut offset_start = 19;
    if bytes[offset_start] == b'.' {
        offset_start += 1;
        let fraction_start = offset_start;
        while offset_start < bytes.len() && bytes[offset_start].is_ascii_digit() { offset_start += 1; }
        if offset_start == fraction_start { return None; }
    }
    let zone = timestamp.get(offset_start..)?;
    let offset = if zone == "Z" { 0 } else {
        let zone_bytes = zone.as_bytes();
        if zone_bytes.len() != 6 || !matches!(zone_bytes[0], b'+' | b'-') || zone_bytes[3] != b':' { return None; }
        let hours = number(&zone[1..3])?;
        let minutes = number(&zone[4..6])?;
        if hours > 23 || minutes > 59 { return None; }
        let seconds = hours * 3600 + minutes * 60;
        if zone_bytes[0] == b'+' { seconds } else { -seconds }
    };
    Some(day * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

#[cfg(test)]
fn rough_day_diff(earlier: &str, later: &str) -> Option<u64> {
    u64::try_from(calendar_day(later)? - calendar_day(earlier)?).ok()
}

/// Run firewall checks on resolved packages.
pub fn run_firewall(
    packages: &[ResolvedPackage],
    project_root: &Path,
    config: &FirewallConfig,
) -> FirewallReport {
    let mut alerts = Vec::new();
    let node_modules = project_root.join("node_modules");

    let registry = crate::npmrc::parse_npmrc(project_root);
    // Reuse the shared resident pool. Local mutable payload checks remain fresh.
    let publication = if config.new_package_warning {
        crate::audit::evidence::map_bounded(packages, |pkg| {
            check_new_package(&pkg.name, &pkg.version, config.new_package_days, &registry)
        })
    } else {
        vec![Ok(None); packages.len()]
    };
    for (pkg, publication) in packages.iter().zip(publication) {
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
            if let Ok(Some(info)) = &publication {
                alerts.push(FirewallAlert {
                    package: pkg.name.clone(),
                    version: pkg.version.clone(),
                    alert_type: "new_package".into(),
                    severity: "low".into(),
                    message: format!("\"{}@{}\" was recently {}", pkg.name, pkg.version, info),
                    details: None,
                });
            } else if publication.is_err() {
                alerts.push(FirewallAlert {
                    package: pkg.name.clone(),
                    version: pkg.version.clone(),
                    alert_type: "registry_unknown".into(),
                    severity: "medium".into(),
                    message: "Publication-age evidence could not be retrieved or validated".into(),
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
            selection: Default::default(),
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

    #[test]
    fn levenshtein_identical_strings_is_zero() {
        assert_eq!(levenshtein("lodash", "lodash"), 0);
    }

    #[test]
    fn levenshtein_empty_string_is_length() {
        assert_eq!(levenshtein("", "abc"), 3);
        assert_eq!(levenshtein("abc", ""), 3);
    }

    #[test]
    fn levenshtein_single_substitution() {
        // "react" vs "reect" differs by 1 char
        assert_eq!(levenshtein("react", "reect"), 1);
    }

    #[test]
    fn rough_day_diff_same_date_is_zero() {
        let diff = rough_day_diff("2024-01-15", "2024-01-15").unwrap();
        assert_eq!(diff, 0);
    }

    #[test]
    fn rough_day_diff_one_day_apart() {
        let diff = rough_day_diff("2024-01-15", "2024-01-16").unwrap();
        assert!(diff >= 1);
    }

    #[test]
    fn rough_day_diff_invalid_format_returns_none() {
        assert!(rough_day_diff("not-a-date", "2024-01-01").is_none());
    }

    #[test]
    fn firewall_config_default_has_expected_values() {
        let cfg = FirewallConfig::default();
        assert!(cfg.enabled);
        assert!(cfg.typosquat_detection);
        assert!(cfg.binary_detection);
        assert_eq!(cfg.max_levenshtein_distance, 2);
    }

    #[test]
    fn run_firewall_all_detections_off_returns_no_alerts() {
        let config = FirewallConfig {
            enabled: false,
            typosquat_detection: false,
            binary_detection: false,
            new_package_warning: false,
            ..Default::default()
        };
        let packages = vec![pkg("lodahs")];
        let report = run_firewall(&packages, std::path::Path::new("/tmp"), &config);
        assert!(report.alerts.is_empty());
        assert_eq!(report.total_checked, 1);
    }
    #[test]
    fn confirmed_missing_publication_metadata_is_unknown() {
        let (url, server) = crate::audit::evidence::tests::server(404, "{}", 1);
        let config = crate::types::NpmrcConfig { default_registry: url, ..Default::default() };
        let result = check_new_package("fixture", "1.0.0", 7, &config);
        server.join().unwrap();
        assert!(result.unwrap_err().contains("no publication-age evidence"));
    }

    #[test]
    fn incomplete_or_invalid_publication_metadata_is_unknown() {
        let now = publication_timestamp("2026-09-10T12:00:00Z").unwrap() as u64;
        for body in [
            "{}", r#"{"time":{}}"#, r#"{"time":{"2.0.0":"2020-01-01T00:00:00Z"}}"#,
            r#"{"time":{"1.0.0":null}}"#, r#"{"time":{"1.0.0":"not-a-date"}}"#,
            r#"{"time":{"1.0.0":"2026-02-30T00:00:00Z"}}"#,
            r#"{"time":{"1.0.0":"2026-01-01T99:00:00Z"}}"#,
            r#"{"time":{"1.0.0":"2020-01-01garbage"}}"#,
            r#"{"time":{"1.0.0":"2027-01-01T00:00:00Z"}}"#,
        ] { assert!(publication_age(body, "1.0.0", 7, now).is_err(), "{body}"); }
        assert!(publication_age(r#"{"time":{"1.0.0":"2026-09-09T12:00:00.123Z"}}"#, "1.0.0", 7, now).unwrap().is_some());
        assert!(publication_age(r#"{"time":{"1.0.0":"2020-01-01T00:00:00Z"}}"#, "1.0.0", 7, now).unwrap().is_none());
    }

    #[test]
    fn calendar_validates_leap_years_offsets_and_future_dates() {
        assert_eq!(rough_day_diff("2024-02-28", "2024-03-01"), Some(2));
        assert_eq!(rough_day_diff("2023-02-28", "2023-03-01"), Some(1));
        assert_eq!(rough_day_diff("2024-03-01", "2024-02-28"), None);
        assert!(calendar_day("1900-02-29").is_none());
        assert!(calendar_day("2000-02-29").is_some());
        assert_eq!(publication_timestamp("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(publication_timestamp("1970-01-01T03:00:00+03:00"), Some(0));
        assert_eq!(publication_timestamp("1969-12-31T19:00:00-05:00"), Some(0));
        for value in ["2020-01-01", "2020-01-01T00:00:00.Z", "2020-01-01T00:00:00+24:00", "2020-01-01T00:00:00Zjunk"] {
            assert!(publication_timestamp(value).is_none(), "{value}");
        }
    }

}
