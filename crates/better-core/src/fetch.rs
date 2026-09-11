use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::types::*;
use crate::package_name_from_path;

// --- Install engine: resolve and fetch ---

/// Bounded process-resident parsing cache. Every request still reads and hashes
/// the current bytes; installed trees and mtime markers are never trusted here.
#[derive(Default)]
struct ParsedLockCache {
    entries: std::collections::VecDeque<([u8; 32], usize, std::sync::Arc<ResolveResult>)>,
    input_bytes: usize,
}
impl ParsedLockCache {
    fn resolve(&mut self, content: &str) -> Result<(std::sync::Arc<ResolveResult>, bool), String> {
        use sha2::{Digest, Sha256};
        let key: [u8; 32] = Sha256::digest(content.as_bytes()).into();
        if let Some(position) = self.entries.iter().position(|entry| entry.0 == key) {
            let entry = self.entries.remove(position).unwrap();
            let result = entry.2.clone();
            self.entries.push_back(entry);
            return Ok((result, true));
        }
        let result = std::sync::Arc::new(parse_npm_lockfile(content)?);
        const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;
        if content.len() <= MAX_INPUT_BYTES && result.packages.len() <= 20_000 {
            while self.entries.len() >= 8 || self.input_bytes + content.len() > MAX_INPUT_BYTES {
                if let Some((_, bytes, _)) = self.entries.pop_front() { self.input_bytes -= bytes; }
                else { break; }
            }
            self.input_bytes += content.len();
            self.entries.push_back((key, content.len(), result.clone()));
        }
        Ok((result, false))
    }
}

/// Resolve immutable parsed input for resident consumers without cloning the
/// package vector. Cache lifetime is this binary's parse-schema lifetime.
pub fn resolve_from_lockfile_shared(lockfile_path: &Path) -> Result<std::sync::Arc<ResolveResult>, String> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<ParsedLockCache>> = std::sync::OnceLock::new();
    let content = fs::read_to_string(lockfile_path).map_err(|e| e.to_string())?;
    let mut cache = CACHE.get_or_init(Default::default).lock().map_err(|_| "Parsed lock cache poisoned".to_string())?;
    cache.resolve(&content).map(|(result, _)| result)
}

/// Compatibility boundary for callers that require an owned package vector.
pub fn resolve_from_lockfile(lockfile_path: &Path) -> Result<ResolveResult, String> {
    resolve_from_lockfile_shared(lockfile_path).map(|result| (*result).clone())
}

fn parse_npm_lockfile(json: &str) -> Result<ResolveResult, String> {
    let mut lockfile: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("Invalid package-lock.json: {}", e))?;
    let entries = lockfile.get_mut("packages").and_then(serde_json::Value::as_object_mut)
        .map(std::mem::take)
        .ok_or_else(|| "Lockfile 'packages' must be an object".to_string())?;

    let mut packages = Vec::with_capacity(entries.len());
    let mut root_selection = None;
    for (rel_path, entry) in entries {
        if rel_path.is_empty() {
            if entry.get("workspaces").is_some_and(|value| value != &serde_json::json!([])) {
                return Err("Native install does not support root workspaces; use npm install for this project".to_string());
            }
            root_selection = Some(parse_selection(&rel_path, entry)?);
            continue;
        }
        if !rel_path.starts_with("node_modules/") {
            return Err(format!("Native install does not support workspace/local lockfile entry '{}'; use npm install for this project", rel_path));
        }
        packages.push(parse_package_entry(&rel_path, entry)?);
    }
    Ok(ResolveResult { packages, root_selection, lockfile_version: 3 })
}

fn parse_package_entry(rel_path: &str, entry: serde_json::Value) -> Result<ResolvedPackage, String> {
    let serde_json::Value::Object(entry) = entry else {
        return Err(format!("Lockfile entry '{}' must be an object", rel_path));
    };
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
    let version = required_string("version")?;
    let resolved_url = required_string("resolved")?;
    let integrity = required_string("integrity")?;
    Ok(ResolvedPackage {
        selection: parse_selection(rel_path, serde_json::Value::Object(entry))?,
        name,
        version,
        rel_path: rel_path.to_string(),
        resolved_url,
        integrity,
    })
}


fn parse_selection(rel_path: &str, entry: serde_json::Value) -> Result<PackageSelection, String> {
    let serde_json::Value::Object(mut fields) = entry else {
        return Err(format!("Lockfile entry '{}' must be an object", rel_path));
    };
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
    fetch_packages_with_options(packages, cache_dir, npmrc, &crate::fetch_pipeline::FetchOptions::default())
}

pub fn fetch_packages_with_options(
    packages: &[ResolvedPackage], cache_dir: &Path, npmrc: Option<&NpmrcConfig>,
    options: &crate::fetch_pipeline::FetchOptions,
) -> Result<FetchResult, String> {
    options.validate()?;
    use crate::integrity::Integrity;
    use crate::fetch_pipeline::{stream_to_staging, extract_verified_tarball};
    let limits = options.limits;

    let layout = CasLayout::new(cache_dir);

    // Ensure directories exist
    fs::create_dir_all(&layout.tarballs_dir).map_err(|e| format!("Failed to create tarballs dir: {}", e))?;
    fs::create_dir_all(&layout.unpacked_dir).map_err(|e| format!("Failed to create unpacked dir: {}", e))?;
    fs::create_dir_all(&layout.tmp_dir).map_err(|e| format!("Failed to create tmp dir: {}", e))?;

    // Shared statistics
    let packages_fetched = AtomicU64::new(0);
    let packages_cached = AtomicU64::new(0);
    let bytes_downloaded = AtomicU64::new(0);

    let http_client = std::sync::OnceLock::new();

    // Validate identities before work and coalesce duplicate installation paths.
    let mut unique = std::collections::BTreeMap::new();
    for pkg in packages {
        let identity = Integrity::parse(&pkg.integrity)?;
        let key = (identity.algorithm(), identity.hex_digest());
        let hex = key.1.clone();
        let entry = unique.entry(key).or_insert((pkg, 0_u64, identity, hex));
        entry.1 += 1;
    }
    let unique: Vec<_> = unique.into_values().collect();
    let metrics = crate::fetch_scheduler::run_retry_pipeline(&unique, options.network_jobs, options.extract_jobs,
      |(pkg, multiplicity, integrity, hex)| {
        let algo = integrity.algorithm();
        let artifact = crate::artifact_cache::ArtifactCache::new(cache_dir, algo, hex);
        let verify = |path: &Path| -> Result<(), String> {
            let file = fs::File::open(path).map_err(|e| e.to_string())?;
            let compressed_bytes = file.metadata().map_err(|e| e.to_string())?.len();
            if compressed_bytes > limits.compressed_bytes {
                return Err("Cached archive exceeds compressed byte limit; increase --max-tarball-bytes".into());
            }
            let _permit = crate::artifact_cache::acquire_hash_permit(cache_dir, compressed_bytes)?;
            integrity.verify_reader(file)
        };
        let Some(reader) = artifact.try_read_lock()? else { return Ok(crate::fetch_scheduler::Preparation::Deferred); };
        if artifact.ready() {
            verify(&artifact.tarball)?;
            packages_cached.fetch_add(*multiplicity, Ordering::Relaxed);
            return Ok(crate::fetch_scheduler::Preparation::Complete(None));
        }
        drop(reader);
        let Some(_content_lock) = artifact.try_lock()? else { return Ok(crate::fetch_scheduler::Preparation::Deferred); };
        // Another producer may have completed while this worker was waiting.
        if artifact.ready() {
            verify(&artifact.tarball)?;
            packages_cached.fetch_add(*multiplicity, Ordering::Relaxed);
            return Ok(crate::fetch_scheduler::Preparation::Complete(None));
        }
        let retained = artifact.retained_tarball(verify)?;
        if !retained {
            let client = http_client.get_or_init(crate::transport::client).as_ref().map_err(Clone::clone)?;
            let response = crate::transport::download(client, pkg, npmrc)?;

            if response.content_length().is_some_and(|size| size > limits.compressed_bytes) {
                return Err("Tarball exceeds compressed byte limit; increase --max-tarball-bytes".into());
            }
            let stage = artifact.create_download()?;
            let source = stage.path().join("archive.tgz");
            let file = fs::File::create(&source).map_err(|e| e.to_string())?;
            let mut verifier = integrity.verifier();
            let byte_count = stream_to_staging(response, file, limits.compressed_bytes,
                |chunk| verifier.update(chunk))?;
            verifier.finish()?;
            // The private staged file was verified incrementally before publication.
            artifact.publish_tarball(&source, |_| Ok(()))?;
            bytes_downloaded.fetch_add(byte_count, Ordering::Relaxed);
            packages_fetched.fetch_add(1, Ordering::Relaxed);
        } else {
            packages_cached.fetch_add(1, Ordering::Relaxed);
        }
        packages_cached.fetch_add(multiplicity - 1, Ordering::Relaxed);
        // Keep the producer lock alive through handoff and final publication.
        Ok(crate::fetch_scheduler::Preparation::Complete(Some((artifact, _content_lock))))
      },
      |(artifact, _content_lock)| {
        artifact.extract_and_publish(|source, destination| {
            let _permit = crate::artifact_cache::acquire_resource_permit(cache_dir)?;
            extract_verified_tarball(source, destination, limits)
        })
      })?;

    Ok(FetchResult {
        metrics,
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

#[cfg(test)]
mod resident_plan_tests {
    use super::*;
    #[test]
    fn identical_bytes_reuse_parse_and_changed_bytes_invalidate() {
        let mut cache = ParsedLockCache::default();
        let input = r#"{"packages":{"":{"dependencies":{}}}}"#;
        let (first, hit) = cache.resolve(input).unwrap();
        assert!(!hit);
        let (second, hit) = cache.resolve(input).unwrap();
        assert!(hit);
        assert!(std::sync::Arc::ptr_eq(&first, &second));
        let (changed, hit) = cache.resolve(r#"{"packages":{"":{"dependencies":{"new":"1"}}}}"#).unwrap();
        assert!(!hit);
        assert!(!std::sync::Arc::ptr_eq(&first, &changed));
        assert!(cache.resolve("invalid").is_err());
    }
    #[test]
    fn resident_parse_cache_evicts_old_inputs() {
        let mut cache = ParsedLockCache::default();
        for index in 0..16 {
            cache.resolve(&format!(r#"{{"packages":{{}},"extra":{index}}}"#)).unwrap();
        }
        assert_eq!(cache.entries.len(), 8);
        assert!(cache.input_bytes <= 8 * 1024 * 1024);
    }
}
