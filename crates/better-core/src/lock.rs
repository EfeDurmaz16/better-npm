use std::fs;
use std::path::Path;

use crate::types::*;
use crate::{extract_json_field, extract_json_object_raw, extract_json_number, JsonWriter};

// === D.4: Lock metadata / fingerprint ===

fn build_lock_metadata(project_root: &Path) -> Result<LockMetadata, String> {
    use sha2::{Digest, Sha256};
    let lockfile_candidates = [
        ("package-lock.json", "npm"), ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"), ("bun.lock", "bun"),
    ];
    let mut lockfile_path = None;
    let mut pm = "npm";
    for (name, pm_name) in &lockfile_candidates {
        let p = project_root.join(name);
        if p.exists() { lockfile_path = Some(p); pm = pm_name; break; }
    }
    let lockfile_path = lockfile_path
        .ok_or_else(|| "No lockfile found".to_string())?;
    let lockfile_content = fs::read(&lockfile_path)
        .map_err(|e| format!("Failed to read lockfile: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&lockfile_content);
    let lockfile_hash = format!("{:x}", hasher.finalize());
    let node_version = std::process::Command::new("node").arg("--version").output().ok()
        .and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_else(|| "v0.0.0".into());
    let node_major = node_version.trim().trim_start_matches('v')
        .split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0u64);
    let fingerprint = LockFingerprint {
        platform: std::env::consts::OS.into(), arch: std::env::consts::ARCH.into(),
        node_major, pm: pm.into(),
    };
    let fp_json = format!(
        "{{\"platform\":\"{}\",\"arch\":\"{}\",\"nodeMajor\":{},\"pm\":\"{}\"}}",
        fingerprint.platform, fingerprint.arch, fingerprint.node_major, fingerprint.pm
    );
    let mut key_hasher = Sha256::new();
    key_hasher.update(lockfile_hash.as_bytes());
    key_hasher.update(fp_json.as_bytes());
    let key = format!("{:x}", key_hasher.finalize());
    let lockfile_file = lockfile_path.file_name()
        .map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Ok(LockMetadata { key, lockfile_file, lockfile_hash, fingerprint })
}

pub fn generate_lock_metadata(project_root: &Path) -> Result<LockMetadata, String> {
    let metadata = build_lock_metadata(project_root)?;
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("key"); w.value_string(&metadata.key);
    w.key("lockfile"); w.value_string(&metadata.lockfile_file);
    w.key("lockfileHash"); w.value_string(&metadata.lockfile_hash);
    w.key("fingerprint"); w.begin_object();
    w.key("platform"); w.value_string(&metadata.fingerprint.platform);
    w.key("arch"); w.value_string(&metadata.fingerprint.arch);
    w.key("nodeMajor"); w.value_u64(metadata.fingerprint.node_major);
    w.key("pm"); w.value_string(&metadata.fingerprint.pm);
    w.end_object();
    w.end_object();
    w.out.push('\n');
    fs::write(project_root.join("better.lock.json"), w.finish())
        .map_err(|e| format!("Failed to write better.lock.json: {}", e))?;
    Ok(metadata)
}

pub fn verify_lock_metadata(project_root: &Path) -> Result<LockVerifyResult, String> {
    let lock_file = project_root.join("better.lock.json");
    let expected = if lock_file.exists() {
        let content = fs::read_to_string(&lock_file)
            .map_err(|e| format!("Failed to read better.lock.json: {}", e))?;
        let key = extract_json_field(&content, "key").unwrap_or_default();
        let lockfile_file = extract_json_field(&content, "lockfile").unwrap_or_default();
        let lockfile_hash = extract_json_field(&content, "lockfileHash").unwrap_or_default();
        let fp_raw = extract_json_object_raw(&content, "fingerprint").unwrap_or_default();
        let platform = extract_json_field(&fp_raw, "platform").unwrap_or_default();
        let arch = extract_json_field(&fp_raw, "arch").unwrap_or_default();
        let node_major = extract_json_number(&fp_raw, "nodeMajor").unwrap_or(0);
        let pm = extract_json_field(&fp_raw, "pm").unwrap_or_default();
        Some(LockMetadata {
            key, lockfile_file, lockfile_hash,
            fingerprint: LockFingerprint { platform, arch, node_major, pm },
        })
    } else { None };
    let current = build_lock_metadata(project_root)?;
    let key_matches = expected.as_ref().map(|e| e.key == current.key).unwrap_or(false);
    let lockfile_matches = expected.as_ref().map(|e| e.lockfile_hash == current.lockfile_hash).unwrap_or(false);
    let ok = key_matches && lockfile_matches;
    Ok(LockVerifyResult { ok, key_matches, lockfile_matches, expected, current })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_lock(root: &Path, name: &str, content: &[u8]) {
        std::fs::create_dir_all(root).unwrap();
        let mut f = std::fs::File::create(root.join(name)).unwrap();
        f.write_all(content).unwrap();
    }

    #[test]
    fn generate_lock_metadata_no_lockfile_errors() {
        let tmp = std::env::temp_dir().join("lock-test-nofile");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = generate_lock_metadata(&tmp);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn generate_lock_metadata_creates_better_lock_json() {
        let tmp = std::env::temp_dir().join("lock-test-generate");
        write_lock(&tmp, "package-lock.json", b"{\"lockfileVersion\":3}");
        let meta = generate_lock_metadata(&tmp).unwrap();
        assert!(!meta.key.is_empty());
        assert!(!meta.lockfile_hash.is_empty());
        assert_eq!(meta.lockfile_file, "package-lock.json");
        assert!(tmp.join("better.lock.json").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn verify_lock_metadata_matches_after_generate() {
        let tmp = std::env::temp_dir().join("lock-test-verify");
        write_lock(&tmp, "package-lock.json", b"{\"lockfileVersion\":3,\"packages\":{}}");
        generate_lock_metadata(&tmp).unwrap();
        let verify = verify_lock_metadata(&tmp).unwrap();
        assert!(verify.ok);
        assert!(verify.key_matches);
        assert!(verify.lockfile_matches);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn verify_lock_metadata_fails_if_lockfile_changes() {
        let tmp = std::env::temp_dir().join("lock-test-changed");
        write_lock(&tmp, "package-lock.json", b"{\"lockfileVersion\":3}");
        generate_lock_metadata(&tmp).unwrap();
        // Modify the lockfile after generating metadata
        write_lock(&tmp, "package-lock.json", b"{\"lockfileVersion\":3,\"modified\":true}");
        let verify = verify_lock_metadata(&tmp).unwrap();
        assert!(!verify.ok);
        assert!(!verify.lockfile_matches);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

