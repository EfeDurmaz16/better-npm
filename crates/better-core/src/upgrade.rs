// crates/better-core/src/upgrade.rs
//
// Self-upgrade engine (v1.0 Task 84).
//
// `better upgrade` checks for a newer version, verifies the SHA-256 checksum,
// backs up the current binary, and replaces it atomically.
//
// No network I/O in the core — the caller supplies release metadata.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct UpgradeResult {
    pub from_version: String,
    pub to_version: String,
    pub checksum_verified: bool,
    pub backup_path: String,
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ReleaseInfo {
    pub version: String,
    pub download_url: String,
    pub checksum_sha256: String,
}

#[derive(Debug)]
pub enum UpgradeError {
    AlreadyLatest(String),
    ChecksumMismatch { expected: String, actual: String },
    IoError(std::io::Error),
    InvalidVersion(String),
}

impl std::fmt::Display for UpgradeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyLatest(v) =>
                write!(f, "Already at latest version ({})", v),
            Self::ChecksumMismatch { expected, actual } =>
                write!(f, "Checksum mismatch: expected {} got {}", expected, actual),
            Self::IoError(e) =>
                write!(f, "I/O error: {}", e),
            Self::InvalidVersion(v) =>
                write!(f, "Cannot parse version: {}", v),
        }
    }
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/// Check whether `current_version` is older than `release.version`.
///
/// If `check_only` is true, returns a successful `UpgradeResult` without
/// touching the filesystem.  Otherwise, the caller must supply `binary_bytes`
/// (the downloaded archive already extracted to a raw binary) and
/// `actual_checksum` (its SHA-256 hex digest).
pub fn upgrade(
    current_version: &str,
    release: &ReleaseInfo,
    binary_path: &Path,
    binary_bytes: Option<&[u8]>,
    actual_checksum: Option<&str>,
    check_only: bool,
) -> Result<UpgradeResult, UpgradeError> {
    // Compare versions (simple lexicographic semver comparison works for
    // standard x.y.z releases; pre-release tags sort correctly as long
    // as callers use stable releases).
    if !is_newer(&release.version, current_version) {
        return Err(UpgradeError::AlreadyLatest(current_version.to_string()));
    }

    if check_only {
        return Ok(UpgradeResult {
            from_version: current_version.to_string(),
            to_version: release.version.clone(),
            checksum_verified: false,
            backup_path: String::new(),
            success: true,
            message: format!("Upgrade available: {} → {}", current_version, release.version),
        });
    }

    let bytes = binary_bytes.ok_or_else(|| {
        UpgradeError::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "binary_bytes required for live upgrade",
        ))
    })?;
    let checksum = actual_checksum.ok_or_else(|| {
        UpgradeError::IoError(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "actual_checksum required for live upgrade",
        ))
    })?;

    // Verify checksum
    if checksum != release.checksum_sha256 {
        return Err(UpgradeError::ChecksumMismatch {
            expected: release.checksum_sha256.clone(),
            actual: checksum.to_string(),
        });
    }

    // Backup current binary
    let backup_path = with_suffix(binary_path, ".bak");
    if binary_path.exists() {
        fs::copy(binary_path, &backup_path).map_err(UpgradeError::IoError)?;
    }

    // Write new binary atomically via temp file
    let tmp_path = with_suffix(binary_path, ".tmp");
    fs::write(&tmp_path, bytes).map_err(UpgradeError::IoError)?;

    // Set executable bit on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&tmp_path)
            .map_err(UpgradeError::IoError)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&tmp_path, perms).map_err(UpgradeError::IoError)?;
    }

    // Atomic rename
    if let Err(e) = fs::rename(&tmp_path, binary_path) {
        // Rollback
        if backup_path.exists() {
            let _ = fs::copy(&backup_path, binary_path);
        }
        let _ = fs::remove_file(&tmp_path);
        return Err(UpgradeError::IoError(e));
    }

    Ok(UpgradeResult {
        from_version: current_version.to_string(),
        to_version: release.version.clone(),
        checksum_verified: true,
        backup_path: backup_path.display().to_string(),
        success: true,
        message: format!("Upgraded {} → {}", current_version, release.version),
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Returns true if `candidate` is strictly newer than `current`.
/// Compares `x.y.z` tuples numerically; falls back to string comparison.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let cv = parse_ver(candidate);
    let cur = parse_ver(current);
    match (cv, cur) {
        (Some(c), Some(b)) => c > b,
        _ => candidate > current,
    }
}

fn parse_ver(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim_start_matches('v');
    let base = v.split('-').next().unwrap_or(v); // strip pre-release
    let parts: Vec<&str> = base.split('.').collect();
    if parts.len() < 3 { return None; }
    let major = parts[0].parse::<u64>().ok()?;
    let minor = parts[1].parse::<u64>().ok()?;
    let patch = parts[2].parse::<u64>().ok()?;
    Some((major, minor, patch))
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn release(ver: &str) -> ReleaseInfo {
        ReleaseInfo {
            version: ver.to_string(),
            download_url: "https://example.com/better".to_string(),
            checksum_sha256: "abc123".to_string(),
        }
    }

    #[test]
    fn check_only_returns_upgrade_available() {
        let r = release("1.2.0");
        let result = upgrade("1.1.0", &r, Path::new("/usr/local/bin/better"),
            None, None, true).unwrap();
        assert!(result.success);
        assert_eq!(result.from_version, "1.1.0");
        assert_eq!(result.to_version, "1.2.0");
        assert!(!result.checksum_verified);
    }

    #[test]
    fn already_latest_errors() {
        let r = release("1.1.0");
        let err = upgrade("1.1.0", &r, Path::new("/bin/better"),
            None, None, true).unwrap_err();
        assert!(matches!(err, UpgradeError::AlreadyLatest(_)));
    }

    #[test]
    fn older_version_errors_as_already_latest() {
        let r = release("1.0.0");
        let err = upgrade("2.0.0", &r, Path::new("/bin/better"),
            None, None, true).unwrap_err();
        assert!(matches!(err, UpgradeError::AlreadyLatest(_)));
    }

    #[test]
    fn checksum_mismatch_errors() {
        let r = release("2.0.0");
        let err = upgrade("1.0.0", &r, Path::new("/tmp/better-upgrade-test-bin"),
            Some(b"fake binary"), Some("wrong_hash"), false).unwrap_err();
        assert!(matches!(err, UpgradeError::ChecksumMismatch { .. }));
    }

    #[test]
    fn live_upgrade_writes_and_backs_up() {
        let tmp = std::env::temp_dir().join("better-upgrade-test");
        let bin_path = tmp.join("better");
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(&bin_path, b"old binary").unwrap();

        let mut r = release("2.0.0");
        r.checksum_sha256 = "correct_hash".to_string();

        let result = upgrade(
            "1.0.0", &r, &bin_path,
            Some(b"new binary content"),
            Some("correct_hash"),
            false,
        ).unwrap();

        assert!(result.success);
        assert!(result.checksum_verified);
        assert_eq!(std::fs::read(&bin_path).unwrap(), b"new binary content");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn is_newer_comparison() {
        assert!(is_newer("1.2.0", "1.1.0"));
        assert!(is_newer("2.0.0", "1.9.9"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.1.0"));
    }

    #[test]
    fn upgrade_error_display_already_latest() {
        let err = UpgradeError::AlreadyLatest("1.0.0".to_string());
        assert!(err.to_string().contains("1.0.0"));
        assert!(err.to_string().contains("latest"));
    }

    #[test]
    fn upgrade_error_display_checksum_mismatch() {
        let err = UpgradeError::ChecksumMismatch {
            expected: "abc".to_string(),
            actual: "xyz".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("abc"));
        assert!(msg.contains("xyz"));
    }

    #[test]
    fn parse_ver_parses_semver_correctly() {
        assert_eq!(parse_ver("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_ver("v2.0.0"), Some((2, 0, 0)));
        assert_eq!(parse_ver("1.0.0-beta.1"), Some((1, 0, 0)));
        assert_eq!(parse_ver("1.0"), None);
    }
}
