//! Small, regular-only snapshots avoid reopening unpacked sources during reconciliation.
//! No persisted metadata is trusted: the exact compressed bytes are SRI verified.
use crate::{fetch_pipeline::ArtifactLimits, integrity::Integrity, MaterializeStaging, MaterializeStats, PhaseDurations};
use std::{collections::{BTreeMap, BTreeSet}, fs, io::Read, ops::Range, path::{Component, Path, PathBuf}, time::Instant};

const MAX_COMPRESSED: u64 = 1024 * 1024;
const MAX_EXPANDED: u64 = 2 * 1024 * 1024;
const MAX_ENTRIES: u64 = 4096;
const MAX_PATH_BYTES: usize = 256 * 1024;

struct SnapshotFile { path: PathBuf, bytes: Range<usize>, mode: u32 }
struct Snapshot { expanded: Vec<u8>, files: Vec<SnapshotFile>, directories: BTreeSet<PathBuf> }

fn decode(compressed: &[u8], limits: ArtifactLimits) -> Option<Snapshot> {
    // Read through gzip EOF, including CRC, before interpreting or publishing entries.
    let cap = MAX_EXPANDED.min(limits.expanded_bytes);
    let mut expanded = Vec::new();
    flate2::read::GzDecoder::new(compressed).take(cap + 1).read_to_end(&mut expanded).ok()?;
    if expanded.len() as u64 > cap { return None; }
    let mut archive = tar::Archive::new(expanded.as_slice());
    let mut files = Vec::new();
    let mut kinds = BTreeMap::new();
    let mut directories = BTreeSet::from([PathBuf::new()]);
    let mut path_bytes = 0usize;
    let mut count = 0u64;
    // Raw iteration never materializes GNU/PAX extension bodies. Unsupported
    // entries use the existing bounded extraction/materialization path instead.
    for entry in archive.entries().ok()?.raw(true) {
        let entry = entry.ok()?;
        count += 1;
        if count > MAX_ENTRIES.min(limits.entries) { return None; }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() { return None; }
        let archive_path = entry.path().ok()?;
        let mut components = archive_path.components();
        if components.next()? != Component::Normal(std::ffi::OsStr::new("package")) { return None; }
        let mut path = PathBuf::new();
        for (depth, component) in components.enumerate() {
            if depth >= 32 { return None; }
            let Component::Normal(name) = component else { return None; };
            if name == "node_modules" || name == ".better_extracted"
                || name.as_encoded_bytes().contains(&b'\\') { return None; }
            path.push(name);
        }
        if path.as_os_str().is_empty() && !kind.is_dir() { return None; }
        path_bytes = path_bytes.checked_add(path.as_os_str().as_encoded_bytes().len().checked_mul(2)?)?;
        if path_bytes > MAX_PATH_BYTES || kinds.insert(path.clone(), kind.is_file()).is_some() { return None; }
        // tar-rs default extraction strips special permission bits. Leave special
        // headers to the established path rather than widening this fast path.
        let mode = entry.header().mode().ok()?;
        if mode & !0o777 != 0 { return None; }
        if kind.is_dir() {
            if entry.size() != 0 { return None; }
            directories.insert(path.clone());
        } else {
            let start = usize::try_from(entry.raw_file_position()).ok()?;
            let size = usize::try_from(entry.size()).ok()?;
            let end = start.checked_add(size)?;
            if end > expanded.len() { return None; }
            files.push(SnapshotFile { path: path.clone(), bytes: start..end, mode });
        }
        let mut parent = path.parent();
        while let Some(path) = parent {
            if !directories.contains(path) {
                path_bytes = path_bytes.checked_add(path.as_os_str().as_encoded_bytes().len())?;
                if path_bytes > MAX_PATH_BYTES { return None; }
                directories.insert(path.to_path_buf());
            }
            parent = path.parent();
        }
        if kinds.len() + files.len() + directories.len() > MAX_ENTRIES as usize * 3 { return None; }
    }
    if !files.iter().any(|file| file.path == Path::new("package.json"))
        || directories.iter().any(|path| kinds.get(path) == Some(&true)) { return None; }
    Some(Snapshot { expanded, files, directories })
}

/// None means unsupported before any target writes. Errors after admission are
/// propagated; callers must not mask a partial publication with a fallback.
pub(crate) fn reconcile(
    tarball: &Path, integrity: &str, destination: &Path, limits: ArtifactLimits,
) -> Result<Option<(MaterializeStats, PhaseDurations)>, String> {
    if !cfg!(unix) { return Ok(None); }
    let started = Instant::now();
    let cap = MAX_COMPRESSED.min(limits.compressed_bytes);
    let file = match fs::File::open(tarball) { Ok(file) => file, Err(_) => return Ok(None) };
    if file.metadata().map_err(|e| e.to_string())?.len() > cap { return Ok(None); }
    let mut compressed = Vec::new();
    file.take(cap + 1).read_to_end(&mut compressed).map_err(|e| e.to_string())?;
    if compressed.len() as u64 > cap { return Ok(None); }
    Integrity::parse(integrity)?.verify(&compressed)?;
    let Some(snapshot) = decode(&compressed, limits) else { return Ok(None); };
    drop(compressed);
    let mut phases = PhaseDurations::default();
    phases.scan_us = started.elapsed().as_micros() as u64;
    let mkdir = Instant::now();
    for directory in &snapshot.directories {
        crate::create_materialize_dir(destination, &destination.join(directory))?;
    }
    phases.mkdir_us = mkdir.elapsed().as_micros() as u64;
    let copy = Instant::now();
    let mut staging = MaterializeStaging::default();
    let mut stats = MaterializeStats::default();
    stats.directories = snapshot.directories.len().saturating_sub(1) as u64;
    for file in snapshot.files {
        let reused = staging.copy_bytes_if_changed(
            &snapshot.expanded[file.bytes], &destination.join(file.path), file.mode,
        )?;
        stats.files += 1;
        if reused { stats.files_reused += 1; } else { stats.files_copied += 1; }
    }
    phases.link_copy_us = copy.elapsed().as_micros() as u64;
    phases.total_us = started.elapsed().as_micros() as u64;
    Ok(Some((stats, phases)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        for (path, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64); header.set_mode(0o644); header.set_cksum();
            tar.append_data(&mut header, path, *bytes).unwrap();
        }
        let bytes = tar.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&bytes).unwrap(); gz.finish().unwrap()
    }

    #[test]
    fn snapshots_preserve_exact_content_and_reject_ambiguous_archives() {
        let valid = fixture(&[("package/package.json", b"{}"), ("package/sub/a", b"payload")]);
        let snapshot = decode(&valid, ArtifactLimits::default()).unwrap();
        assert_eq!(&snapshot.expanded[snapshot.files[1].bytes.clone()], b"payload");
        assert!(snapshot.directories.contains(Path::new("sub")));
        for entries in [
            vec![("package/package.json", &b"{}"[..]), ("package/package.json", &b"{}"[..])],
            vec![("package/package.json", &b"{}"[..]), ("package/sub", &b"x"[..]), ("package/sub/a", &b"x"[..])],
            vec![("package/package.json", &b"{}"[..]), ("other/a", &b"x"[..])],
            vec![("package/package.json", &b"{}"[..]), ("package/node_modules/a", &b"x"[..])],
        ] { assert!(decode(&fixture(&entries), ArtifactLimits::default()).is_none()); }
        let mut corrupt = valid.clone(); let end = corrupt.len(); corrupt[end - 5] ^= 1;
        assert!(decode(&corrupt, ArtifactLimits::default()).is_none());
        assert!(decode(&valid, ArtifactLimits { expanded_bytes: 1024, ..ArtifactLimits::default() }).is_none());
        assert!(decode(&valid, ArtifactLimits { entries: 1, ..ArtifactLimits::default() }).is_none());
        for kind in [tar::EntryType::Symlink, tar::EntryType::Link, tar::EntryType::XHeader] {
            let mut tar = tar::Builder::new(Vec::new());
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(kind); header.set_size(0); header.set_mode(0o644);
            header.set_link_name("package/package.json").unwrap(); header.set_cksum();
            tar.append_data(&mut header, "package/link", &b""[..]).unwrap();
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gz.write_all(&tar.into_inner().unwrap()).unwrap();
            assert!(decode(&gz.finish().unwrap(), ArtifactLimits::default()).is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn reconciliation_repairs_bytes_and_rejects_invalid_sri_before_writes() {
        use base64::Engine;
        use sha2::Digest;
        let temp = tempfile::tempdir().unwrap();
        let bytes = fixture(&[("package/package.json", b"{}"), ("package/sub/a", b"payload")]);
        let integrity = format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(&bytes)));
        let archive = temp.path().join("archive.tgz"); fs::write(&archive, &bytes).unwrap();
        let target = temp.path().join("target");
        let run = || reconcile(&archive, &integrity, &target, ArtifactLimits::default()).unwrap().unwrap().0;
        assert_eq!(run().files_copied, 2);
        assert_eq!(run().files_reused, 2);
        fs::write(target.join("sub/a"), b"changed").unwrap();
        assert_eq!(run().files_copied, 1);
        assert_eq!(fs::read(target.join("sub/a")).unwrap(), b"payload");
        fs::write(&archive, b"invalid").unwrap();
        let untouched = temp.path().join("untouched");
        assert!(reconcile(&archive, &integrity, &untouched, ArtifactLimits::default()).is_err());
        assert!(!untouched.exists());
    }
}
