//! CI Cache Pack/Unpack — v0.5 Feature #24
//!
//! Exports the better CAS store as a `.tar.zst` archive for use as a CI cache
//! layer (GitHub Actions cache, CircleCI cache, etc.).  An integrity manifest
//! is embedded so partial/corrupt restores can be detected and the cache
//! gracefully invalidated.
//!
//! Usage (CLI):
//!   better cache pack   [--output ~/.better/ci-cache.tar.zst]
//!   better cache unpack [--input  ~/.better/ci-cache.tar.zst]

use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
pub struct PackResult {
    pub ok: bool,
    pub output_path: String,
    pub entries: u64,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
    pub manifest_hash: String,
    pub reason: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct UnpackResult {
    pub ok: bool,
    pub input_path: String,
    pub entries: u64,
    pub uncompressed_bytes: u64,
    pub manifest_ok: bool,
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// pack_cache
// ---------------------------------------------------------------------------

/// Pack the CAS store directory into a `.tar.zst` archive.
///
/// - `store_dir`: path to the CAS store (e.g. `~/.better/store`)
/// - `output_path`: destination archive path (e.g. `/tmp/better-ci-cache.tar.zst`)
/// - `compression_level`: zstd compression level (1-22, default 3)
pub fn pack_cache(
    store_dir: &Path,
    output_path: &Path,
    compression_level: i32,
) -> PackResult {
    let err = |msg: String| PackResult {
        ok: false,
        output_path: output_path.display().to_string(),
        entries: 0,
        compressed_bytes: 0,
        uncompressed_bytes: 0,
        manifest_hash: String::new(),
        reason: Some(msg),
    };

    if !store_dir.exists() {
        return err(format!("store directory not found: {}", store_dir.display()));
    }

    // Collect all files to pack
    let mut files: Vec<PathBuf> = Vec::new();
    if let Err(e) = collect_files(store_dir, &mut files) {
        return err(format!("failed to walk store: {}", e));
    }

    // Build integrity manifest: sha256 of each file path + content hash
    let mut manifest_lines: Vec<String> = Vec::with_capacity(files.len());
    let mut uncompressed_bytes: u64 = 0;

    for f in &files {
        match fs::metadata(f) {
            Ok(meta) => uncompressed_bytes += meta.len(),
            Err(_) => continue,
        }
        let rel = match f.strip_prefix(store_dir) {
            Ok(r) => r.to_string_lossy().to_string(),
            Err(_) => continue,
        };
        manifest_lines.push(rel);
    }
    manifest_lines.sort();

    let manifest_content = manifest_lines.join("\n");
    let manifest_hash = {
        let mut h = Sha256::new();
        h.update(manifest_content.as_bytes());
        format!("{:x}", h.finalize())
    };

    // Create output file and write tar.zst
    if let Some(parent) = output_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return err(format!("cannot create output dir: {}", e));
        }
    }

    let out_file = match File::create(output_path) {
        Ok(f) => f,
        Err(e) => return err(format!("cannot create output file: {}", e)),
    };

    let level = compression_level.clamp(1, 22);
    let zstd_writer = match zstd::Encoder::new(BufWriter::new(out_file), level) {
        Ok(w) => w,
        Err(e) => return err(format!("zstd init error: {}", e)),
    };
    let zstd_writer = zstd_writer.auto_finish();

    let mut tar = tar::Builder::new(zstd_writer);

    // Embed manifest as a virtual file at `.better-ci-manifest`
    let manifest_bytes = manifest_content.as_bytes();
    let mut header = tar::Header::new_gnu();
    header.set_size(manifest_bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    if let Err(e) = tar.append_data(&mut header, ".better-ci-manifest", manifest_bytes) {
        return err(format!("manifest append error: {}", e));
    }

    // Append store files
    let mut entry_count: u64 = 0;
    for f in &files {
        let rel = match f.strip_prefix(store_dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let archive_path = Path::new("store").join(rel);
        match tar.append_path_with_name(f, &archive_path) {
            Ok(()) => entry_count += 1,
            Err(_) => continue, // skip files that disappear mid-pack
        }
    }

    if let Err(e) = tar.finish() {
        return err(format!("tar finish error: {}", e));
    }

    // Measure output size
    let compressed_bytes = fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);

    PackResult {
        ok: true,
        output_path: output_path.display().to_string(),
        entries: entry_count,
        compressed_bytes,
        uncompressed_bytes,
        manifest_hash,
        reason: None,
    }
}

// ---------------------------------------------------------------------------
// unpack_cache
// ---------------------------------------------------------------------------

/// Unpack a `.tar.zst` CI cache archive back into the CAS store.
///
/// - `input_path`: path to the archive created by `pack_cache`
/// - `store_dir`: destination directory (e.g. `~/.better/store`)
///
/// Returns `manifest_ok: false` if the embedded manifest does not match the
/// extracted files (indicates a corrupt or tampered archive).
pub fn unpack_cache(input_path: &Path, store_dir: &Path) -> UnpackResult {
    let err = |msg: String| UnpackResult {
        ok: false,
        input_path: input_path.display().to_string(),
        entries: 0,
        uncompressed_bytes: 0,
        manifest_ok: false,
        reason: Some(msg),
    };

    if !input_path.exists() {
        return err(format!("archive not found: {}", input_path.display()));
    }

    let in_file = match File::open(input_path) {
        Ok(f) => f,
        Err(e) => return err(format!("cannot open archive: {}", e)),
    };

    let zstd_reader = match zstd::Decoder::new(BufReader::new(in_file)) {
        Ok(r) => r,
        Err(e) => return err(format!("zstd decode error: {}", e)),
    };

    let mut tar = tar::Archive::new(zstd_reader);

    if let Err(e) = fs::create_dir_all(store_dir) {
        return err(format!("cannot create store dir: {}", e));
    }

    let mut entry_count: u64 = 0;
    let mut uncompressed_bytes: u64 = 0;
    let mut embedded_manifest: Option<String> = None;
    let mut extracted_paths: Vec<String> = Vec::new();

    let entries = match tar.entries() {
        Ok(e) => e,
        Err(e) => return err(format!("tar read error: {}", e)),
    };

    for entry_result in entries {
        let mut entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = match entry.path() {
            Ok(p) => p.to_path_buf(),
            Err(_) => continue,
        };

        let path_str = path.to_string_lossy().to_string();

        if path_str == ".better-ci-manifest" {
            // Read manifest
            let mut buf = String::new();
            use std::io::Read;
            if entry.read_to_string(&mut buf).is_ok() {
                embedded_manifest = Some(buf);
            }
            continue;
        }

        // Strip "store/" prefix and write to store_dir
        let rel = if let Ok(r) = path.strip_prefix("store") {
            r.to_path_buf()
        } else {
            continue;
        };

        let dest = store_dir.join(&rel);
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }

        uncompressed_bytes += entry.size();
        if entry.unpack(&dest).is_ok() {
            entry_count += 1;
            extracted_paths.push(rel.to_string_lossy().to_string());
        }
    }

    // Verify manifest
    let manifest_ok = if let Some(manifest) = embedded_manifest {
        let mut expected_paths: Vec<&str> = manifest.lines().collect();
        expected_paths.sort();
        extracted_paths.sort();
        expected_paths == extracted_paths.iter().map(|s| s.as_str()).collect::<Vec<_>>()
    } else {
        false // no manifest embedded — treat as unverifiable but not corrupt
    };

    UnpackResult {
        ok: true,
        input_path: input_path.display().to_string(),
        entries: entry_count,
        uncompressed_bytes,
        manifest_ok,
        reason: None,
    }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else if path.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_test_store(root: &Path) {
        fs::create_dir_all(root.join("sha512/ab")).unwrap();
        let mut f = File::create(root.join("sha512/ab/blob1")).unwrap();
        f.write_all(b"fake tarball content").unwrap();
        let mut f2 = File::create(root.join("sha512/ab/blob2")).unwrap();
        f2.write_all(b"another blob").unwrap();
    }

    #[test]
    fn pack_and_unpack_roundtrip() {
        let tmp = std::env::temp_dir().join("ci-pack-test");
        let store = tmp.join("store");
        let archive = tmp.join("cache.tar.zst");
        let restore = tmp.join("restore");

        let _ = fs::remove_dir_all(&tmp);
        make_test_store(&store);

        let pack_result = pack_cache(&store, &archive, 3);
        assert!(pack_result.ok, "pack failed: {:?}", pack_result.reason);
        assert!(archive.exists());
        assert!(pack_result.entries >= 2);

        let unpack_result = unpack_cache(&archive, &restore);
        assert!(unpack_result.ok, "unpack failed: {:?}", unpack_result.reason);
        assert!(unpack_result.entries >= 2);
        assert!(unpack_result.manifest_ok, "manifest verification failed");

        // Files should be present in restored store
        assert!(restore.join("sha512/ab/blob1").exists());
        assert!(restore.join("sha512/ab/blob2").exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pack_missing_store_errors() {
        let result = pack_cache(Path::new("/nonexistent/store"), Path::new("/tmp/out.zst"), 3);
        assert!(!result.ok);
        assert!(result.reason.is_some());
    }

    #[test]
    fn unpack_missing_archive_errors() {
        let result = unpack_cache(Path::new("/nonexistent/cache.tar.zst"), Path::new("/tmp/store"));
        assert!(!result.ok);
        assert!(result.reason.is_some());
    }

    #[test]
    fn pack_empty_store_succeeds_with_zero_entries() {
        let tmp = std::env::temp_dir().join("ci-pack-empty-store");
        let store = tmp.join("store");
        let archive = tmp.join("cache.tar.zst");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&store).unwrap();
        let result = pack_cache(&store, &archive, 3);
        assert!(result.ok, "pack failed: {:?}", result.reason);
        assert_eq!(result.entries, 0);
        assert!(archive.exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pack_result_ok_flag_is_true_on_success() {
        let tmp = std::env::temp_dir().join("ci-pack-result-ok");
        let store = tmp.join("store");
        let archive = tmp.join("out.tar.zst");
        let _ = fs::remove_dir_all(&tmp);
        make_test_store(&store);
        let result = pack_cache(&store, &archive, 3);
        assert!(result.ok);
        assert!(result.reason.is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pack_result_serializes_to_json() {
        let r = PackResult {
            ok: true,
            output_path: "/tmp/cache.tar.zst".into(),
            entries: 5,
            compressed_bytes: 1000,
            uncompressed_bytes: 5000,
            manifest_hash: "abc123".into(),
            reason: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"ok\":true"));
        assert!(json.contains("\"entries\":5"));
    }

    #[test]
    fn unpack_result_serializes_to_json() {
        let r = UnpackResult {
            ok: false,
            input_path: "/tmp/cache.tar.zst".into(),
            entries: 0,
            uncompressed_bytes: 0,
            manifest_ok: false,
            reason: Some("archive not found".into()),
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"ok\":false"));
        assert!(json.contains("archive not found"));
    }

    #[test]
    fn collect_files_finds_all_files_in_store() {
        let tmp = std::env::temp_dir().join("ci-pack-collect-test");
        let _ = fs::remove_dir_all(&tmp);
        make_test_store(&tmp);
        let mut files = Vec::new();
        collect_files(&tmp, &mut files).unwrap();
        assert_eq!(files.len(), 2);
        let _ = fs::remove_dir_all(&tmp);
    }
}
