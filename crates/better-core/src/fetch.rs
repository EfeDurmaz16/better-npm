use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::types::*;
use crate::package_name_from_path;

// --- Install engine: resolve and fetch ---

/// Parse package-lock.json and extract packages to install
pub fn resolve_from_lockfile(lockfile_path: &Path) -> Result<ResolveResult, String> {
    let content = fs::read_to_string(lockfile_path).map_err(|e| e.to_string())?;

    parse_npm_lockfile(&content)
}

fn parse_npm_lockfile(json: &str) -> Result<ResolveResult, String> {
    let lockfile: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("Invalid package-lock.json: {}", e))?;
    let entries = lockfile.get("packages").and_then(serde_json::Value::as_object)
        .ok_or_else(|| "Lockfile 'packages' must be an object".to_string())?;

    let mut packages = Vec::new();
    let mut root_selection = None;
    for (rel_path, entry) in entries {
        if rel_path.is_empty() {
            root_selection = Some(parse_selection(rel_path, entry)?);
            if entry.get("workspaces").is_some_and(|value| value != &serde_json::json!([])) {
                return Err("Native install does not support root workspaces; use npm install for this project".to_string());
            }
            continue;
        }
        if !rel_path.starts_with("node_modules/") {
            return Err(format!("Native install does not support workspace/local lockfile entry '{}'; use npm install for this project", rel_path));
        }
        packages.push(parse_package_entry(rel_path, entry)?);
    }
    Ok(ResolveResult { packages, root_selection, lockfile_version: 3 })
}

fn parse_package_entry(rel_path: &str, entry: &serde_json::Value) -> Result<ResolvedPackage, String> {
    let entry = entry.as_object()
        .ok_or_else(|| format!("Lockfile entry '{}' must be an object", rel_path))?;
    match entry.get("link") {
        Some(serde_json::Value::Bool(true)) => {
            return Err(format!("Native install does not support linked lockfile entry '{}'; use npm install for this project", rel_path));
        }
        Some(serde_json::Value::Bool(false)) | None => {}
        Some(_) => return Err(format!("Lockfile entry '{}' requires a boolean 'link'", rel_path)),
    }
    if entry.get("resolved").and_then(serde_json::Value::as_str)
        .is_some_and(|value| value.starts_with("file:") || value.starts_with("workspace:"))
    {
        return Err(format!("Native install does not support local resolution for '{}'; use npm install for this project", rel_path));
    }
    if entry.get("inBundle").and_then(serde_json::Value::as_bool) == Some(true) {
        return Err(format!("Native install does not support bundled lockfile entry '{}'; use npm install for this project", rel_path));
    }
    let required_string = |field: &str| -> Result<String, String> {
        entry.get(field).and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("Lockfile entry '{}' requires a non-empty string '{}'", rel_path, field))
    };
    let name = match entry.get("name") {
        None => package_name_from_path(rel_path),
        Some(_) => required_string("name")?,
    };
    Ok(ResolvedPackage {
        selection: parse_selection(rel_path, &serde_json::Value::Object(entry.clone()))?,
        name,
        version: required_string("version")?,
        rel_path: rel_path.to_string(),
        resolved_url: required_string("resolved")?,
        integrity: required_string("integrity")?,
    })
}


fn parse_selection(rel_path: &str, entry: &serde_json::Value) -> Result<PackageSelection, String> {
    let mut fields = entry.as_object().cloned()
        .ok_or_else(|| format!("Lockfile entry '{}' must be an object", rel_path))?;
    // npm accepts a single platform string as well as an array. Preserve an
    // explicit empty array separately from an absent restriction.
    for key in ["os", "cpu", "libc"] {
        if let Some(serde_json::Value::String(value)) = fields.get(key) {
            fields.insert(key.to_owned(), serde_json::json!([value]));
        }
        if fields.get(key).is_some_and(serde_json::Value::is_null) {
            return Err(format!("Lockfile entry '{}' has invalid '{}' selection metadata", rel_path, key));
        }
    }
    serde_json::from_value(serde_json::Value::Object(fields))
        .map_err(|e| format!("Lockfile entry '{}' has invalid selection metadata: {}", rel_path, e))
}


/// Parse integrity string (e.g., "sha512-base64...") into (algorithm, hex_string)
pub fn cas_key_from_integrity(integrity: &str) -> Option<(String, String)> {
    let parsed = crate::integrity::Integrity::parse(integrity).ok()?;
    Some((parsed.algorithm().to_owned(), parsed.hex_digest()))
}

/// Get tarball path in CAS layout: tarballs_dir/algo/aa/bb/hex.tgz
pub fn tarball_path(layout: &CasLayout, algo: &str, hex: &str) -> PathBuf {
    let aa = &hex[0..2.min(hex.len())];
    let bb = &hex[2..4.min(hex.len())];
    layout.tarballs_dir.join(algo).join(aa).join(bb).join(format!("{}.tgz", hex))
}

/// Get unpacked path in CAS layout: unpacked_dir/algo/aa/bb/hex
pub fn unpacked_path(layout: &CasLayout, algo: &str, hex: &str) -> PathBuf {
    let aa = &hex[0..2.min(hex.len())];
    let bb = &hex[2..4.min(hex.len())];
    layout.unpacked_dir.join(algo).join(aa).join(bb).join(hex)
}

/// A legacy marker alone is not proof that the retained archive matches its identity.
pub fn cached_tarball_is_verified(layout: &CasLayout, value: &str) -> bool {
    let Ok(integrity) = crate::integrity::Integrity::parse(value) else { return false; };
    let path = tarball_path(layout, integrity.algorithm(), &integrity.hex_digest());
    if fs::read_to_string(path.with_extension("tgz.verified")).ok().as_deref()
        != Some(crate::integrity::VERIFIED_MARKER) { return false; }
    let Ok(file) = fs::File::open(path) else { return false; };
    integrity.verify_reader(file).is_ok()
}

/// Fetch tarballs for resolved packages with parallel downloads and CAS storage
pub fn fetch_packages(
    packages: &[ResolvedPackage],
    cache_dir: &Path,
    npmrc: Option<&NpmrcConfig>,
) -> Result<FetchResult, String> {
    use rayon::prelude::*;
    use crate::integrity::Integrity;

    let layout = CasLayout::new(cache_dir);

    // Ensure directories exist
    fs::create_dir_all(&layout.tarballs_dir).map_err(|e| format!("Failed to create tarballs dir: {}", e))?;
    fs::create_dir_all(&layout.unpacked_dir).map_err(|e| format!("Failed to create unpacked dir: {}", e))?;
    fs::create_dir_all(&layout.tmp_dir).map_err(|e| format!("Failed to create tmp dir: {}", e))?;

    // Shared statistics
    let packages_fetched = AtomicU64::new(0);
    let packages_cached = AtomicU64::new(0);
    let bytes_downloaded = AtomicU64::new(0);

    // Shared HTTP/2 client — reuses connections and multiplexes requests
    let http_client = crate::transport::client()?;

    // Validate identities before work and coalesce duplicate installation paths.
    let mut unique = std::collections::BTreeMap::new();
    for pkg in packages {
        let identity = Integrity::parse(&pkg.integrity)?;
        let key = (identity.algorithm(), identity.hex_digest());
        let entry = unique.entry(key).or_insert((pkg, 0_u64));
        entry.1 += 1;
    }
    let unique: Vec<_> = unique.into_values().collect();
    unique.par_iter().try_for_each(|(pkg, multiplicity)| -> Result<(), String> {
        let integrity = Integrity::parse(&pkg.integrity)?;
        let algo = integrity.algorithm();
        let hex = integrity.hex_digest();
        let artifact = crate::artifact_cache::ArtifactCache::new(cache_dir, algo, &hex);
        let _content_lock = artifact.lock()?;
        let verify = |path: &Path| -> Result<(), String> {
            integrity.verify_reader(fs::File::open(path).map_err(|e| e.to_string())?)
        };
        if artifact.ready() {
            artifact.retained_tarball(verify)?;
            packages_cached.fetch_add(*multiplicity, Ordering::Relaxed);
            return Ok(());
        }
        let retained = artifact.retained_tarball(verify)?;
        if !retained {
            let response = crate::transport::download(&http_client, pkg, npmrc)?;

            // Read full response bytes (needed for both hashing and extraction)
            let bytes = response.bytes()
                .map_err(|_| format!("Failed to read download for {}", pkg.name))?;
            let byte_count = bytes.len() as u64;

            integrity.verify(&bytes)?;

            let stage = artifact.create_download()?;
            let source = stage.path().join("archive.tgz");
            fs::write(&source, &bytes).map_err(|e| e.to_string())?;
            artifact.publish_tarball(&source, verify)?;
            bytes_downloaded.fetch_add(byte_count, Ordering::Relaxed);
            packages_fetched.fetch_add(1, Ordering::Relaxed);
        } else {
            packages_cached.fetch_add(1, Ordering::Relaxed);
        }
        packages_cached.fetch_add(multiplicity - 1, Ordering::Relaxed);
        artifact.extract_and_publish(|source, destination| {
            let file = fs::File::open(source).map_err(|e| e.to_string())?;
            let gz = flate2::read::GzDecoder::new(file);
            tar::Archive::new(gz).unpack(destination).map_err(|e| format!("Failed to extract tarball: {e}"))
        })?;

        Ok(())
    })?;

    Ok(FetchResult {
        packages_fetched: packages_fetched.load(Ordering::Relaxed),
        packages_cached: packages_cached.load(Ordering::Relaxed),
        bytes_downloaded: bytes_downloaded.load(Ordering::Relaxed),
    })
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cas_key_from_integrity_valid_sha512() {
        // SHA-512 integrity string in base64
        let integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
        let result = cas_key_from_integrity(integrity);
        assert!(result.is_some());
        let (algo, _hex) = result.unwrap();
        assert_eq!(algo, "sha512");
    }

    #[test]
    fn cas_key_from_integrity_invalid_format() {
        assert!(cas_key_from_integrity("nohyphen").is_none());
    }

    #[test]
    fn tarball_path_has_expected_structure() {
        let layout = CasLayout::new(std::path::Path::new("/tmp/cas"));
        let hex = "abcdef1234567890";
        let p = tarball_path(&layout, "sha512", hex);
        let s = p.to_string_lossy();
        assert!(s.contains("sha512"));
        assert!(s.contains("ab"));
        assert!(s.ends_with(".tgz"));
    }

    #[test]
    fn fetch_packages_empty_list_returns_zero() {
        let tmp = std::env::temp_dir().join("fetch-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = fetch_packages(&[], &tmp, None).unwrap();
        assert_eq!(result.packages_fetched, 0);
        assert_eq!(result.packages_cached, 0);
        assert_eq!(result.bytes_downloaded, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_from_lockfile_missing_returns_err() {
        let result = resolve_from_lockfile(std::path::Path::new("/nonexistent/package-lock.json"));
        assert!(result.is_err());
    }

    #[test]
    fn unpacked_path_has_expected_structure() {
        let layout = CasLayout::new(std::path::Path::new("/tmp/cas"));
        let hex = "abcdef1234567890";
        let p = unpacked_path(&layout, "sha512", hex);
        let s = p.to_string_lossy();
        assert!(s.contains("unpacked"));
        assert!(s.contains("sha512"));
        assert!(s.contains("ab"));
        assert!(!s.ends_with(".tgz"));
    }

    #[test]
    fn cas_key_from_integrity_invalid_base64_returns_none() {
        // Valid format but invalid base64 content
        let result = cas_key_from_integrity("sha512-!!!notbase64!!!");
        assert!(result.is_none());
    }

    #[test]
    fn cas_key_from_integrity_sha1() {
        let integrity = "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA="; // valid base64
        let result = cas_key_from_integrity(integrity);
        assert!(result.is_some());
        let (algo, _) = result.unwrap();
        assert_eq!(algo, "sha1");
    }

    #[test]
    fn tarball_path_and_unpacked_path_share_prefix() {
        let layout = CasLayout::new(std::path::Path::new("/cas"));
        let hex = "deadbeef12345678";
        let tp = tarball_path(&layout, "sha512", hex);
        let up = unpacked_path(&layout, "sha512", hex);
        // Both should have sha512/de/ad/ segment
        assert!(tp.to_string_lossy().contains("/sha512/de/ad/"));
        assert!(up.to_string_lossy().contains("/sha512/de/ad/"));
    }
}
