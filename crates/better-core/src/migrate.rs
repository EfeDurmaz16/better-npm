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
}
