use std::fs;
use std::path::Path;

use crate::types::*;

// --- B.7: Cache Stats/GC ---

pub fn cache_stats(cache_root: &Path) -> Result<CacheStatsReport, String> {
    let layout = CasLayout::new(cache_root);
    let file_store = cache_root.join("file-store");

    let (tarball_count, tarball_bytes) = dir_stats_recursive(&layout.tarballs_dir);
    let (unpacked_count, unpacked_bytes) = dir_stats_recursive(&layout.unpacked_dir);
    let (file_cas_count, file_cas_bytes) = dir_stats_recursive(&file_store);

    let total_bytes = tarball_bytes + unpacked_bytes + file_cas_bytes;
    let package_count = tarball_count;

    Ok(CacheStatsReport {
        cache_root: cache_root.to_path_buf(),
        total_bytes,
        package_count,
        tarball_count,
        tarball_bytes,
        unpacked_count,
        unpacked_bytes,
        file_cas_count,
        file_cas_bytes,
    })
}

fn dir_stats_recursive(dir: &Path) -> (u64, u64) {
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];

    while let Some(d) = stack.pop() {
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.is_dir() {
                stack.push(entry.path());
            } else {
                count += 1;
                bytes += md.len();
            }
        }
    }
    (count, bytes)
}

pub fn cache_gc(cache_root: &Path, max_age_days: u64, dry_run: bool) -> Result<CacheGcReport, String> {
    use std::time::{SystemTime, Duration};

    let cutoff = SystemTime::now() - Duration::from_secs(max_age_days * 86400);
    let mut removed = 0u64;
    let mut freed = 0u64;

    let layout = CasLayout::new(cache_root);

    // Walk tarballs and unpacked dirs
    for dir in &[&layout.tarballs_dir, &layout.unpacked_dir] {
        gc_walk(dir, &cutoff, dry_run, &mut removed, &mut freed);
    }

    Ok(CacheGcReport { removed, freed_bytes: freed, dry_run })
}

fn gc_walk(dir: &Path, cutoff: &std::time::SystemTime, dry_run: bool, removed: &mut u64, freed: &mut u64) {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.is_dir() {
                stack.push(entry.path());
                continue;
            }
            let mtime = md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if mtime < *cutoff {
                *freed += md.len();
                *removed += 1;
                if !dry_run {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

