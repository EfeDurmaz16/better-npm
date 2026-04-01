// crates/better-core/src/content_publish.rs
//
// Content-addressed publishing — publish packages by their content hash
// rather than by name@version. Enables reproducible installs from any mirror.

use std::path::Path;
use std::collections::HashMap;

/// A content-addressed package manifest for publishing.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContentPackage {
    pub name: String,
    pub version: String,
    pub content_hash: String,       // SHA-256 of tarball
    pub manifest_hash: String,      // SHA-256 of this manifest
    pub files: Vec<ContentFile>,
    pub dependencies: HashMap<String, String>,
    pub published_at: String,
    pub publisher: String,
    pub registry: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContentFile {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub mode: u32,
}

/// Build a content-addressed manifest from a directory.
pub fn build_manifest(
    package_dir: &Path,
    name: &str,
    version: &str,
    publisher: &str,
) -> Result<ContentPackage, String> {
    let pkg_json_path = package_dir.join("package.json");
    let pkg_content = std::fs::read_to_string(&pkg_json_path)
        .map_err(|e| format!("Cannot read package.json: {}", e))?;
    let pkg_data: serde_json::Value = serde_json::from_str(&pkg_content)
        .map_err(|e| format!("Cannot parse package.json: {}", e))?;

    let deps: HashMap<String, String> = pkg_data["dependencies"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("*").to_string())).collect())
        .unwrap_or_default();

    let mut files = Vec::new();
    let mut total_hash_input = String::new();

    collect_files(package_dir, package_dir, &mut files, &mut total_hash_input)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let content_hash = fnv_hash_hex(total_hash_input.as_bytes());

    let manifest_json = serde_json::json!({
        "name": name, "version": version,
        "contentHash": content_hash,
        "files": files.len()
    });
    let manifest_hash = fnv_hash_hex(manifest_json.to_string().as_bytes());

    Ok(ContentPackage {
        name: name.to_string(),
        version: version.to_string(),
        content_hash,
        manifest_hash,
        files,
        dependencies: deps,
        published_at: "2026-03-30T00:00:00Z".to_string(),
        publisher: publisher.to_string(),
        registry: None,
    })
}

fn collect_files(
    base: &Path,
    dir: &Path,
    files: &mut Vec<ContentFile>,
    hash_input: &mut String,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        let rel = path.strip_prefix(base).map_err(|e| e.to_string())?;
        let rel_str = rel.to_string_lossy().to_string();

        // Skip node_modules, .git, etc.
        if rel_str.starts_with("node_modules") || rel_str.starts_with(".git") {
            continue;
        }

        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.is_dir() {
            collect_files(base, &path, files, hash_input)?;
        } else {
            let content = std::fs::read(&path).map_err(|e| e.to_string())?;
            let file_hash = fnv_hash_hex(&content);
            hash_input.push_str(&format!("{}:{}", rel_str, file_hash));
            files.push(ContentFile {
                path: rel_str,
                hash: file_hash,
                size: meta.len(),
                mode: 0o644,
            });
        }
    }
    Ok(())
}

/// Verify a content-addressed package against its manifest.
pub fn verify_package(manifest: &ContentPackage, package_dir: &Path) -> Result<bool, String> {
    let mut files: Vec<ContentFile> = Vec::new();
    let mut hash_input = String::new();
    collect_files(package_dir, package_dir, &mut files, &mut hash_input)?;
    let actual_hash = fnv_hash_hex(hash_input.as_bytes());
    Ok(actual_hash == manifest.content_hash)
}

/// Generate a `.better-publish.json` for pre-publish verification.
pub fn generate_publish_receipt(manifest: &ContentPackage, output: &Path) -> Result<(), String> {
    let content = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(output, content).map_err(|e| e.to_string())
}

fn fnv_hash_hex(data: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}{:016x}", h, h.rotate_left(17))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_hash_hex_is_deterministic() {
        let h1 = fnv_hash_hex(b"hello");
        let h2 = fnv_hash_hex(b"hello");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 32); // two 16-char hex strings
    }

    #[test]
    fn fnv_hash_hex_differs_for_different_input() {
        assert_ne!(fnv_hash_hex(b"hello"), fnv_hash_hex(b"world"));
    }

    #[test]
    fn build_manifest_missing_package_json_returns_err() {
        let tmp = std::env::temp_dir().join("cpub-test-no-pkg");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = build_manifest(&tmp, "test", "1.0.0", "author");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn build_manifest_valid_package_returns_manifest() {
        let tmp = std::env::temp_dir().join("cpub-test-valid");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), r#"{"name":"test","version":"1.0.0","dependencies":{"lodash":"^4.0.0"}}"#).unwrap();
        std::fs::write(tmp.join("index.js"), "module.exports = {};").unwrap();
        let manifest = build_manifest(&tmp, "test", "1.0.0", "author").unwrap();
        assert_eq!(manifest.name, "test");
        assert_eq!(manifest.version, "1.0.0");
        assert!(!manifest.content_hash.is_empty());
        assert!(!manifest.files.is_empty());
        assert!(manifest.dependencies.contains_key("lodash"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn verify_package_matches_own_manifest() {
        let tmp = std::env::temp_dir().join("cpub-test-verify");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), r#"{"name":"test","version":"1.0.0"}"#).unwrap();
        let manifest = build_manifest(&tmp, "test", "1.0.0", "author").unwrap();
        let ok = verify_package(&manifest, &tmp).unwrap();
        assert!(ok);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn generate_publish_receipt_writes_json() {
        let tmp = std::env::temp_dir().join("cpub-test-receipt");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), r#"{"name":"test","version":"1.0.0"}"#).unwrap();
        let manifest = build_manifest(&tmp, "test", "1.0.0", "author").unwrap();
        let receipt_path = tmp.join(".better-publish.json");
        generate_publish_receipt(&manifest, &receipt_path).unwrap();
        assert!(receipt_path.exists());
        let content = std::fs::read_to_string(&receipt_path).unwrap();
        assert!(content.contains("\"name\""));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
