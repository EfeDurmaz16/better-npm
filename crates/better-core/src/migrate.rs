use std::fs;
use std::path::Path;

use crate::lockfile::{LockPackage, LockfileWriter, ECOSYSTEM_PYTHON};

/// Result of a migration operation.
#[derive(Debug)]
pub struct MigrateResult {
    pub source: String,
    pub package_count: usize,
    pub lockfile_path: String,
}

/// Parse a `requirements.txt` file and return Python lock packages.
///
/// Handles:
/// - `package==version`
/// - `package==version ; markers`  (markers stripped)
/// - Comments (`#`) and blank lines
/// - `-r other-file.txt` (ignored)
/// - `--hash=sha256:...` inline hashes
fn parse_requirements_txt(content: &str) -> Vec<LockPackage> {
    let mut packages = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('-') {
            continue;
        }

        // Strip inline comments
        let line = if let Some(pos) = line.find(" #") {
            &line[..pos]
        } else {
            line
        };

        // Extract hash if present (--hash=algorithm:digest)
        let (line, hashes) = extract_hashes(line);

        // Strip environment markers (everything after `;`)
        let line = if let Some(pos) = line.find(';') {
            line[..pos].trim()
        } else {
            line.trim()
        };

        // Parse name==version
        if let Some(eq_pos) = line.find("==") {
            let name = line[..eq_pos].trim().to_string();
            let version = line[eq_pos + 2..].trim().to_string();
            let integrity = hashes.first().cloned().unwrap_or_default();

            packages.push(LockPackage {
                name: name.clone(),
                version: version.clone(),
                integrity,
                resolved: format!("https://pypi.org/simple/{}/", name.to_lowercase()),
                dependencies: Vec::new(),
                ecosystem: ECOSYSTEM_PYTHON,
            });
        }
        // Also handle >= or ~= but only extract name (no exact version lock)
        // We skip these as they're not pinned
    }

    packages
}

/// Extract `--hash=algo:hex` fragments from a requirement line.
fn extract_hashes(line: &str) -> (&str, Vec<String>) {
    let mut hashes = Vec::new();
    let mut remaining = line;

    // Find the first --hash occurrence; everything before it is the requirement
    if let Some(pos) = line.find(" --hash=") {
        remaining = &line[..pos];
        let hash_part = &line[pos..];
        for segment in hash_part.split(" --hash=") {
            let seg = segment.trim();
            if !seg.is_empty() {
                hashes.push(seg.to_string());
            }
        }
    }

    (remaining, hashes)
}

/// Parse a `Pipfile.lock` (JSON format) into lock packages.
fn parse_pipfile_lock(content: &str) -> Result<Vec<LockPackage>, String> {
    // Pipfile.lock is JSON with structure:
    // { "_meta": {...}, "default": { "package-name": { "version": "==1.0", "hashes": [...] } }, "develop": {...} }
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| format!("Failed to parse Pipfile.lock: {e}"))?;

    let mut packages = Vec::new();

    for section in ["default", "develop"] {
        if let Some(obj) = value.get(section).and_then(|v| v.as_object()) {
            for (name, info) in obj {
                let version = info
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim_start_matches("==")
                    .to_string();

                let hashes: Vec<String> = info
                    .get("hashes")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|h| h.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();

                let integrity = hashes.first().cloned().unwrap_or_default();

                packages.push(LockPackage {
                    name: name.clone(),
                    version,
                    integrity,
                    resolved: format!("https://pypi.org/simple/{}/", name.to_lowercase()),
                    dependencies: Vec::new(),
                    ecosystem: ECOSYSTEM_PYTHON,
                });
            }
        }
    }

    Ok(packages)
}

/// Parse a `poetry.lock` (TOML format) into lock packages.
///
/// poetry.lock uses TOML with repeated `[[package]]` sections:
/// ```toml
/// [[package]]
/// name = "requests"
/// version = "2.31.0"
/// description = "..."
///
/// [package.dependencies]
/// certifi = ">=2017.4.17"
/// ```
fn parse_poetry_lock(content: &str) -> Vec<LockPackage> {
    let mut packages = Vec::new();
    let mut current_name = String::new();
    let mut current_version = String::new();
    let mut current_deps: Vec<String> = Vec::new();
    let mut in_package = false;
    let mut in_deps = false;

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed == "[[package]]" {
            // Save previous package if any
            if in_package && !current_name.is_empty() {
                packages.push(LockPackage {
                    name: current_name.clone(),
                    version: current_version.clone(),
                    integrity: String::new(),
                    resolved: format!(
                        "https://pypi.org/simple/{}/",
                        current_name.to_lowercase()
                    ),
                    dependencies: current_deps.clone(),
                    ecosystem: ECOSYSTEM_PYTHON,
                });
            }
            current_name.clear();
            current_version.clear();
            current_deps.clear();
            in_package = true;
            in_deps = false;
            continue;
        }

        if trimmed.starts_with("[package.dependencies]") {
            in_deps = true;
            continue;
        }

        if trimmed.starts_with('[') {
            // Any other section header ends deps
            in_deps = false;
            // If it's not a package-related section, end the package block
            if !trimmed.starts_with("[package.") {
                if in_package && !current_name.is_empty() {
                    packages.push(LockPackage {
                        name: current_name.clone(),
                        version: current_version.clone(),
                        integrity: String::new(),
                        resolved: format!(
                            "https://pypi.org/simple/{}/",
                            current_name.to_lowercase()
                        ),
                        dependencies: current_deps.clone(),
                        ecosystem: ECOSYSTEM_PYTHON,
                    });
                    current_name.clear();
                    current_version.clear();
                    current_deps.clear();
                    in_package = false;
                }
            }
            continue;
        }

        if in_package && !in_deps {
            if let Some(val) = extract_toml_string(trimmed, "name") {
                current_name = val;
            } else if let Some(val) = extract_toml_string(trimmed, "version") {
                current_version = val;
            }
        }

        if in_deps && trimmed.contains('=') && !trimmed.starts_with('#') {
            // e.g. `certifi = ">=2017.4.17"` or `urllib3 = {version = ">=1.21.1"}`
            if let Some(eq_pos) = trimmed.find('=') {
                let dep_name = trimmed[..eq_pos].trim().to_string();
                if !dep_name.is_empty() && !dep_name.starts_with('[') {
                    current_deps.push(dep_name);
                }
            }
        }
    }

    // Don't forget the last package
    if in_package && !current_name.is_empty() {
        packages.push(LockPackage {
            name: current_name,
            version: current_version,
            integrity: String::new(),
            resolved: format!(
                "https://pypi.org/simple/{}/",
                packages
                    .last()
                    .map(|p| p.name.to_lowercase())
                    .unwrap_or_default()
            ),
            dependencies: current_deps,
            ecosystem: 1,
        });
    }

    packages
}

/// Helper: extract a TOML string value from a line like `name = "value"`.
fn extract_toml_string(line: &str, key: &str) -> Option<String> {
    let prefix = format!("{key} = ");
    if !line.starts_with(&prefix) {
        return None;
    }
    let rest = line[prefix.len()..].trim();
    if rest.starts_with('"') {
        let end = rest[1..].find('"')?;
        Some(rest[1..1 + end].to_string())
    } else {
        None
    }
}

/// Migrate a Python lockfile to better.lock format.
///
/// Supported `from` values: `"pip"`, `"pipenv"`, `"poetry"`.
pub fn migrate_lockfile(project_root: &Path, from: &str) -> Result<MigrateResult, String> {
    let packages = match from {
        "pip" | "requirements" => {
            let req_path = project_root.join("requirements.txt");
            let content = fs::read_to_string(&req_path)
                .map_err(|e| format!("Failed to read requirements.txt: {e}"))?;
            parse_requirements_txt(&content)
        }
        "pipenv" | "pipfile" => {
            let lock_path = project_root.join("Pipfile.lock");
            let content = fs::read_to_string(&lock_path)
                .map_err(|e| format!("Failed to read Pipfile.lock: {e}"))?;
            parse_pipfile_lock(&content)?
        }
        "poetry" => {
            let lock_path = project_root.join("poetry.lock");
            let content = fs::read_to_string(&lock_path)
                .map_err(|e| format!("Failed to read poetry.lock: {e}"))?;
            parse_poetry_lock(&content)
        }
        other => {
            return Err(format!(
                "Unknown source format: '{other}'. Supported: pip, pipenv, poetry"
            ));
        }
    };

    if packages.is_empty() {
        return Err(format!("No packages found in {from} lockfile"));
    }

    let count = packages.len();

    // Write to better.lock using the existing lockfile writer
    let mut writer = LockfileWriter::new();
    for pkg in &packages {
        writer.add_package(pkg.clone());
    }

    let result = writer.write_both(project_root)
        .map_err(|e| format!("Failed to write better.lock: {e}"))?;

    Ok(MigrateResult {
        source: from.to_string(),
        package_count: count,
        lockfile_path: result.binary_path,
    })
}

// ---------------------------------------------------------------------------
// Task 74: Cross-ecosystem lockfile detection and migration
// ---------------------------------------------------------------------------

/// Identifies the source lockfile format.
#[derive(Debug, Clone, PartialEq)]
pub enum LockfileSource {
    // Node.js
    NpmPackageLock,
    YarnLock,
    PnpmLock,
    // Python
    PipfileLock,
    PoetryLock,
    UvLock,
    // Rust
    CargoLock,
    // Go
    GoSum,
}

/// A detected lockfile ready for migration.
#[derive(Debug, Clone)]
pub struct DetectedLockfile {
    pub path: std::path::PathBuf,
    pub source: LockfileSource,
    pub ecosystem: &'static str,
}

/// Auto-detect all lockfiles present in a project root.
pub fn detect_lockfiles(project_root: &Path) -> Vec<DetectedLockfile> {
    let candidates: &[(&str, LockfileSource, &str)] = &[
        ("package-lock.json", LockfileSource::NpmPackageLock, "npm"),
        ("yarn.lock",         LockfileSource::YarnLock,       "npm"),
        ("pnpm-lock.yaml",    LockfileSource::PnpmLock,       "npm"),
        ("Pipfile.lock",      LockfileSource::PipfileLock,    "python"),
        ("poetry.lock",       LockfileSource::PoetryLock,     "python"),
        ("uv.lock",           LockfileSource::UvLock,         "python"),
        ("Cargo.lock",        LockfileSource::CargoLock,      "cargo"),
        ("go.sum",            LockfileSource::GoSum,          "go"),
    ];

    candidates
        .iter()
        .filter_map(|(filename, source, ecosystem)| {
            let path = project_root.join(filename);
            if path.exists() {
                Some(DetectedLockfile {
                    path,
                    source: source.clone(),
                    ecosystem,
                })
            } else {
                None
            }
        })
        .collect()
}

/// Result of a cross-ecosystem migration.
#[derive(Debug)]
pub struct MigrationResult {
    pub lockfiles_found: usize,
    pub lockfiles_migrated: usize,
    pub ecosystems: Vec<String>,
    pub total_packages: usize,
}

/// Parse a Cargo.lock file into a simple package list.
///
/// Cargo.lock format (v2/v3 TOML):
/// ```toml
/// [[package]]
/// name = "serde"
/// version = "1.0.0"
/// source = "registry+https://github.com/rust-lang/crates.io-index"
/// checksum = "abc123"
/// ```
pub fn parse_cargo_lock(path: &Path) -> Result<Vec<(String, String, String)>, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Cannot read Cargo.lock: {}", e))?;

    let mut packages = Vec::new();
    let mut name = String::new();
    let mut version = String::new();
    let mut checksum = String::new();
    let mut in_package = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "[[package]]" {
            if in_package && !name.is_empty() && !version.is_empty() {
                packages.push((name.clone(), version.clone(), checksum.clone()));
            }
            name.clear();
            version.clear();
            checksum.clear();
            in_package = true;
        } else if in_package {
            if let Some(v) = extract_toml_string(trimmed, "name") {
                name = v;
            } else if let Some(v) = extract_toml_string(trimmed, "version") {
                version = v;
            } else if let Some(v) = extract_toml_string(trimmed, "checksum") {
                checksum = v;
            }
        }
    }
    // Don't forget the last package
    if in_package && !name.is_empty() && !version.is_empty() {
        packages.push((name, version, checksum));
    }

    Ok(packages)
}

/// Parse a go.sum file into a list of (module, version, hash) tuples.
///
/// go.sum format:
/// ```text
/// github.com/user/module v1.2.3 h1:HASH=
/// github.com/user/module v1.2.3/go.mod h1:HASH=
/// ```
pub fn parse_go_sum(path: &Path) -> Result<Vec<(String, String, String)>, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Cannot read go.sum: {}", e))?;

    let mut packages = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // Skip go.mod lines — only keep the source lines
        if trimmed.contains("/go.mod ") {
            continue;
        }
        let parts: Vec<&str> = trimmed.splitn(3, ' ').collect();
        if parts.len() >= 2 {
            let module = parts[0].to_string();
            let version = parts[1].trim_start_matches('v').to_string();
            let hash = parts.get(2).map(|s| s.to_string()).unwrap_or_default();

            let key = format!("{}@{}", module, version);
            if seen.insert(key) {
                packages.push((module, version, hash));
            }
        }
    }

    Ok(packages)
}

/// Detect and report all lockfiles in a project (for `better migrate --list`).
pub fn detect_and_report(project_root: &Path) -> Vec<String> {
    detect_lockfiles(project_root)
        .iter()
        .map(|lf| format!("{} ({})", lf.path.display(), lf.ecosystem))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_requirements_txt() {
        let content = r#"
# This is a comment
flask==2.3.2
requests==2.31.0 ; python_version >= "3.7"
numpy==1.24.3 --hash=sha256:abc123

# Another comment
-r dev-requirements.txt
pandas==2.0.3
"#;
        let packages = parse_requirements_txt(content);
        assert_eq!(packages.len(), 4);
        assert_eq!(packages[0].name, "flask");
        assert_eq!(packages[0].version, "2.3.2");
        assert_eq!(packages[1].name, "requests");
        assert_eq!(packages[1].version, "2.31.0");
        assert_eq!(packages[2].name, "numpy");
        assert_eq!(packages[2].version, "1.24.3");
        assert_eq!(packages[2].integrity, "sha256:abc123");
        assert_eq!(packages[3].name, "pandas");
        assert_eq!(packages[3].version, "2.0.3");
    }

    #[test]
    fn test_parse_pipfile_lock() {
        let content = r#"{
    "_meta": {"hash": {"sha256": "abc"}, "pipfile-spec": 6},
    "default": {
        "flask": {
            "hashes": ["sha256:abc123"],
            "version": "==2.3.2"
        },
        "requests": {
            "hashes": ["sha256:def456"],
            "version": "==2.31.0"
        }
    },
    "develop": {}
}"#;
        let packages = parse_pipfile_lock(content).unwrap();
        assert_eq!(packages.len(), 2);
        assert_eq!(packages[0].name, "flask");
        assert_eq!(packages[0].version, "2.3.2");
        assert_eq!(packages[0].integrity, "sha256:abc123");
        assert_eq!(packages[1].name, "requests");
        assert_eq!(packages[1].version, "2.31.0");
    }

    #[test]
    fn test_parse_poetry_lock() {
        let content = r#"
[[package]]
name = "certifi"
version = "2023.7.22"
description = "Python package for providing Mozilla's CA Bundle."

[[package]]
name = "requests"
version = "2.31.0"
description = "Python HTTP for Humans."

[package.dependencies]
certifi = ">=2017.4.17"
charset-normalizer = ">=2,<4"
"#;
        let packages = parse_poetry_lock(content);
        assert_eq!(packages.len(), 2);
        assert_eq!(packages[0].name, "certifi");
        assert_eq!(packages[0].version, "2023.7.22");
        assert_eq!(packages[1].name, "requests");
        assert_eq!(packages[1].version, "2.31.0");
        assert_eq!(packages[1].dependencies.len(), 2);
    }

    #[test]
    fn test_extract_toml_string() {
        assert_eq!(
            extract_toml_string(r#"name = "flask""#, "name"),
            Some("flask".to_string())
        );
        assert_eq!(
            extract_toml_string(r#"version = "2.3.2""#, "version"),
            Some("2.3.2".to_string())
        );
        assert_eq!(extract_toml_string(r#"other = 42"#, "other"), None);
    }

    #[test]
    fn test_extract_hashes() {
        let (line, hashes) = extract_hashes("numpy==1.24.3 --hash=sha256:abc123 --hash=sha256:def456");
        assert_eq!(line, "numpy==1.24.3");
        assert_eq!(hashes.len(), 2);

        let (line2, hashes2) = extract_hashes("flask==2.3.2");
        assert_eq!(line2, "flask==2.3.2");
        assert!(hashes2.is_empty());
    }

    // ── Task 74: cross-ecosystem detection tests ──────────────────────────

    #[test]
    fn detect_lockfiles_finds_npm_package_lock() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package-lock.json"), "{}").unwrap();
        let detected = detect_lockfiles(dir.path());
        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].source, LockfileSource::NpmPackageLock);
        assert_eq!(detected[0].ecosystem, "npm");
    }

    #[test]
    fn detect_lockfiles_finds_yarn_lock() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("yarn.lock"), "").unwrap();
        let detected = detect_lockfiles(dir.path());
        assert!(detected.iter().any(|l| l.source == LockfileSource::YarnLock));
    }

    #[test]
    fn detect_lockfiles_polyglot_project() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package-lock.json"), "{}").unwrap();
        std::fs::write(dir.path().join("Cargo.lock"), "").unwrap();
        std::fs::write(dir.path().join("go.sum"), "").unwrap();
        let detected = detect_lockfiles(dir.path());
        assert_eq!(detected.len(), 3);
        let ecosystems: Vec<_> = detected.iter().map(|l| l.ecosystem).collect();
        assert!(ecosystems.contains(&"npm"));
        assert!(ecosystems.contains(&"cargo"));
        assert!(ecosystems.contains(&"go"));
    }

    #[test]
    fn detect_lockfiles_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert!(detect_lockfiles(dir.path()).is_empty());
    }

    #[test]
    fn parse_cargo_lock_simple() {
        let dir = tempfile::tempdir().unwrap();
        let cargo_lock = dir.path().join("Cargo.lock");
        std::fs::write(&cargo_lock, r#"
[[package]]
name = "serde"
version = "1.0.193"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc123def456"

[[package]]
name = "rand"
version = "0.8.5"
checksum = "deadbeef"
"#).unwrap();
        let pkgs = parse_cargo_lock(&cargo_lock).unwrap();
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0].0, "serde");
        assert_eq!(pkgs[0].1, "1.0.193");
        assert_eq!(pkgs[0].2, "abc123def456");
        assert_eq!(pkgs[1].0, "rand");
        assert_eq!(pkgs[1].1, "0.8.5");
    }

    #[test]
    fn parse_cargo_lock_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Cargo.lock");
        std::fs::write(&path, "").unwrap();
        let pkgs = parse_cargo_lock(&path).unwrap();
        assert!(pkgs.is_empty());
    }

    #[test]
    fn parse_go_sum_simple() {
        let dir = tempfile::tempdir().unwrap();
        let go_sum = dir.path().join("go.sum");
        std::fs::write(&go_sum, r#"
github.com/gorilla/mux v1.8.1 h1:TuBL1KLIqAB+DKfcbkF6K9ZNV3ziLKPeQW7c3rFMJ0E=
github.com/gorilla/mux v1.8.1/go.mod h1:AKf9I4AEqPTmMytcMc0KkNouC66V3BtZ4qD8fgaB5bo=
github.com/stretchr/testify v1.8.4 h1:CcVxWJTDXMVBZz2vNFrKRmaFD9JrLLrJSMUuXVqosBc=
"#).unwrap();
        let pkgs = parse_go_sum(&go_sum).unwrap();
        assert_eq!(pkgs.len(), 2); // go.mod entries excluded
        assert!(pkgs.iter().any(|(m, _, _)| m == "github.com/gorilla/mux"));
        assert!(pkgs.iter().any(|(m, _, _)| m == "github.com/stretchr/testify"));
    }

    #[test]
    fn parse_go_sum_deduplicates_modules() {
        let dir = tempfile::tempdir().unwrap();
        let go_sum = dir.path().join("go.sum");
        std::fs::write(&go_sum,
            "github.com/pkg/errors v0.9.1 h1:abc=\ngithub.com/pkg/errors v0.9.1 h1:abc=\n"
        ).unwrap();
        let pkgs = parse_go_sum(&go_sum).unwrap();
        assert_eq!(pkgs.len(), 1, "Duplicate module versions should be deduplicated");
    }

    #[test]
    fn test_parse_requirements_txt_empty_returns_empty() {
        let packages = parse_requirements_txt("");
        assert!(packages.is_empty());
    }

    #[test]
    fn test_parse_requirements_txt_comment_only() {
        let packages = parse_requirements_txt("# just a comment\n# another\n");
        assert!(packages.is_empty());
    }

    #[test]
    fn test_extract_toml_string_missing_key_returns_none() {
        assert_eq!(extract_toml_string("description = \"A package\"", "name"), None);
    }

    #[test]
    fn test_parse_poetry_lock_empty_returns_empty() {
        let packages = parse_poetry_lock("");
        assert!(packages.is_empty());
    }

    #[test]
    fn test_migrate_lockfile_unknown_format_errors() {
        let tmp = std::env::temp_dir().join("migrate-test-unknown");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = migrate_lockfile(&tmp, "unknown-format");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
