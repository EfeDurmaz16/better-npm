// crates/better-core/src/audit/cache.rs

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// TTL for OSV cache entries (24 hours)
const CACHE_TTL_SECS: u64 = 86_400;

pub struct OsvCache {
    cache_dir: PathBuf,
}

impl OsvCache {
    pub fn new() -> Self {
        let cache_dir = dirs_next_or_home().join(".better").join("osv-cache");
        Self { cache_dir }
    }

    pub fn with_dir(cache_dir: PathBuf) -> Self {
        Self { cache_dir }
    }

    /// Returns the cached OSV JSON response for a batch key, or None if stale/absent.
    pub fn get(&self, batch_key: &str) -> Option<String> {
        let path = self.entry_path(batch_key);
        let metadata = std::fs::metadata(&path).ok()?;
        let modified = metadata.modified().ok()?;
        let age = SystemTime::now().duration_since(modified).unwrap_or(Duration::MAX);
        if age > Duration::from_secs(CACHE_TTL_SECS) {
            return None;
        }
        std::fs::read_to_string(&path).ok()
    }

    /// Store OSV JSON response for a batch key.
    pub fn put(&self, batch_key: &str, json: &str) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.cache_dir)?;
        let path = self.entry_path(batch_key);
        std::fs::write(path, json)
    }

    /// Delete a cache entry.
    pub fn invalidate(&self, batch_key: &str) {
        let _ = std::fs::remove_file(self.entry_path(batch_key));
    }

    /// Delete all cache entries.
    pub fn clear(&self) -> std::io::Result<u64> {
        let mut count = 0u64;
        if !self.cache_dir.exists() {
            return Ok(0);
        }
        for entry in std::fs::read_dir(&self.cache_dir)? {
            let entry = entry?;
            if entry.path().extension().map(|e| e == "json").unwrap_or(false) {
                std::fs::remove_file(entry.path())?;
                count += 1;
            }
        }
        Ok(count)
    }

    /// Return statistics: entry count, total bytes, oldest/newest.
    pub fn stats(&self) -> CacheStats {
        let mut count = 0u64;
        let mut bytes = 0u64;
        let mut oldest = u64::MAX;
        let mut newest = 0u64;
        if let Ok(rd) = std::fs::read_dir(&self.cache_dir) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.extension().map(|e| e == "json").unwrap_or(false) {
                    if let Ok(meta) = std::fs::metadata(&p) {
                        count += 1;
                        bytes += meta.len();
                        if let Ok(modified) = meta.modified() {
                            let ts = modified.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                            if ts < oldest { oldest = ts; }
                            if ts > newest { newest = ts; }
                        }
                    }
                }
            }
        }
        CacheStats {
            entries: count,
            total_bytes: bytes,
            oldest_ts: if oldest == u64::MAX { None } else { Some(oldest) },
            newest_ts: if newest == 0 { None } else { Some(newest) },
            cache_dir: self.cache_dir.display().to_string(),
        }
    }

    fn entry_path(&self, key: &str) -> PathBuf {
        // Sanitize key to valid filename
        let safe: String = key
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '.' || c == '_' { c } else { '_' })
            .collect();
        self.cache_dir.join(format!("{}.json", safe))
    }
}

impl Default for OsvCache {
    fn default() -> Self {
        Self::new()
    }
}

pub struct CacheStats {
    pub entries: u64,
    pub total_bytes: u64,
    pub oldest_ts: Option<u64>,
    pub newest_ts: Option<u64>,
    pub cache_dir: String,
}

fn dirs_next_or_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}
