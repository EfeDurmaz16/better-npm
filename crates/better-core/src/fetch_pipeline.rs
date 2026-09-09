//! Bounded I/O primitives. The caller owns private staging and atomic publication.
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;

pub const DOWNLOAD_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct ArtifactLimits {
    pub compressed_bytes: u64,
    pub expanded_bytes: u64,
    pub entries: u64,
    pub metadata_bytes: u64,
}

impl Default for ArtifactLimits {
    fn default() -> Self {
        Self {
            compressed_bytes: 512 * 1024 * 1024,
            expanded_bytes: 2 * 1024 * 1024 * 1024,
            entries: 100_000,
            metadata_bytes: 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FetchOptions {
    pub network_jobs: usize,
    pub extract_jobs: usize,
    pub limits: ArtifactLimits,
}
impl Default for FetchOptions {
    fn default() -> Self {
        let jobs = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 64);
        Self { network_jobs: jobs, extract_jobs: jobs, limits: ArtifactLimits::default() }
    }
}
impl FetchOptions {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=256).contains(&self.network_jobs) || !(1..=256).contains(&self.extract_jobs) {
            return Err("Fetch worker counts must be between 1 and 256".into());
        }
        if self.limits.compressed_bytes == 0 || self.limits.expanded_bytes == 0
            || self.limits.entries == 0 || self.limits.metadata_bytes == 0 {
            return Err("Archive resource limits must be positive integers".into());
        }
        Ok(())
    }
}

/// Copy to private staging with constant application buffer memory. Observe each
/// chunk for incremental integrity verification; never publish before finalizing it.
pub fn stream_to_staging<R: Read, W: Write>(
    mut source: R,
    mut destination: W,
    max_bytes: u64,
    mut observe: impl FnMut(&[u8]),
) -> Result<u64, String> {
    let mut buffer = [0u8; DOWNLOAD_BUFFER_BYTES];
    let mut total = 0u64;
    loop {
        let count = match source.read(&mut buffer) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            value => value.map_err(|_| "Failed to read tarball response body".to_string())?,
        };
        if count == 0 { break; }
        total = total.checked_add(count as u64)
            .filter(|&n| n <= max_bytes)
            .ok_or_else(|| format!("Tarball exceeds compressed byte limit ({max_bytes})"))?;
        observe(&buffer[..count]);
        destination.write_all(&buffer[..count])
            .map_err(|e| format!("Failed to stage tarball: {e}"))?;
    }
    destination.flush().map_err(|e| format!("Failed to flush staged tarball: {e}"))?;
    Ok(total)
}

/// Return an error instead of pretending an over-budget stream ended cleanly.
struct ExpandedBudget<R> { reader: R, remaining: u64 }
impl<R: Read> Read for ExpandedBudget<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() { return Ok(0); }
        if self.remaining == 0 {
            let mut probe = [0];
            return if self.reader.read(&mut probe)? == 0 { Ok(0) }
                else { Err(io::Error::other("Archive exceeds expanded byte limit; increase --max-expanded-bytes")) };
        }
        let n = output.len().min(self.remaining.min(usize::MAX as u64) as usize);
        let read = self.reader.read(&mut output[..n])?;
        self.remaining -= read as u64;
        Ok(read)
    }
}

fn archive_reader(source: &Path, limits: ArtifactLimits) -> Result<ExpandedBudget<flate2::read::GzDecoder<File>>, String> {
    let file = File::open(source).map_err(|e| format!("Failed to open verified tarball: {e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > limits.compressed_bytes {
        return Err("Tarball exceeds compressed byte limit; increase --max-tarball-bytes".into());
    }
    Ok(ExpandedBudget { reader: flate2::read::GzDecoder::new(file), remaining: limits.expanded_bytes })
}

// tar-rs materializes GNU/PAX extension bodies internally. A raw preflight uses
// its parser without allocating those bodies, before a second normal unpack pass.
// This deliberately trades a second decompression for bounded extension memory.
fn preflight(source: &Path, limits: ArtifactLimits) -> Result<(), String> {
    let mut archive = tar::Archive::new(archive_reader(source, limits)?);
    let mut entries = 0u64;
    let mut pax_size = None;
    for entry in archive.entries().map_err(|e| e.to_string())?.raw(true) {
        let mut entry = entry.map_err(|e| e.to_string())?;
        entries += 1;
        if entries > limits.entries {
            return Err("Archive exceeds entry count limit; increase --max-archive-entries".into());
        }
        let kind = entry.header().entry_type();
        if kind.is_gnu_sparse() {
            return Err("Sparse TAR entries are unsupported by bounded extraction".into());
        }
        if (kind.is_gnu_longname() || kind.is_gnu_longlink()
            || kind.is_pax_local_extensions() || kind.is_pax_global_extensions())
            && entry.size() > limits.metadata_bytes {
            return Err("TAR extension exceeds metadata byte limit; increase --max-archive-metadata-bytes".into());
        }
        if entry.size() > limits.expanded_bytes {
            return Err("TAR entry exceeds expanded byte limit; increase --max-expanded-bytes".into());
        }
        let extension_header = kind.is_gnu_longname() || kind.is_gnu_longlink()
            || kind.is_pax_local_extensions() || kind.is_pax_global_extensions();
        if !extension_header {
            if pax_size.take().is_some_and(|size| size != entry.size()) {
                return Err("PAX size differing from file header is unsupported by bounded extraction".into());
            }
        }
        // tar-rs ignores global PAX metadata when unpacking. Apply only local
        // metadata here as well, preserving the library's framing semantics.
        if kind.is_pax_local_extensions() {
            if let Some(extensions) = entry.pax_extensions().map_err(|e| e.to_string())? {
                for extension in extensions {
                    let extension = extension.map_err(|e| e.to_string())?;
                    let key = extension.key_bytes();
                    if key.starts_with(b"GNU.sparse.") {
                        return Err("PAX sparse entries are unsupported by bounded extraction".into());
                    }
                    if key == b"size" {
                        if pax_size.is_some() {
                            return Err("Duplicate PAX size records are unsupported by bounded extraction".into());
                        }
                        let size: u64 = extension.value().map_err(|e| e.to_string())?
                            .parse().map_err(|_| "Invalid PAX size".to_string())?;
                        if size > limits.expanded_bytes {
                            return Err("PAX size exceeds expanded byte limit; increase --max-expanded-bytes".into());
                        }
                        pax_size = Some(size);
                    }
                }
            }
        }
        io::copy(&mut entry, &mut io::sink()).map_err(|e| e.to_string())?;
    }
    io::copy(&mut archive.into_inner(), &mut io::sink()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Only call with an integrity-verified tarball and a private extraction directory.
/// Drain after TAR EOF so gzip checksum/truncation and expansion limits are checked.
pub fn extract_verified_tarball(source: &Path, destination: &Path, limits: ArtifactLimits) -> Result<(), String> {
    preflight(source, limits)?;
    let mut archive = tar::Archive::new(archive_reader(source, limits)?);
    archive.unpack(destination).map_err(|e| format!("Failed to extract bounded tarball: {e}"))?;
    io::copy(&mut archive.into_inner(), &mut io::sink())
        .map_err(|e| format!("Failed to finish bounded tarball: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Cursor;

    #[test]
    fn stream_limits_reads_and_never_writes_over_budget() {
        struct Generated { left: usize, peak: usize }
        impl Read for Generated {
            fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
                self.peak = self.peak.max(b.len());
                let n = b.len().min(self.left); b[..n].fill(7); self.left -= n; Ok(n)
            }
        }
        let mut source = Generated { left: 10_000_000, peak: 0 };
        let mut written = Vec::new();
        let mut observed = 0;
        assert!(stream_to_staging(&mut source, &mut written, 100_000, |b| observed += b.len()).is_err());
        assert!(written.len() <= 100_000);
        assert_eq!(written.len(), observed);
        assert_eq!(source.peak, DOWNLOAD_BUFFER_BYTES);
    }

    #[test]
    fn exact_budget_and_short_reads_succeed() {
        let bytes = b"bounded stream";
        let mut out = Vec::new();
        assert_eq!(stream_to_staging(Cursor::new(bytes), &mut out, bytes.len() as u64, |_| {}).unwrap(), bytes.len() as u64);
        assert_eq!(out, bytes);
    }

    fn fixture(size: usize) -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("package.tgz");
        let gz = GzEncoder::new(File::create(&path).unwrap(), Compression::default());
        let mut tar = tar::Builder::new(gz);
        let mut h = tar::Header::new_gnu(); h.set_size(size as u64); h.set_mode(0o644); h.set_cksum();
        tar.append_data(&mut h, "package/index.js", io::repeat(42).take(size as u64)).unwrap();
        tar.into_inner().unwrap().finish().unwrap();
        (root, path)
    }

    #[test]
    fn valid_archive_extracts_and_expansion_budget_rejects() {
        let (root, source) = fixture(32 * 1024);
        extract_verified_tarball(&source, &root.path().join("ok"), ArtifactLimits::default()).unwrap();
        let limits = ArtifactLimits { expanded_bytes: 4096, ..ArtifactLimits::default() };
        assert!(extract_verified_tarball(&source, &root.path().join("bad"), limits).unwrap_err().contains("expanded byte limit"));
    }

    #[test]
    fn count_budget_and_corrupt_gzip_footer_reject() {
        let (root, source) = fixture(32);
        let limits = ArtifactLimits { entries: 0, ..ArtifactLimits::default() };
        assert!(extract_verified_tarball(&source, &root.path().join("count"), limits).is_err());
        let mut bytes = std::fs::read(&source).unwrap();
        let offset = bytes.len() - 8; bytes[offset] ^= 1;
        std::fs::write(&source, bytes).unwrap();
        assert!(extract_verified_tarball(&source, &root.path().join("crc"), ArtifactLimits::default()).is_err());
    }

    #[test]
    fn huge_metadata_rejected_before_body_read() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("metadata.tgz");
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::GNULongName); h.set_size(1_000_000); h.set_cksum();
        let mut gz = GzEncoder::new(File::create(&source).unwrap(), Compression::default());
        gz.write_all(h.as_bytes()).unwrap(); gz.finish().unwrap();
        let limits = ArtifactLimits { metadata_bytes: 1024, ..ArtifactLimits::default() };
        assert!(extract_verified_tarball(&source, &root.path().join("out"), limits).unwrap_err().contains("metadata"));
        assert!(!root.path().join("out").exists());
    }

    #[test]
    fn pax_size_override_rejects_before_extraction() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("pax.tgz");
        let gz = GzEncoder::new(File::create(&source).unwrap(), Compression::default());
        let mut builder = tar::Builder::new(gz);
        builder.append_pax_extensions([("size", &b"2000000000"[..])]).unwrap();
        let mut h = tar::Header::new_gnu(); h.set_size(3); h.set_mode(0o644); h.set_cksum();
        builder.append_data(&mut h, "package/index.js", &b"yes"[..]).unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        let out = root.path().join("out");
        assert!(extract_verified_tarball(&source, &out, ArtifactLimits::default()).unwrap_err().contains("PAX size"));
        assert!(!out.exists());
    }

    #[test]
    fn duplicate_pax_size_is_rejected_consistently() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("duplicate.tgz");
        let gz = GzEncoder::new(File::create(&source).unwrap(), Compression::default());
        let mut builder = tar::Builder::new(gz);
        builder.append_pax_extensions([("size", &b"3"[..]), ("size", &b"3"[..])]).unwrap();
        let mut h = tar::Header::new_gnu(); h.set_size(3); h.set_mode(0o644); h.set_cksum();
        builder.append_data(&mut h, "package/index.js", &b"yes"[..]).unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        let out = root.path().join("out");
        assert!(extract_verified_tarball(&source, &out, ArtifactLimits::default()).unwrap_err().contains("Duplicate PAX size"));
        assert!(!out.exists());
    }

    #[test]
    fn global_pax_matches_library_ignored_semantics() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("global.tgz");
        let gz = GzEncoder::new(File::create(&source).unwrap(), Compression::default());
        let mut builder = tar::Builder::new(gz);
        let global = b"10 size=9\n";
        let mut h = tar::Header::new_ustar(); h.set_entry_type(tar::EntryType::XGlobalHeader);
        h.set_size(global.len() as u64); h.set_mode(0o644); h.set_cksum();
        builder.append_data(&mut h, "pax_global_header", &global[..]).unwrap();
        let mut h = tar::Header::new_gnu(); h.set_size(3); h.set_mode(0o644); h.set_cksum();
        builder.append_data(&mut h, "package/index.js", &b"yes"[..]).unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        let out = root.path().join("out");
        extract_verified_tarball(&source, &out, ArtifactLimits::default()).unwrap();
        assert_eq!(std::fs::read(out.join("package/index.js")).unwrap(), b"yes");
    }

    #[test]
    fn legitimate_gnu_longname_and_pax_extract() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("long.tgz");
        let gz = GzEncoder::new(File::create(&source).unwrap(), Compression::default());
        let mut builder = tar::Builder::new(gz);
        let path = format!("package/{}/index.js", "long".repeat(40));
        let mut h = tar::Header::new_gnu(); h.set_size(3); h.set_mode(0o644); h.set_cksum();
        builder.append_data(&mut h, &path, &b"yes"[..]).unwrap();
        builder.append_pax_extensions([("comment", &b"legitimate metadata"[..]), ("size", &b"3"[..])]).unwrap();
        builder.append_data(&mut h, "package/pax.js", &b"yes"[..]).unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        let out = root.path().join("out");
        extract_verified_tarball(&source, &out, ArtifactLimits::default()).unwrap();
        assert_eq!(std::fs::read(out.join(path)).unwrap(), b"yes");
        assert_eq!(std::fs::read(out.join("package/pax.js")).unwrap(), b"yes");
    }
}
