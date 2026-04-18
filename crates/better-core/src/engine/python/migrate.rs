// Python lockfile migration: parse pip/Pipfile/Poetry/uv lockfiles and
// produce a list of pinned packages for better.lock ingestion.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationSource {
    RequirementsTxt,
    PipfileLock,
    PoetryLock,
    UvLock,
}

impl MigrationSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RequirementsTxt => "requirements.txt",
            Self::PipfileLock => "Pipfile.lock",
            Self::PoetryLock => "poetry.lock",
            Self::UvLock => "uv.lock",
        }
    }
}

#[derive(Debug, Clone)]
pub struct MigratedPackage {
    pub name: String,
    pub version: String,
    pub integrity: Option<String>, // sha256 hex when available
    pub extras: Vec<String>,
    pub source: MigrationSource,
}

pub struct MigrationResult {
    pub source: MigrationSource,
    pub source_path: PathBuf,
    pub packages: Vec<MigratedPackage>,
}

impl MigrationResult {
    pub fn packages_count(&self) -> usize {
        self.packages.len()
    }
}

// ── Auto-detection ────────────────────────────────────────────────────────────

/// Inspect `project_root` for known Python lockfiles; prefer most specific.
pub fn detect_migration_source(project_root: &Path) -> Option<(MigrationSource, PathBuf)> {
    let candidates = [
        ("uv.lock", MigrationSource::UvLock),
        ("poetry.lock", MigrationSource::PoetryLock),
        ("Pipfile.lock", MigrationSource::PipfileLock),
        ("requirements.txt", MigrationSource::RequirementsTxt),
    ];
    for (filename, source) in &candidates {
        let path = project_root.join(filename);
        if path.exists() {
            return Some((*source, path));
        }
    }
    None
}

// ── requirements.txt parser ───────────────────────────────────────────────────

/// Parse a pip-freeze-style `requirements.txt`.
/// Supports `pkg==version` lines and optional `--hash=sha256:...` annotations.
/// Lines starting with `#`, `-r`, `-c`, `-e`, `--` are skipped.
pub fn parse_requirements_txt(content: &str) -> Vec<MigratedPackage> {
    let mut packages = Vec::new();
    for raw_line in content.lines() {
        // Continuation lines (trailing \) are joined but we keep it simple
        let line = raw_line.trim().trim_end_matches('\\').trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('-') {
            continue;
        }
        // Strip inline comment
        let line = line.split('#').next().unwrap_or("").trim();

        // Only handle pinned: name==version
        let Some((name_raw, rest)) = line.split_once("==") else { continue };
        let name = normalize_python_name(name_raw.trim());

        // version may be followed by ; <marker> or --hash= or extras [...]
        let version_str = rest
            .split(';').next().unwrap_or(rest)
            .split("--hash").next().unwrap_or(rest)
            .trim()
            .to_string();

        // Extract sha256 hash if present: --hash=sha256:<hex>
        let integrity = rest.split_once("--hash=sha256:").map(|(_, h)| {
            h.split_whitespace().next().unwrap_or("").to_string()
        });

        if version_str.is_empty() {
            continue;
        }

        packages.push(MigratedPackage {
            name,
            version: version_str,
            integrity,
            extras: vec![],
            source: MigrationSource::RequirementsTxt,
        });
    }
    packages
}

// ── Pipfile.lock parser ───────────────────────────────────────────────────────

/// Parse `Pipfile.lock` (JSON).
/// Structure:  `{ "default": { "pkg": { "version": "==1.0", "hashes": ["sha256:..."] } } }`.
pub fn parse_pipfile_lock(content: &str) -> Result<Vec<MigratedPackage>, String> {
    // Parse with serde_json — already a transitive dep
    let root: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| format!("Pipfile.lock JSON parse error: {e}"))?;

    let mut packages = Vec::new();

    for section_key in ["default", "develop"] {
        let section = match root.get(section_key).and_then(|v| v.as_object()) {
            Some(s) => s,
            None => continue,
        };
        for (raw_name, entry) in section {
            let name = normalize_python_name(raw_name);
            // version looks like "==1.0.0" — strip leading "=="
            let version = entry.get("version")
                .and_then(|v| v.as_str())
                .map(|s| s.trim_start_matches('=').to_string())
                .unwrap_or_default();
            if version.is_empty() {
                continue;
            }

            // hashes: ["sha256:<hex>", ...]
            let integrity = entry.get("hashes")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.first())
                .and_then(|v| v.as_str())
                .and_then(|s| s.strip_prefix("sha256:"))
                .map(|h| h.to_string());

            packages.push(MigratedPackage {
                name, version, integrity, extras: vec![],
                source: MigrationSource::PipfileLock,
            });
        }
    }

    Ok(packages)
}

// ── poetry.lock parser ────────────────────────────────────────────────────────

/// Parse `poetry.lock` (TOML with `[[package]]` sections).
/// We do a minimal hand-rolled parse to avoid adding a TOML dependency.
pub fn parse_poetry_lock(content: &str) -> Vec<MigratedPackage> {
    let mut packages = Vec::new();
    let mut current: HashMap<&str, &str> = HashMap::new();
    let mut in_package = false;

    for line in content.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            if in_package {
                if let Some(pkg) = flush_poetry_entry(&current) {
                    packages.push(pkg);
                }
                current.clear();
            }
            in_package = true;
            continue;
        }
        if in_package && line.starts_with('[') && !line.starts_with("[[") {
            // Entering a sub-table (e.g. [package.dependencies]) — stop collecting
            in_package = false;
            if let Some(pkg) = flush_poetry_entry(&current) {
                packages.push(pkg);
            }
            current.clear();
            continue;
        }
        if !in_package {
            continue;
        }

        // Parse key = "value" lines
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            let v = v.trim().trim_matches('"');
            if matches!(k, "name" | "version") {
                current.insert(k, v);
            }
        }
    }

    // Flush last entry
    if in_package {
        if let Some(pkg) = flush_poetry_entry(&current) {
            packages.push(pkg);
        }
    }

    packages
}

fn flush_poetry_entry(map: &HashMap<&str, &str>) -> Option<MigratedPackage> {
    let name = normalize_python_name(map.get("name")?);
    let version = map.get("version")?.to_string();
    Some(MigratedPackage {
        name, version, integrity: None, extras: vec![],
        source: MigrationSource::PoetryLock,
    })
}

// ── uv.lock parser ────────────────────────────────────────────────────────────

/// Parse `uv.lock` (TOML with `[[package]]` sections, similar to poetry.lock).
pub fn parse_uv_lock(content: &str) -> Vec<MigratedPackage> {
    let mut packages = Vec::new();
    let mut current: HashMap<&str, &str> = HashMap::new();
    let mut in_package = false;

    for line in content.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            if in_package {
                if let Some(pkg) = flush_uv_entry(&current) {
                    packages.push(pkg);
                }
                current.clear();
            }
            in_package = true;
            continue;
        }
        // Sub-table ends the package entry
        if in_package && line.starts_with('[') && !line.starts_with("[[") {
            if let Some(pkg) = flush_uv_entry(&current) {
                packages.push(pkg);
            }
            current.clear();
            in_package = false;
            continue;
        }
        if !in_package {
            continue;
        }

        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            // uv.lock values may be quoted strings or inline tables
            let v = v.trim().trim_matches('"');
            if matches!(k, "name" | "version") {
                current.insert(k, v);
            }
        }
    }
    if in_package {
        if let Some(pkg) = flush_uv_entry(&current) {
            packages.push(pkg);
        }
    }

    packages
}

fn flush_uv_entry(map: &HashMap<&str, &str>) -> Option<MigratedPackage> {
    let name = normalize_python_name(map.get("name")?);
    let version = map.get("version")?.to_string();
    Some(MigratedPackage {
        name, version, integrity: None, extras: vec![],
        source: MigrationSource::UvLock,
    })
}

// ── Main entry point ──────────────────────────────────────────────────────────

/// Migrate an existing Python lockfile into a list of pinned packages.
/// `from` can be `None` (auto-detect) or `Some(MigrationSource)`.
pub fn migrate(
    project_root: &Path,
    from: Option<MigrationSource>,
) -> Result<MigrationResult, String> {
    let (source, path) = if let Some(s) = from {
        let filename = s.as_str();
        (s, project_root.join(filename))
    } else {
        detect_migration_source(project_root)
            .ok_or_else(|| "no Python lockfile found (tried uv.lock, poetry.lock, Pipfile.lock, requirements.txt)".to_string())?
    };

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;

    let packages = match source {
        MigrationSource::RequirementsTxt => parse_requirements_txt(&content),
        MigrationSource::PipfileLock => parse_pipfile_lock(&content)?,
        MigrationSource::PoetryLock => parse_poetry_lock(&content),
        MigrationSource::UvLock => parse_uv_lock(&content),
    };

    Ok(MigrationResult { source, source_path: path, packages })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Normalize Python package name to lowercase-hyphenated form (PEP 503).
fn normalize_python_name(name: &str) -> String {
    name.to_lowercase().replace('_', "-").replace('.', "-")
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_python_name_underscores() {
        assert_eq!(normalize_python_name("Pillow_SIMD"), "pillow-simd");
    }

    #[test]
    fn normalize_python_name_dots() {
        assert_eq!(normalize_python_name("zope.interface"), "zope-interface");
    }

    #[test]
    fn requirements_txt_basic() {
        let content = "requests==2.31.0\nflask==3.0.0\n";
        let pkgs = parse_requirements_txt(content);
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0].name, "requests");
        assert_eq!(pkgs[0].version, "2.31.0");
        assert_eq!(pkgs[1].name, "flask");
    }

    #[test]
    fn requirements_txt_with_hash() {
        let content = "certifi==2024.2.2 --hash=sha256:abc123def\n";
        let pkgs = parse_requirements_txt(content);
        assert_eq!(pkgs.len(), 1);
        assert_eq!(pkgs[0].name, "certifi");
        assert_eq!(pkgs[0].integrity.as_deref(), Some("abc123def"));
    }

    #[test]
    fn requirements_txt_skips_comments_and_flags() {
        let content = "# comment\n-r other.txt\n--extra-index-url https://example.com\nnumpy==1.26.0\n";
        let pkgs = parse_requirements_txt(content);
        assert_eq!(pkgs.len(), 1);
        assert_eq!(pkgs[0].name, "numpy");
    }

    #[test]
    fn requirements_txt_skips_unpinned() {
        let content = "requests>=2.0\nflask==2.0.0\n";
        let pkgs = parse_requirements_txt(content);
        assert_eq!(pkgs.len(), 1);
        assert_eq!(pkgs[0].name, "flask");
    }

    #[test]
    fn requirements_txt_strips_markers() {
        let content = "pywin32==306; sys_platform == 'win32'\n";
        let pkgs = parse_requirements_txt(content);
        assert_eq!(pkgs.len(), 1);
        assert_eq!(pkgs[0].version, "306");
    }

    #[test]
    fn pipfile_lock_basic() {
        let content = r#"{
            "_meta": {},
            "default": {
                "requests": { "version": "==2.31.0", "hashes": ["sha256:deadbeef"] },
                "flask": { "version": "==3.0.0" }
            }
        }"#;
        let pkgs = parse_pipfile_lock(content).unwrap();
        assert_eq!(pkgs.len(), 2);
        let req = pkgs.iter().find(|p| p.name == "requests").unwrap();
        assert_eq!(req.version, "2.31.0");
        assert_eq!(req.integrity.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn pipfile_lock_invalid_json() {
        let result = parse_pipfile_lock("not json");
        assert!(result.is_err());
    }

    #[test]
    fn poetry_lock_basic() {
        let content = "[[package]]\nname = \"requests\"\nversion = \"2.31.0\"\n\
                       [[package]]\nname = \"flask\"\nversion = \"3.0.0\"\n";
        let pkgs = parse_poetry_lock(content);
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0].name, "requests");
        assert_eq!(pkgs[1].version, "3.0.0");
    }

    #[test]
    fn poetry_lock_empty() {
        let pkgs = parse_poetry_lock("");
        assert!(pkgs.is_empty());
    }

    #[test]
    fn uv_lock_basic() {
        let content = "[[package]]\nname = \"httpx\"\nversion = \"0.27.0\"\n\
                       [[package]]\nname = \"anyio\"\nversion = \"4.3.0\"\n";
        let pkgs = parse_uv_lock(content);
        assert_eq!(pkgs.len(), 2);
        assert_eq!(pkgs[0].name, "httpx");
        assert_eq!(pkgs[0].version, "0.27.0");
        assert_eq!(pkgs[1].name, "anyio");
    }

    #[test]
    fn uv_lock_normalizes_name() {
        let content = "[[package]]\nname = \"Pillow_SIMD\"\nversion = \"9.0.0\"\n";
        let pkgs = parse_uv_lock(content);
        assert_eq!(pkgs[0].name, "pillow-simd");
    }

    #[test]
    fn detect_migration_source_none() {
        let tmp = std::env::temp_dir().join("better_migrate_test_empty");
        std::fs::create_dir_all(&tmp).ok();
        let result = detect_migration_source(&tmp);
        assert!(result.is_none());
    }

    #[test]
    fn migrate_source_as_str() {
        assert_eq!(MigrationSource::UvLock.as_str(), "uv.lock");
        assert_eq!(MigrationSource::PoetryLock.as_str(), "poetry.lock");
        assert_eq!(MigrationSource::PipfileLock.as_str(), "Pipfile.lock");
        assert_eq!(MigrationSource::RequirementsTxt.as_str(), "requirements.txt");
    }
}
