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
}

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
        Self { tarball: tarball_path(&layout, algo, hex), unpacked: unpacked_path(&layout, algo, hex) }
    }

    pub fn ready(&self) -> bool {
        self.tarball.is_file() && fs::read_to_string(self.tarball.with_extension("tgz.verified")).ok().as_deref() == Some(MARKER_VERSION)
            && fs::read_to_string(self.unpacked.join(".better_extracted")).ok().as_deref() == Some(MARKER_VERSION)
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
        use std::io::Write;
        let mut file = File::create_new(&marker).map_err(|e| e.to_string())?;
        file.write_all(MARKER_VERSION.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        if self.unpacked.exists() {
            if fs::read_to_string(self.unpacked.join(".better_extracted")).ok().as_deref() == Some(MARKER_VERSION) { return Ok(()); }
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

#[cfg(test)]
mod tests {
    use super::*;
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
