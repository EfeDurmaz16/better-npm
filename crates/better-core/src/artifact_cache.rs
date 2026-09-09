//! Transactional publication for the native package artifact cache.
//!
//! Only complete extraction directories become visible at the canonical path.
//! Staging and quarantined legacy entries are never removed by age-based GC.
use std::fs::{self, File};
use std::path::{Path, PathBuf};

use crate::{tarball_path, unpacked_path, CasLayout};

pub const MARKER_VERSION: &str = crate::integrity::VERIFIED_MARKER;

pub struct ArtifactCache {
    pub tarball: PathBuf,
    pub unpacked: PathBuf,
    lock_path: PathBuf,
}

/// Owning guard may cross worker threads while retaining producer ownership.
pub struct ContentLock { _file: File }

pub struct Staging {
    path: PathBuf,
}
impl Staging {
    pub fn path(&self) -> &Path { &self.path }
}
impl Drop for Staging {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.path); }
}

fn staging(parent: &Path) -> Result<Staging, String> {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    loop {
        let path = parent.join(format!(".better-stage-{}-{:016x}", std::process::id(), rand::random::<u64>()));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(Staging { path }),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Cannot create artifact staging: {e}")),
        }
    }
}

impl ArtifactCache {
    pub fn new(cache_dir: &Path, algo: &str, hex: &str) -> Self {
        let layout = CasLayout::new(cache_dir);
        Self { tarball: tarball_path(&layout, algo, hex), unpacked: unpacked_path(&layout, algo, hex), lock_path: cache_dir.join("store").join("artifact-locks").join(algo).join(format!("{hex}.lock")) }
    }

    /// Stable lock files are never unlinked: unlinking permits two lock domains.
    /// The OS releases the exclusive lock when this handle closes or its process dies.
    pub fn lock(&self) -> Result<ContentLock, String> {
        fs::create_dir_all(self.lock_path.parent().ok_or("Invalid lock path")?).map_err(|e| e.to_string())?;
        let file = File::options().read(true).write(true).create(true).truncate(false)
            .open(&self.lock_path).map_err(|e| format!("Cannot open artifact lock: {e}"))?;
        file.lock().map_err(|e| format!("Cannot lock artifact: {e}"))?;
        Ok(ContentLock { _file: file })
    }

    pub fn ready(&self) -> bool {
        self.tarball.is_file() && fs::read_to_string(self.tarball.with_extension("tgz.verified")).ok().as_deref() == Some(MARKER_VERSION)
            && fs::read_to_string(self.unpacked.join(".better_extracted")).ok().as_deref() == Some(MARKER_VERSION)
            && crate::artifact_inventory::complete(&self.unpacked)
    }

    pub fn create_download(&self) -> Result<Staging, String> {
        staging(self.tarball.parent().ok_or("Invalid tarball path")?)
    }

    /// Verify even retained artifacts. A legacy marker is not proof of integrity.
    pub fn retained_tarball(&self, verify: impl FnOnce(&Path) -> Result<(), String>) -> Result<bool, String> {
        if !self.tarball.is_file() { return Ok(false); }
        verify(&self.tarball)?;
        fs::write(self.tarball.with_extension("tgz.verified"), MARKER_VERSION).map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// The source must be in a private sibling staging directory on this volume.
    pub fn publish_tarball(&self, source: &Path, verify: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
        verify(source)?;
        File::open(source).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
        fs::rename(source, &self.tarball).map_err(|e| format!("Cannot publish tarball: {e}"))?;
        fs::write(self.tarball.with_extension("tgz.verified"), MARKER_VERSION).map_err(|e| e.to_string())
    }

    pub fn extract_and_publish(&self, extract: impl FnOnce(&Path, &Path) -> Result<(), String>) -> Result<(), String> {
        let parent = self.unpacked.parent().ok_or("Invalid unpacked path")?;
        let stage = staging(parent)?;
        let candidate = stage.path().join("content");
        fs::create_dir(&candidate).map_err(|e| e.to_string())?;
        extract(&self.tarball, &candidate)?;
        let marker = candidate.join(".better_extracted");
        // An archive cannot supply our completion marker, including a symlink.
        if fs::symlink_metadata(&marker).is_ok() { return Err("Archive contains reserved extraction marker".into()); }
        crate::artifact_inventory::write(&candidate)?;
        use std::io::Write;
        let mut file = File::create_new(&marker).map_err(|e| e.to_string())?;
        file.write_all(MARKER_VERSION.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        if self.unpacked.exists() {
            if self.ready() { return Ok(()); }
            // Retain incomplete legacy content instead of deleting potentially live data.
            let quarantine = parent.join(format!(".better-quarantine-{:016x}", rand::random::<u64>()));
            match fs::rename(&self.unpacked, quarantine) {
                Ok(()) => {}
                // Another publisher may have quarantined the same legacy entry.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Cannot quarantine incomplete artifact: {e}")),
            }
        }
        match fs::rename(&candidate, &self.unpacked) {
            Ok(()) => Ok(()),
            Err(_) if self.ready() => Ok(()),
            Err(e) => Err(format!("Cannot publish extraction: {e}")),
        }
    }
}

/// Prepare selected packages without any network access. Missing or incomplete
/// extraction is rebuilt from a verified retained archive under the content lock.
pub fn prepare_offline_packages(packages: &[crate::ResolvedPackage], cache_dir: &Path) -> Result<crate::FetchResult, String> {
    let mut identities = std::collections::BTreeMap::new();
    for package in packages {
        let identity = crate::integrity::Integrity::parse(&package.integrity)
            .map_err(|e| format!("Invalid integrity for {}: {e}", package.name))?;
        identities.entry((identity.algorithm(), identity.hex_digest())).or_insert((package, identity));
    }
    for (_, (package, identity)) in identities {
        let artifact = ArtifactCache::new(cache_dir, identity.algorithm(), &identity.hex_digest());
        let _lock = artifact.lock()?;
        let verify = |path: &Path| identity.verify_reader(File::open(path).map_err(|e| e.to_string())?);
        if !artifact.retained_tarball(verify).map_err(|e| format!("Invalid cached archive for {}: {e}", package.name))? {
            return Err(format!("package not in cache: {}@{} - run without --offline to fetch", package.name, package.version));
        }
        if !artifact.ready() {
            artifact.extract_and_publish(|source, destination| {
                let file = File::open(source).map_err(|e| e.to_string())?;
                tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(destination)
                    .map_err(|e| format!("Cannot repair cached extraction: {e}"))
            })?;
        }
    }
    Ok(crate::FetchResult { packages_fetched: 0, packages_cached: packages.len() as u64, bytes_downloaded: 0 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_locks_are_per_key_and_release_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let first = ArtifactCache::new(temp.path(), "sha512", "abcdef");
        let second = ArtifactCache::new(temp.path(), "sha512", "123456");
        let guard = first.lock().unwrap();
        let other_handle = File::options().read(true).write(true).open(&first.lock_path).unwrap();
        assert!(other_handle.try_lock().is_err());
        let independent = second.lock().unwrap();
        drop(independent);
        drop(guard);
        other_handle.try_lock().unwrap();
        assert!(first.lock_path.is_file());
    }
    #[test]
    fn failed_extraction_never_publishes_partial_content() {
        let temp = tempfile::tempdir().unwrap();
        let cache = ArtifactCache::new(temp.path(), "sha512", "abcdef");
        assert!(cache.extract_and_publish(|_, dest| { fs::write(dest.join("partial"), b"x").unwrap(); Err("interrupted".into()) }).is_err());
        assert!(!cache.unpacked.exists());
        assert_eq!(fs::read_dir(cache.unpacked.parent().unwrap()).unwrap().count(), 0);
    }
    #[test]
    fn destructive_gc_preserves_live_artifact_files() {
        let temp = tempfile::tempdir().unwrap();
        let cache = ArtifactCache::new(temp.path(), "sha512", "abcdef");
        fs::create_dir_all(&cache.unpacked).unwrap();
        let active = cache.unpacked.join("active");
        fs::write(&active, b"live").unwrap();
        assert!(crate::cache_gc(temp.path(), 0, false).is_err());
        assert_eq!(fs::read(&active).unwrap(), b"live");
    }
    #[test]
    fn retained_artifact_verification_and_repair() {
        let temp = tempfile::tempdir().unwrap();
        let cache = ArtifactCache::new(temp.path(), "sha512", "abcdef");
        let stage = cache.create_download().unwrap();
        let source = stage.path().join("archive");
        fs::write(&source, b"verified archive").unwrap();
        cache.publish_tarball(&source, |_| Ok(())).unwrap();
        assert!(cache.retained_tarball(|path| { assert_eq!(fs::read(path).unwrap(), b"verified archive"); Ok(()) }).unwrap());
        cache.extract_and_publish(|_, dest| fs::write(dest.join("package.json"), b"{}").map_err(|e| e.to_string())).unwrap();
        assert!(cache.ready());
        assert!(cache.retained_tarball(|_| Err("bad digest".into())).is_err());
    }
}
