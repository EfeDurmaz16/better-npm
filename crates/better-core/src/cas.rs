use std::collections::HashSet;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::types::*;
use crate::{extract_json_field, get_file_mode, chrono_now, JsonWriter};

// --- File-level CAS (Content Addressable Store) ---

/// Get the store path for a file by its SHA-256 content hash.
fn file_store_path(store_root: &Path, hex: &str) -> PathBuf {
    let a = &hex[0..2];
    let b = &hex[2..4];
    store_root
        .join("files")
        .join("sha256")
        .join(a)
        .join(b)
        .join(hex)
}

/// Get the manifest directory for a package.
fn package_manifest_dir(store_root: &Path, algorithm: &str, pkg_hex: &str) -> PathBuf {
    let a = &pkg_hex[0..2];
    let b = &pkg_hex[2..4];
    store_root
        .join("packages")
        .join(algorithm)
        .join(a)
        .join(b)
        .join(pkg_hex)
}

/// Get the manifest path for a package.
fn package_manifest_path(store_root: &Path, algorithm: &str, pkg_hex: &str) -> PathBuf {
    package_manifest_dir(store_root, algorithm, pkg_hex).join("manifest.json")
}

/// Compute SHA-256 hash of a file, return hex string.
fn hash_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let mut file = fs::File::open(path)
        .map_err(|e| format!("Failed to open file for hashing: {}", e))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let n = file.read(&mut buffer)
            .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// Ingest an unpacked package directory into the file-level CAS.
/// Hashes each file with SHA-256, stores unique files in the global store,
/// and writes a package manifest mapping relative paths -> file hashes.
pub fn ingest_to_file_cas(
    store_root: &Path,
    pkg_algorithm: &str,
    pkg_hex: &str,
    unpacked_dir: &Path,
) -> Result<FileCasIngestResult, String> {
    let manifest_path = package_manifest_path(store_root, pkg_algorithm, pkg_hex);

    // If manifest already exists, return early with reused flag
    if manifest_path.exists() {
        // Count files in existing manifest
        let content = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read existing manifest: {}", e))?;

        // Simple count of "type":"file" occurrences
        let file_count = content.matches(r#""type":"file""#).count() as u64;

        return Ok(FileCasIngestResult {
            total_files: file_count,
            new_files: 0,
            existing_files: file_count,
            total_bytes: 0,
            reused: true,
        });
    }

    // Collect all files to process
    let mut files_to_process = Vec::new();

    fn walk_dir(
        dir: &Path,
        rel_prefix: &str,
        files: &mut Vec<(PathBuf, String)>,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir)
            .map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();

            // Skip node_modules and .better_extracted
            if name == "node_modules" || name == ".better_extracted" {
                continue;
            }

            let full_path = entry.path();
            let rel_path = if rel_prefix.is_empty() {
                name.to_string()
            } else {
                format!("{}/{}", rel_prefix, name)
            };

            let metadata = entry.metadata()
                .map_err(|e| format!("Failed to read metadata: {}", e))?;

            if metadata.is_dir() {
                walk_dir(&full_path, &rel_path, files)?;
            } else if metadata.is_file() {
                files.push((full_path, rel_path));
            }
            // Symlinks will be handled separately
        }

        Ok(())
    }

    walk_dir(unpacked_dir, "", &mut files_to_process)?;

    // Process files in parallel using rayon
    use rayon::prelude::*;

    let results: Vec<Result<(String, String, u64, u32, bool), String>> = files_to_process
        .par_iter()
        .map(|(full_path, rel_path)| -> Result<(String, String, u64, u32, bool), String> {
            let hex = hash_file(full_path)?;
            let store_path = file_store_path(store_root, &hex);

            let metadata = fs::metadata(full_path)
                .map_err(|e| format!("Failed to read file metadata: {}", e))?;

            let size = metadata.len();
            let mode = get_file_mode(&metadata);

            let is_new = if !store_path.exists() {
                // Create parent directories
                if let Some(parent) = store_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create store directory: {}", e))?;
                }

                // Atomic write: write to tmp, then rename
                let tmp_path = format!("{}.tmp-{}", store_path.display(), std::process::id());
                fs::copy(full_path, &tmp_path)
                    .map_err(|e| format!("Failed to copy file to store: {}", e))?;

                match fs::rename(&tmp_path, &store_path) {
                    Ok(_) => true,
                    Err(_) => {
                        // Another process may have created it - that's fine
                        let _ = fs::remove_file(&tmp_path);
                        false
                    }
                }
            } else {
                false
            };

            Ok((rel_path.clone(), hex, size, mode, is_new))
        })
        .collect();

    // Collect statistics and file entries
    let mut total_files = 0u64;
    let mut new_files = 0u64;
    let mut existing_files = 0u64;
    let mut total_bytes = 0u64;
    let mut file_entries = Vec::new();

    for result in results {
        let (rel_path, hex, size, mode, is_new) = result?;
        total_files += 1;
        total_bytes += size;

        if is_new {
            new_files += 1;
        } else {
            existing_files += 1;
        }

        file_entries.push((rel_path, hex, size, mode));
    }

    // Handle symlinks (can't be parallelized safely)
    let mut symlink_entries = Vec::new();

    fn collect_symlinks(
        dir: &Path,
        rel_prefix: &str,
        symlinks: &mut Vec<(String, String)>,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir)
            .map_err(|e| format!("Failed to read directory for symlinks: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();

            if name == "node_modules" || name == ".better_extracted" {
                continue;
            }

            let full_path = entry.path();
            let rel_path = if rel_prefix.is_empty() {
                name.to_string()
            } else {
                format!("{}/{}", rel_prefix, name)
            };

            let metadata = entry.metadata()
                .map_err(|e| format!("Failed to read metadata: {}", e))?;

            if metadata.is_dir() {
                collect_symlinks(&full_path, &rel_path, symlinks)?;
            } else if metadata.file_type().is_symlink() {
                let target = fs::read_link(&full_path)
                    .map_err(|e| format!("Failed to read symlink: {}", e))?;
                symlinks.push((rel_path, target.to_string_lossy().to_string()));
            }
        }

        Ok(())
    }

    collect_symlinks(unpacked_dir, "", &mut symlink_entries)?;

    // Build manifest JSON using JsonWriter
    let mut jw = JsonWriter::new();
    jw.begin_object();

    jw.key("version");
    jw.value_u64(1);

    jw.key("pkgAlgorithm");
    jw.value_string(pkg_algorithm);

    jw.key("pkgHex");
    jw.value_string(pkg_hex);

    jw.key("files");
    jw.begin_object();

    // Add file entries
    for (rel_path, hex, size, mode) in file_entries {
        jw.key(&rel_path);
        jw.begin_object();
        jw.key("type");
        jw.value_string("file");
        jw.key("hash");
        jw.value_string(&hex);
        jw.key("size");
        jw.value_u64(size);
        jw.key("mode");
        jw.value_u64(mode as u64);
        jw.end_object();
    }

    // Add symlink entries
    for (rel_path, target) in symlink_entries {
        jw.key(&rel_path);
        jw.begin_object();
        jw.key("type");
        jw.value_string("symlink");
        jw.key("target");
        jw.value_string(&target);
        jw.end_object();
    }

    jw.end_object(); // files

    jw.key("createdAt");
    jw.value_string(&chrono_now());

    jw.key("fileCount");
    jw.value_u64(total_files);

    jw.end_object();

    let manifest_json = jw.finish();

    // Write manifest atomically
    let manifest_dir = package_manifest_dir(store_root, pkg_algorithm, pkg_hex);
    fs::create_dir_all(&manifest_dir)
        .map_err(|e| format!("Failed to create manifest directory: {}", e))?;

    let tmp_manifest = format!("{}.tmp-{}", manifest_path.display(), std::process::id());
    fs::write(&tmp_manifest, manifest_json)
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    fs::rename(&tmp_manifest, &manifest_path)
        .map_err(|e| format!("Failed to rename manifest: {}", e))?;

    Ok(FileCasIngestResult {
        total_files,
        new_files,
        existing_files,
        total_bytes,
        reused: false,
    })
}

/// Materialize a package from file CAS to a destination directory.
/// Creates hardlinks from the global store, falling back to copy.
pub fn materialize_from_file_cas(
    store_root: &Path,
    pkg_algorithm: &str,
    pkg_hex: &str,
    dest_dir: &Path,
    link_strategy: LinkStrategy,
) -> Result<FileCasMaterializeResult, String> {
    let manifest_path = package_manifest_path(store_root, pkg_algorithm, pkg_hex);

    // Read manifest
    let manifest_content = match fs::read_to_string(&manifest_path) {
        Ok(content) => content,
        Err(_) => {
            return Ok(FileCasMaterializeResult {
                ok: false,
                files: 0,
                linked: 0,
                copied: 0,
                symlinks: 0,
            });
        }
    };

    // Parse manifest to extract file entries from the "files" object.
    // Works with single-line JSON (produced by JsonWriter).
    // Format: {"version":1,...,"files":{"rel/path":{"type":"file","hash":"abc","size":1,"mode":420},...}}

    let mut file_entries = Vec::new();
    let mut symlink_entries = Vec::new();

    // Find the "files" object
    if let Some(files_start) = manifest_content.find("\"files\"") {
        let after_files = &manifest_content[files_start + 7..]; // skip "files"
        if let Some(obj_start) = after_files.find('{') {
            let files_section = &after_files[obj_start..];

            // State machine to extract entries from the files object
            let mut depth = 0i32;
            let mut in_string = false;
            let mut escape_next = false;
            let mut current_key = String::new();
            let mut current_entry = String::new();
            let mut reading_key = false;
            let mut collecting_entry = false;
            let mut key_done = false;

            for ch in files_section.chars() {
                if escape_next {
                    if reading_key {
                        current_key.push(ch);
                    } else if collecting_entry {
                        current_entry.push(ch);
                    }
                    escape_next = false;
                    continue;
                }

                if ch == '\\' && in_string {
                    escape_next = true;
                    if reading_key {
                        current_key.push(ch);
                    } else if collecting_entry {
                        current_entry.push(ch);
                    }
                    continue;
                }

                if ch == '"' {
                    in_string = !in_string;
                    if depth == 1 && !collecting_entry {
                        if !key_done && in_string {
                            reading_key = true;
                            current_key.clear();
                        } else if !key_done && !in_string {
                            reading_key = false;
                            key_done = true;
                        }
                    } else if collecting_entry {
                        current_entry.push(ch);
                    }
                    continue;
                }

                if in_string {
                    if reading_key {
                        current_key.push(ch);
                    } else if collecting_entry {
                        current_entry.push(ch);
                    }
                    continue;
                }

                // Outside string
                if ch == '{' {
                    depth += 1;
                    if depth == 2 && key_done {
                        collecting_entry = true;
                        current_entry.clear();
                    } else if depth > 2 && collecting_entry {
                        current_entry.push(ch);
                    }
                } else if ch == '}' {
                    if depth == 2 && collecting_entry {
                        // Parse this entry
                        let entry_type = if current_entry.contains("\"type\":\"file\"") {
                            "file"
                        } else if current_entry.contains("\"type\":\"symlink\"") {
                            "symlink"
                        } else {
                            ""
                        };

                        if entry_type == "file" {
                            if let Some(hash) =
                                extract_json_field(&current_entry, "hash")
                            {
                                file_entries
                                    .push((current_key.clone(), hash));
                            }
                        } else if entry_type == "symlink" {
                            if let Some(tgt) =
                                extract_json_field(&current_entry, "target")
                            {
                                symlink_entries
                                    .push((current_key.clone(), tgt));
                            }
                        }

                        collecting_entry = false;
                        current_entry.clear();
                        key_done = false;
                    } else if depth > 2 && collecting_entry {
                        current_entry.push(ch);
                    }
                    depth -= 1;
                    if depth == 0 {
                        break; // End of "files" object
                    }
                } else if ch == ',' && depth == 1 {
                    key_done = false;
                } else if collecting_entry {
                    current_entry.push(ch);
                }
            }
        }
    }

    // Collect all directories needed (sorted shortest-first)
    let mut dirs_needed = HashSet::new();
    dirs_needed.insert(dest_dir.to_path_buf());

    for (rel_path, _) in &file_entries {
        if let Some(parent_str) = Path::new(rel_path).parent() {
            if parent_str.as_os_str().len() > 0 {
                dirs_needed.insert(dest_dir.join(parent_str));
            }
        }
    }

    for (rel_path, _) in &symlink_entries {
        if let Some(parent_str) = Path::new(rel_path).parent() {
            if parent_str.as_os_str().len() > 0 {
                dirs_needed.insert(dest_dir.join(parent_str));
            }
        }
    }

    let mut sorted_dirs: Vec<PathBuf> = dirs_needed.into_iter().collect();
    sorted_dirs.sort_by_key(|p| p.as_os_str().len());

    // Create all directories
    for dir in sorted_dirs {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // Materialize files in parallel using rayon
    use rayon::prelude::*;

    let file_count = AtomicU64::new(0);
    let linked_count = AtomicU64::new(0);
    let copied_count = AtomicU64::new(0);

    file_entries
        .par_iter()
        .for_each(|(rel_path, hash)| {
            let store_path = file_store_path(store_root, hash);
            let dest_path = dest_dir.join(rel_path);

            file_count.fetch_add(1, Ordering::Relaxed);

            match link_strategy {
                LinkStrategy::Copy => {
                    if fs::copy(&store_path, &dest_path).is_ok() {
                        copied_count.fetch_add(1, Ordering::Relaxed);
                    }
                }
                LinkStrategy::Hardlink | LinkStrategy::Auto => {
                    match fs::hard_link(&store_path, &dest_path) {
                        Ok(_) => {
                            linked_count.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(_) => {
                            if fs::copy(&store_path, &dest_path).is_ok() {
                                copied_count.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                }
            }
        });

    let mut stats = FileCasMaterializeResult {
        ok: true,
        files: file_count.load(Ordering::Relaxed),
        linked: linked_count.load(Ordering::Relaxed),
        copied: copied_count.load(Ordering::Relaxed),
        symlinks: 0,
    };

    // Create symlinks
    for (rel_path, target) in symlink_entries {
        let dest_path = dest_dir.join(&rel_path);

        // Remove existing file/link if present
        let _ = fs::remove_file(&dest_path);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &dest_path)
                .map_err(|e| format!("Failed to create symlink: {}", e))?;
        }

        #[cfg(windows)]
        {
            // On Windows, try to determine if target is a directory
            let target_path = if Path::new(&target).is_absolute() {
                PathBuf::from(&target)
            } else {
                dest_path.parent().unwrap_or(dest_dir).join(&target)
            };

            if target_path.is_dir() {
                std::os::windows::fs::symlink_dir(&target, &dest_path)
                    .map_err(|e| format!("Failed to create directory symlink: {}", e))?;
            } else {
                std::os::windows::fs::symlink_file(&target, &dest_path)
                    .map_err(|e| format!("Failed to create file symlink: {}", e))?;
            }
        }

        stats.symlinks += 1;
    }

    Ok(stats)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn setup_pkg_dir(root: &Path, files: &[(&str, &[u8])]) {
        fs::create_dir_all(root).unwrap();
        for (name, content) in files {
            let path = root.join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(content).unwrap();
        }
    }

    #[test]
    fn ingest_single_file_package() {
        let tmp = std::env::temp_dir().join("cas-test-ingest");
        let store = tmp.join("store");
        let pkg = tmp.join("pkg");
        setup_pkg_dir(&pkg, &[("index.js", b"console.log('hello')")]);

        let result = ingest_to_file_cas(&store, "sha256", "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234", &pkg).unwrap();
        assert_eq!(result.total_files, 1);
        assert_eq!(result.new_files, 1);
        assert!(!result.reused);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ingest_idempotent_returns_reused() {
        let tmp = std::env::temp_dir().join("cas-test-idempotent");
        let store = tmp.join("store");
        let pkg = tmp.join("pkg");
        setup_pkg_dir(&pkg, &[("index.js", b"module.exports = {}")]);

        let hex = "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
        ingest_to_file_cas(&store, "sha256", hex, &pkg).unwrap();
        // Second ingest should return reused=true
        let result2 = ingest_to_file_cas(&store, "sha256", hex, &pkg).unwrap();
        assert!(result2.reused);
        assert_eq!(result2.new_files, 0);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ingest_multiple_files() {
        let tmp = std::env::temp_dir().join("cas-test-multi");
        let store = tmp.join("store");
        let pkg = tmp.join("pkg");
        setup_pkg_dir(&pkg, &[
            ("index.js", b"exports.a = 1;"),
            ("utils.js", b"exports.b = 2;"),
            ("lib/helper.js", b"exports.c = 3;"),
        ]);

        let hex = "b2c3d4e5b2c3d4e5b2c3d4e5b2c3d4e5b2c3d4e5b2c3d4e5b2c3d4e5b2c3d4e5";
        let result = ingest_to_file_cas(&store, "sha256", hex, &pkg).unwrap();
        assert_eq!(result.total_files, 3);
        assert_eq!(result.new_files, 3);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn materialize_missing_manifest_returns_ok_false() {
        let tmp = std::env::temp_dir().join("cas-test-mat-missing");
        let store = tmp.join("store");
        let dest = tmp.join("dest");
        fs::create_dir_all(&dest).unwrap();

        let result = materialize_from_file_cas(
            &store, "sha256",
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            &dest,
            crate::types::LinkStrategy::Hardlink,
        ).unwrap();
        assert!(!result.ok);
        assert_eq!(result.files, 0);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ingest_and_materialize_roundtrip() {
        let tmp = std::env::temp_dir().join("cas-test-roundtrip");
        let store = tmp.join("store");
        let pkg = tmp.join("pkg");
        let dest = tmp.join("dest");
        setup_pkg_dir(&pkg, &[("main.js", b"const x = 42;")]);

        let hex = "c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6";
        let ingest = ingest_to_file_cas(&store, "sha256", hex, &pkg).unwrap();
        assert_eq!(ingest.total_files, 1);

        fs::create_dir_all(&dest).unwrap();
        let mat = materialize_from_file_cas(
            &store, "sha256", hex, &dest,
            crate::types::LinkStrategy::Copy,
        ).unwrap();
        assert!(mat.ok);
        assert_eq!(mat.files, 1);
        assert!(dest.join("main.js").exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn file_store_path_uses_two_level_sharding() {
        let root = std::path::Path::new("/store");
        let hex = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";
        let path = file_store_path(root, hex);
        assert!(path.to_string_lossy().contains("/files/sha256/ab/cd/"));
    }

    #[test]
    fn package_manifest_dir_uses_algo_and_hex() {
        let root = std::path::Path::new("/store");
        let hex = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        let dir = package_manifest_dir(root, "sha256", hex);
        assert!(dir.to_string_lossy().contains("/packages/sha256/de/ad/"));
    }

    #[test]
    fn package_manifest_path_ends_with_manifest_json() {
        let root = std::path::Path::new("/store");
        let hex = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        let path = package_manifest_path(root, "sha256", hex);
        assert!(path.ends_with("manifest.json"));
    }

    #[test]
    fn hash_file_produces_consistent_hash() {
        let tmp = std::env::temp_dir().join("cas-test-hashfile");
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("test.txt");
        std::fs::write(&f, b"hello world").unwrap();
        let h1 = hash_file(&f).unwrap();
        let h2 = hash_file(&f).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex is 64 chars
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
