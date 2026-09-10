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
    cache_dir: PathBuf,
}

/// Owning guard may cross worker threads while retaining producer ownership.
#[derive(Debug)]
pub struct ContentLock { _file: File }

/// A cache-scoped cross-process CPU/I/O admission slot. Stable slot files are
/// intentionally retained; process exit releases ownership automatically.
pub struct ResourcePermit { _file: File }

pub fn acquire_resource_permit(cache_dir: &Path) -> Result<ResourcePermit, String> {
    let slots = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 4);
    let directory = cache_dir.join("store").join("resource-slots-v1");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut files: Vec<Option<File>> = (0..slots).map(|_| None).collect();
    let start = rand::random::<u64>() as usize % slots;
    loop {
        for offset in 0..slots {
            let slot = (start + offset) % slots;
            if files[slot].is_none() {
                files[slot] = Some(File::options().read(true).write(true).create(true).truncate(false)
                    .open(directory.join(format!("{slot}.lock"))).map_err(|e| e.to_string())?);
            }
            match files[slot].as_ref().unwrap().try_lock() {
                Ok(()) => return Ok(ResourcePermit { _file: files[slot].take().unwrap() }),
                Err(std::fs::TryLockError::WouldBlock) => {},
                Err(std::fs::TryLockError::Error(error)) => return Err(format!("Cannot acquire resource slot: {error}")),
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

/// Pushes a file's data to the device. On Apple platforms fsync(2) does not drain the
/// drive cache (F_FULLFSYNC costs milliseconds and the drive serializes it); ordering
/// comes from `barrier`. Elsewhere this is a full fsync.
pub(crate) fn push(file: &File) -> std::io::Result<()> {
    #[cfg(target_vendor = "apple")]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::fsync(file.as_raw_fd()) } == -1 { return Err(std::io::Error::last_os_error()); }
        Ok(())
    }
    #[cfg(not(target_vendor = "apple"))]
    { file.sync_all() }
}

/// Every write pushed before this call reaches stable storage before any later write.
pub(crate) fn barrier(file: &File) -> std::io::Result<()> {
    #[cfg(target_vendor = "apple")]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_BARRIERFSYNC) } == -1 { return Err(std::io::Error::last_os_error()); }
        Ok(())
    }
    #[cfg(not(target_vendor = "apple"))]
    { file.sync_all() }
}

/// Small retained archives still undergo full SRI verification. Their bounded
/// hash work avoids additional slot-file operations; worker counts bound their
/// concurrency. Reserve the shared budget for larger hashes/extraction.
pub fn acquire_hash_permit(cache_dir: &Path, compressed_bytes: u64) -> Result<Option<ResourcePermit>, String> {
    if compressed_bytes <= 1024 * 1024 { return Ok(None); }
    acquire_resource_permit(cache_dir).map(Some)
}

fn lifecycle_lock(cache_dir: &Path, shared: bool) -> Result<ContentLock, String> {
    let directory = cache_dir.join("store");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let file = File::options().read(true).write(true).create(true).truncate(false)
        .open(directory.join("artifact-lifecycle.lock")).map_err(|e| e.to_string())?;
    if shared { file.lock_shared() } else { file.lock() }.map_err(|e| e.to_string())?;
    Ok(ContentLock { _file: file })
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
        Self { cache_dir: cache_dir.to_path_buf(), tarball: tarball_path(&layout, algo, hex), unpacked: unpacked_path(&layout, algo, hex), lock_path: cache_dir.join("store").join("artifact-locks").join(algo).join(format!("{hex}.lock")) }
    }

    /// Stable lock files are never unlinked: unlinking permits two lock domains.
    /// The OS releases the exclusive lock when this handle closes or its process dies.
    fn open_lock(&self) -> Result<File, String> {
        fs::create_dir_all(self.lock_path.parent().ok_or("Invalid lock path")?).map_err(|e| e.to_string())?;
        let file = File::options().read(true).write(true).create(true).truncate(false)
            .open(&self.lock_path).map_err(|e| format!("Cannot open artifact lock: {e}"))?;
        Ok(file)
    }

    pub fn lock(&self) -> Result<ContentLock, String> {
        let file = self.open_lock()?;
        file.lock().map_err(|e| format!("Cannot lock artifact: {e}"))?;
        Ok(ContentLock { _file: file })
    }

    /// Shared readers coexist but block cooperative publication and repair.
    /// Release before acquiring a producer lock, then recheck readiness.
    pub fn read_lock(&self) -> Result<ContentLock, String> {
        let file = self.open_lock()?;
        file.lock_shared().map_err(|e| format!("Cannot lease artifact: {e}"))?;
        Ok(ContentLock { _file: file })
    }

    fn try_content_lock(&self, shared: bool) -> Result<Option<ContentLock>, String> {
        let file = self.open_lock()?;
        let outcome = if shared { file.try_lock_shared() } else { file.try_lock() };
        match outcome {
            Ok(()) => Ok(Some(ContentLock { _file: file })),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(error)) => Err(format!("Cannot lock artifact: {error}")),
        }
    }

    pub fn try_read_lock(&self) -> Result<Option<ContentLock>, String> { self.try_content_lock(true) }
    pub fn try_lock(&self) -> Result<Option<ContentLock>, String> { self.try_content_lock(false) }

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
        let marker = self.tarball.with_extension("tgz.verified");
        if fs::read_to_string(&marker).ok().as_deref() != Some(MARKER_VERSION) {
            fs::write(marker, MARKER_VERSION).map_err(|e| e.to_string())?;
        }
        Ok(true)
    }

    /// The source must be in a private sibling staging directory on this volume.
    pub fn publish_tarball(&self, source: &Path, verify: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
        verify(source)?;
        // Every use re-verifies SRI, so a torn tarball is refetched, never trusted.
        File::open(source).and_then(|f| push(&f)).map_err(|e| e.to_string())?;
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
        // The inventory barrier already ordered content ahead of this marker; a lost or
        // empty marker only makes the entry look incomplete.
        file.write_all(MARKER_VERSION.as_bytes()).and_then(|_| push(&file)).map_err(|e| e.to_string())?;
        // Only replacing an existing tree needs lifecycle exclusion. New
        // content can publish while unrelated materializers retain read leases.
        let _lifecycle = if self.unpacked.exists() { Some(lifecycle_lock(&self.cache_dir, false)?) } else { None };
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
pub fn prepare_offline_packages(packages: &[crate::ResolvedPackage], cache_dir: &Path, limits: crate::fetch_pipeline::ArtifactLimits) -> Result<crate::FetchResult, String> {
    prepare_offline_packages_with_options(packages, cache_dir, &crate::fetch_pipeline::FetchOptions { limits, ..Default::default() })
}

/// Offline verification and repair honor the caller's effective worker budget.
/// Both hashing and extraction execute in preparation lanes, so use the smaller
/// bound. The scheduler's single handoff consumer performs no extraction here.
pub fn prepare_offline_packages_with_options(packages: &[crate::ResolvedPackage], cache_dir: &Path, options: &crate::fetch_pipeline::FetchOptions) -> Result<crate::FetchResult, String> {
    options.validate()?;
    let limits = options.limits;
    let mut identities = std::collections::BTreeMap::new();
    for package in packages {
        let identity = crate::integrity::Integrity::parse(&package.integrity)
            .map_err(|e| format!("Invalid integrity for {}: {e}", package.name))?;
        identities.entry((identity.algorithm(), identity.hex_digest())).or_insert((package, identity));
    }
    let identities: Vec<_> = identities.into_values().collect();
    let jobs = options.network_jobs.min(options.extract_jobs);
    let metrics = crate::fetch_scheduler::run_retry_pipeline(&identities, jobs, 1,
      |(package, identity)| {
        let artifact = ArtifactCache::new(cache_dir, identity.algorithm(), &identity.hex_digest());
        let verify = |path: &Path| {
            let file = File::open(path).map_err(|e| e.to_string())?;
            let compressed_bytes = file.metadata().map_err(|e| e.to_string())?.len();
            if compressed_bytes > limits.compressed_bytes {
                return Err("Cached archive exceeds compressed byte limit".to_string());
            }
            let _permit = acquire_hash_permit(cache_dir, compressed_bytes)?;
            identity.verify_reader(file)
        };
        let Some(reader) = artifact.try_read_lock()? else { return Ok(crate::fetch_scheduler::Preparation::Deferred); };
        if artifact.ready() {
            verify(&artifact.tarball).map_err(|e| format!("Invalid cached archive for {}: {e}", package.name))?;
            return Ok(crate::fetch_scheduler::Preparation::Complete(None::<()>));
        }
        drop(reader);
        let Some(_producer) = artifact.try_lock()? else { return Ok(crate::fetch_scheduler::Preparation::Deferred); };
        if !artifact.retained_tarball(verify).map_err(|e| format!("Invalid cached archive for {}: {e}", package.name))? {
            return Err(format!("package not in cache: {}@{} - run without --offline to fetch", package.name, package.version));
        }
        if !artifact.ready() {
            artifact.extract_and_publish(|source, destination| {
                let _permit = acquire_resource_permit(cache_dir)?;
                crate::fetch_pipeline::extract_verified_tarball(source, destination, limits)
            })?;
        }
        Ok(crate::fetch_scheduler::Preparation::Complete(None::<()>))
      }, |_| Ok(()))?;
    Ok(crate::FetchResult { packages_fetched: 0, packages_cached: packages.len() as u64, bytes_downloaded: 0, metrics })
}

/// Retain this cache lifecycle lease through materialization. One descriptor
/// protects all prepared trees from cooperative replacement, even for very large
/// plans. Do not run repair while holding it. This does not replace SRI checks.
pub fn acquire_package_leases(packages: &[crate::ResolvedPackage], cache_dir: &Path) -> Result<Vec<ContentLock>, String> {
    let mut identities = std::collections::BTreeSet::new();
    for package in packages {
        let identity = crate::integrity::Integrity::parse(&package.integrity)?;
        identities.insert((identity.algorithm(), identity.hex_digest()));
    }
    let lease = lifecycle_lock(cache_dir, true)?;
    for (algorithm, hex) in identities {
        let artifact = ArtifactCache::new(cache_dir, algorithm, &hex);
        if !artifact.ready() { return Err("Artifact changed before materialization; retry preparation".into()); }
    }
    Ok(vec![lease])
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
    fn shared_readers_block_producers_until_last_reader_drops() {
        let temp = tempfile::tempdir().unwrap();
        let cache = ArtifactCache::new(temp.path(), "sha512", "abcdef");
        let first = cache.read_lock().unwrap();
        let second = cache.read_lock().unwrap();
        let producer = cache.open_lock().unwrap();
        assert!(producer.try_lock().is_err());
        drop(first);
        assert!(producer.try_lock().is_err());
        drop(second);
        producer.try_lock().unwrap();
    }

    #[test]
    fn lifecycle_readers_hold_one_shared_replacement_domain() {
        let temp = tempfile::tempdir().unwrap();
        let first = lifecycle_lock(temp.path(), true).unwrap();
        let second = lifecycle_lock(temp.path(), true).unwrap();
        let writer = File::options().read(true).write(true)
            .open(temp.path().join("store/artifact-lifecycle.lock")).unwrap();
        assert!(writer.try_lock().is_err());
        drop(first);
        assert!(writer.try_lock().is_err());
        drop(second);
        writer.try_lock().unwrap();
    }

    #[test]
    fn small_hash_admission_needs_no_slot_files() {
        let temp = tempfile::tempdir().unwrap();
        assert!(acquire_hash_permit(temp.path(), 1024 * 1024).unwrap().is_none());
        assert!(!temp.path().join("store/resource-slots-v1").exists());
        assert!(acquire_hash_permit(temp.path(), 1024 * 1024 + 1).unwrap().is_some());
    }

    #[test]
    fn resource_permits_hold_distinct_stable_slots() {
        let temp = tempfile::tempdir().unwrap();
        let slots = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 4);
        let permits: Vec<_> = (0..slots).map(|_| acquire_resource_permit(temp.path()).unwrap()).collect();
        for slot in 0..slots {
            let file = File::options().read(true).write(true)
                .open(temp.path().join("store/resource-slots-v1").join(format!("{slot}.lock"))).unwrap();
            assert!(file.try_lock().is_err());
        }
        drop(permits);
        acquire_resource_permit(temp.path()).unwrap();
    }

    #[test]
    fn retained_current_marker_is_not_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let cache = ArtifactCache::new(temp.path(), "sha512", "abcdef");
        let stage = cache.create_download().unwrap();
        let source = stage.path().join("archive");
        fs::write(&source, b"archive").unwrap();
        cache.publish_tarball(&source, |_| Ok(())).unwrap();
        let marker = cache.tarball.with_extension("tgz.verified");
        let before = fs::metadata(&marker).unwrap().modified().unwrap();
        assert!(cache.retained_tarball(|_| Ok(())).unwrap());
        assert_eq!(before, fs::metadata(marker).unwrap().modified().unwrap());
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
