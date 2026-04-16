use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::types::*;
use crate::{extract_json_field, package_name_from_path, registry_for_package};

// --- Install engine: resolve and fetch ---

/// Parse package-lock.json and extract packages to install
pub fn resolve_from_lockfile(lockfile_path: &Path) -> Result<ResolveResult, String> {
    let content = fs::read_to_string(lockfile_path).map_err(|e| e.to_string())?;

    // Simple JSON parsing without serde
    let packages = parse_npm_lockfile(&content)?;

    Ok(ResolveResult {
        packages,
        lockfile_version: 3,
    })
}

fn parse_npm_lockfile(json: &str) -> Result<Vec<ResolvedPackage>, String> {
    let mut packages = Vec::new();

    // Find the "packages" object
    let packages_start = json
        .find(r#""packages""#)
        .ok_or_else(|| "Missing 'packages' field in lockfile".to_string())?;

    let after_packages = &json[packages_start..];
    let obj_start = after_packages
        .find('{')
        .ok_or_else(|| "Malformed packages object".to_string())?;

    // Simple state machine to parse package entries
    let packages_str = &after_packages[obj_start..];
    let mut current_key = String::new();
    let mut in_string = false;
    let mut escape_next = false;
    let mut brace_depth = 0i32;
    let mut collecting_entry = false;
    let mut entry_data = String::new();
    // State for key tracking at depth 1:
    // 0 = waiting for opening quote, 1 = reading key, 2 = key done (waiting for ':' then value)
    let mut key_state = 0u8;

    for ch in packages_str.chars() {
        if escape_next {
            if key_state == 1 {
                current_key.push(ch);
            } else if collecting_entry {
                entry_data.push(ch);
            }
            escape_next = false;
            continue;
        }

        if ch == '\\' && in_string {
            escape_next = true;
            if key_state == 1 {
                current_key.push(ch);
            } else if collecting_entry {
                entry_data.push(ch);
            }
            continue;
        }

        if ch == '"' {
            in_string = !in_string;

            if brace_depth == 1 && !collecting_entry {
                // Key tracking at depth 1
                if key_state == 0 && in_string {
                    // Opening quote of a key
                    key_state = 1;
                    current_key.clear();
                } else if key_state == 1 && !in_string {
                    // Closing quote of a key
                    key_state = 2;
                } else if key_state == 2 && in_string {
                    // Opening quote of a string value at depth 1 — skip
                } else if key_state == 2 && !in_string {
                    // Closing quote of a string value at depth 1
                }
            } else if collecting_entry {
                entry_data.push(ch);
            }
            continue;
        }

        if in_string {
            if key_state == 1 {
                current_key.push(ch);
            } else if collecting_entry {
                entry_data.push(ch);
            }
            continue;
        }

        // Not in string
        if ch == '{' {
            brace_depth += 1;
            if brace_depth == 2 {
                if !current_key.is_empty()
                    && current_key.starts_with("node_modules/")
                {
                    collecting_entry = true;
                    entry_data.clear();
                }
                key_state = 0;
            }
            if collecting_entry && brace_depth > 2 {
                entry_data.push(ch);
            }
        } else if ch == '}' {
            if collecting_entry && brace_depth == 2 {
                // Parse this entry
                if let Ok(pkg) = parse_package_entry(&current_key, &entry_data) {
                    packages.push(pkg);
                }
                collecting_entry = false;
                entry_data.clear();
            } else if collecting_entry {
                entry_data.push(ch);
            }
            brace_depth -= 1;
            if brace_depth == 0 {
                break;
            }
            if brace_depth == 1 {
                key_state = 0; // Ready for next key
            }
        } else if ch == ',' && brace_depth == 1 && !collecting_entry {
            key_state = 0; // Ready for next key after comma
        } else if collecting_entry {
            entry_data.push(ch);
        }
    }

    Ok(packages)
}

fn parse_package_entry(rel_path: &str, entry_json: &str) -> Result<ResolvedPackage, String> {
    let name = extract_json_field(entry_json, "name")
        .unwrap_or_else(|| package_name_from_path(rel_path));
    let version = extract_json_field(entry_json, "version")
        .ok_or_else(|| format!("Missing version for {}", rel_path))?;
    let resolved = extract_json_field(entry_json, "resolved")
        .ok_or_else(|| format!("Missing resolved URL for {}", rel_path))?;
    let integrity = extract_json_field(entry_json, "integrity")
        .ok_or_else(|| format!("Missing integrity for {}", rel_path))?;

    Ok(ResolvedPackage {
        name,
        version,
        rel_path: rel_path.to_string(),
        resolved_url: resolved,
        integrity,
    })
}


/// Parse integrity string (e.g., "sha512-base64...") into (algorithm, hex_string)
pub fn cas_key_from_integrity(integrity: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = integrity.splitn(2, '-').collect();
    if parts.len() != 2 {
        return None;
    }

    let algo = parts[0];
    let base64_hash = parts[1];

    // Decode base64 to bytes
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, base64_hash).ok()?;

    // Convert to hex string
    let hex = bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>();

    Some((algo.to_string(), hex))
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

/// Fetch tarballs for resolved packages with parallel downloads and CAS storage
pub fn fetch_packages(
    packages: &[ResolvedPackage],
    cache_dir: &Path,
    npmrc: Option<&NpmrcConfig>,
) -> Result<FetchResult, String> {
    use rayon::prelude::*;
    use sha2::{Digest, Sha512};

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
    let http_client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .http2_adaptive_window(true)
        .pool_max_idle_per_host(10)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Process packages in parallel
    packages.par_iter().try_for_each(|pkg| -> Result<(), String> {
        // Parse integrity
        let (algo, hex) = cas_key_from_integrity(&pkg.integrity)
            .ok_or_else(|| format!("Invalid integrity format: {}", pkg.integrity))?;

        let tarball = tarball_path(&layout, &algo, &hex);
        let unpacked = unpacked_path(&layout, &algo, &hex);
        let verified_marker = tarball.with_extension("tgz.verified");
        let extracted_marker = unpacked.join(".better_extracted");

        // Check if already cached and verified
        if verified_marker.exists() && extracted_marker.exists() {
            packages_cached.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }

        // Stream: download → hash → save tarball → decompress → extract (single pass)
        if !verified_marker.exists() || !extracted_marker.exists() {
            // Ensure parent directories exist
            if let Some(parent) = tarball.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("Failed to create tarball parent dir: {}", e))?;
            }
            fs::create_dir_all(&unpacked)
                .map_err(|e| format!("Failed to create unpacked dir: {}", e))?;

            let mut download_url = pkg.resolved_url.clone();
            let mut auth_token: Option<&str> = None;
            if let Some(cfg) = npmrc {
                let (_reg, tok) = registry_for_package(cfg, &pkg.name);
                auth_token = tok;
                if !cfg.default_registry.starts_with("https://registry.npmjs.org")
                    && download_url.starts_with("https://registry.npmjs.org/")
                {
                    download_url = download_url.replacen(
                        "https://registry.npmjs.org/",
                        cfg.default_registry.trim_end_matches('/').to_string().as_str(),
                        1,
                    );
                    if !download_url.contains("://") {
                        download_url = format!("{}/{}", cfg.default_registry.trim_end_matches('/'), &download_url);
                    }
                }
            }

            let mut request = http_client.get(&download_url);
            if let Some(token) = auth_token {
                request = request.header("Authorization", format!("Bearer {}", token));
            }
            let response = request
                .send()
                .map_err(|e| format!("Failed to download {}: {}", pkg.name, e))?;

            // Read full response bytes (needed for both hashing and extraction)
            let bytes = response.bytes()
                .map_err(|e| format!("Failed to read download: {}", e))?;
            let byte_count = bytes.len() as u64;

            // Hash on-the-fly from the in-memory buffer
            let mut hasher = Sha512::new();
            hasher.update(&bytes);
            let computed_hex = format!("{:x}", hasher.finalize());

            if algo == "sha512" && computed_hex != hex {
                return Err(format!("Integrity mismatch for {}: expected {}, got {}", pkg.name, hex, computed_hex));
            }

            // Stream: decompress → extract directly from memory (no temp file round-trip)
            let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(&bytes));
            let mut archive = tar::Archive::new(gz);
            archive.unpack(&unpacked)
                .map_err(|e| format!("Failed to extract tarball: {}", e))?;

            // Persist tarball to CAS for future cache hits
            let tmp_file = layout.tmp_dir.join(format!("{}.tgz.tmp", hex));
            fs::write(&tmp_file, &bytes)
                .map_err(|e| format!("Failed to write tarball: {}", e))?;
            fs::rename(&tmp_file, &tarball)
                .map_err(|e| format!("Failed to move tarball to CAS: {}", e))?;

            // Write markers
            fs::write(&verified_marker, "")
                .map_err(|e| format!("Failed to write verified marker: {}", e))?;
            fs::write(&extracted_marker, "")
                .map_err(|e| format!("Failed to write extracted marker: {}", e))?;

            bytes_downloaded.fetch_add(byte_count, Ordering::Relaxed);
            packages_fetched.fetch_add(1, Ordering::Relaxed);
        } else {
            packages_cached.fetch_add(1, Ordering::Relaxed);
        }

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
        let integrity = "sha512-AAAA";
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
        let integrity = "sha1-AAAAAAAAAAAAAAAAAAAAAA=="; // valid base64
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
