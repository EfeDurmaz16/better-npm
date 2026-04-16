use super::pypi::ReleaseFile;
use super::resolver::ResolvedPackage;
use super::wheel::PlatformTags;
use std::path::{Path, PathBuf};

/// CAS layout for Python packages: ~/.better/cas/pypi/{sha256_prefix}/{sha256}
pub fn pypi_cas_path(cas_root: &Path, sha256: &str) -> PathBuf {
    cas_root.join("pypi").join(&sha256[..2.min(sha256.len())]).join(sha256)
}

/// Check if a package already exists in CAS.
pub fn cas_hit(cas_root: &Path, sha256: &str) -> bool {
    if sha256.is_empty() {
        return false;
    }
    pypi_cas_path(cas_root, sha256).exists()
}

/// Download a release file and verify its SHA256 hash.
pub fn download_and_verify(file: &ReleaseFile, cas_root: &Path) -> Result<PathBuf, String> {
    let dest = pypi_cas_path(cas_root, &file.digests.sha256);

    // CAS hit
    if dest.exists() {
        return Ok(dest);
    }

    // Create parent directories
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create CAS directory: {}", e))?;
    }

    // Download to a temp file in the same directory (for atomic rename)
    let temp_path = dest.with_extension("tmp");

    let client = reqwest::blocking::Client::builder()
        .user_agent("better-npm/0.1.0")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client
        .get(&file.url)
        .send()
        .map_err(|e| format!("Download failed for {}: {}", file.filename, e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed for {}: HTTP {}",
            file.filename,
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    // Compute SHA256
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let computed_hash = format!("{:x}", hasher.finalize());

    // Verify hash
    if !file.digests.sha256.is_empty() && computed_hash != file.digests.sha256 {
        return Err(format!(
            "SHA256 mismatch for {}: expected {}, got {}",
            file.filename, file.digests.sha256, computed_hash
        ));
    }

    // Write to temp file
    std::fs::write(&temp_path, &bytes)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    // Atomic rename
    std::fs::rename(&temp_path, &dest).map_err(|e| {
        // Clean up temp file on rename failure
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to rename temp file: {}", e)
    })?;

    Ok(dest)
}

/// Fetch all resolved packages in parallel using rayon.
pub fn fetch_all(
    packages: &[ResolvedPackage],
    cas_root: &Path,
    _platform: &PlatformTags,
) -> Result<Vec<FetchedPackage>, String> {
    use rayon::prelude::*;

    let results: Result<Vec<FetchedPackage>, String> = packages
        .par_iter()
        .map(|pkg| {
            let release_file = ReleaseFile {
                filename: pkg
                    .download_url
                    .rsplit('/')
                    .next()
                    .unwrap_or("unknown")
                    .to_string(),
                url: pkg.download_url.clone(),
                size: 0,
                digests: super::pypi::FileDigests {
                    sha256: pkg.sha256.clone(),
                    md5: None,
                },
                requires_python: None,
                packagetype: if pkg.download_url.ends_with(".whl") {
                    super::pypi::PackageType::BdistWheel
                } else {
                    super::pypi::PackageType::Sdist
                },
                python_version: None,
                yanked: false,
                yanked_reason: None,
            };

            let cas_path = download_and_verify(&release_file, cas_root)?;

            Ok(FetchedPackage {
                name: pkg.name.clone(),
                version: pkg.version.clone(),
                cas_path,
                is_wheel: pkg.download_url.ends_with(".whl"),
            })
        })
        .collect();

    results
}

/// A fetched and verified package in the CAS.
#[derive(Debug)]
pub struct FetchedPackage {
    pub name: String,
    pub version: super::version::Pep440Version,
    pub cas_path: PathBuf,
    pub is_wheel: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cas_path() {
        let root = Path::new("/home/user/.better/cas");
        let path = pypi_cas_path(root, "abc123def456");
        assert_eq!(
            path,
            PathBuf::from("/home/user/.better/cas/pypi/ab/abc123def456")
        );
    }

    #[test]
    fn test_cas_hit_empty_hash() {
        assert!(!cas_hit(Path::new("/nonexistent"), ""));
    }

    #[test]
    fn test_cas_hit_nonexistent() {
        assert!(!cas_hit(Path::new("/tmp"), "abc123def456"));
    }

    #[test]
    fn test_cas_path_prefix_is_first_two_chars() {
        let root = Path::new("/cas");
        let path = pypi_cas_path(root, "deadbeef");
        let components: Vec<_> = path.components().collect();
        // Should be /cas/pypi/de/deadbeef
        assert!(path.to_string_lossy().contains("/de/"));
        assert!(path.ends_with("deadbeef"));
        let _ = components;
    }

    #[test]
    fn test_cas_path_single_char_hash() {
        // Should not panic for short hashes
        let root = Path::new("/cas");
        let path = pypi_cas_path(root, "a");
        assert!(path.ends_with("a"));
    }

    #[test]
    fn test_cas_hit_existing_file() {
        let dir = std::env::temp_dir().join("fetch-cas-hit-test");
        std::fs::create_dir_all(&dir).unwrap();
        let hash = "cafebabe1234";
        let cas_path = pypi_cas_path(&dir, hash);
        std::fs::create_dir_all(cas_path.parent().unwrap()).unwrap();
        std::fs::write(&cas_path, b"data").unwrap();
        assert!(cas_hit(&dir, hash));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_fetched_package_is_wheel_field() {
        use super::super::version::Pep440Version;
        let pkg = FetchedPackage {
            name: "flask".into(),
            version: Pep440Version::parse("3.0.0").unwrap(),
            cas_path: PathBuf::from("/cas/pypi/xx/xxx"),
            is_wheel: true,
        };
        assert!(pkg.is_wheel);
        assert_eq!(pkg.name, "flask");
    }

    #[test]
    fn test_cas_miss_nonexistent_file() {
        let dir = std::env::temp_dir().join("fetch-cas-miss-test");
        std::fs::create_dir_all(&dir).unwrap();
        // A hash that hasn't been stored
        assert!(!cas_hit(&dir, "nonexistent0000hash"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
