// crates/better-core/src/audit/cache.rs

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// TTL for OSV cache entries (24 hours)
const CACHE_TTL_SECS: u64 = 86_400;

const CACHE_SCHEMA: u32 = 2;
const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;

#[derive(serde::Serialize, serde::Deserialize)]
struct EvidenceEnvelope {
    schema: u32,
    request_digest: String,
    fetched_at: u64,
    expires_at: u64,
    response_digest: String,
    response: String,
}

pub(crate) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

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

    /// Raw evidence only. Callers must recompute policy, scoring and expiring waivers.
    /// Legacy entries and corrupt, expired or future-dated envelopes are misses.
    pub fn get(&self, batch_key: &str) -> Option<String> {
        let file = std::fs::File::open(self.entry_path(batch_key)).ok()?;
        if file.metadata().ok()?.len() > MAX_ENTRY_BYTES {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(MAX_ENTRY_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_ENTRY_BYTES {
            return None;
        }
        let entry: EvidenceEnvelope = serde_json::from_slice(&bytes).ok()?;
        let now = now_secs();
        if entry.schema != CACHE_SCHEMA
            || entry.request_digest != digest(batch_key)
            || entry.fetched_at > now
            || entry.expires_at <= now
            || entry.expires_at < entry.fetched_at
            || entry.expires_at - entry.fetched_at > CACHE_TTL_SECS
            || entry.response_digest != digest(&entry.response)
        {
            return None;
        }
        Some(entry.response)
    }

    pub fn put(&self, batch_key: &str, json: &str) -> std::io::Result<()> {
        self.put_with_ttl(batch_key, json, CACHE_TTL_SECS)
    }

    /// Publish a complete envelope with atomic rename; interrupted writers cannot
    /// replace a readable entry with a partial JSON document.
    pub(crate) fn put_with_ttl(
        &self,
        batch_key: &str,
        json: &str,
        ttl: u64,
    ) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.cache_dir)?;
        let now = now_secs();
        let entry = EvidenceEnvelope {
            schema: CACHE_SCHEMA,
            request_digest: digest(batch_key),
            fetched_at: now,
            expires_at: now.saturating_add(ttl.min(CACHE_TTL_SECS)),
            response_digest: digest(json),
            response: json.to_owned(),
        };
        let bytes = serde_json::to_vec(&entry)?;
        if bytes.len() as u64 > MAX_ENTRY_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "evidence cache entry exceeds limit",
            ));
        }
        let temporary = self.cache_dir.join(format!(
            ".{}.{}.{}.tmp",
            digest(batch_key),
            std::process::id(),
            rand::random::<u64>()
        ));
        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&bytes)?;
            std::fs::rename(&temporary, self.entry_path(batch_key))
        })();
        let _ = std::fs::remove_file(temporary);
        result
    }

    /// Stable lock inode, deliberately not removed on release. A waiter rechecks
    /// freshness after acquiring it, merging concurrent cold requests.
    pub(crate) fn lock(&self, key: &str) -> std::io::Result<std::fs::File> {
        std::fs::create_dir_all(&self.cache_dir)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.cache_dir.join(format!("{}.lock", digest(key))))?;
        file.lock()?;
        Ok(file)
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
            if entry
                .path()
                .extension()
                .map(|e| e == "json")
                .unwrap_or(false)
            {
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
                            let ts = modified
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs();
                            if ts < oldest {
                                oldest = ts;
                            }
                            if ts > newest {
                                newest = ts;
                            }
                        }
                    }
                }
            }
        }
        CacheStats {
            entries: count,
            total_bytes: bytes,
            oldest_ts: if oldest == u64::MAX {
                None
            } else {
                Some(oldest)
            },
            newest_ts: if newest == 0 { None } else { Some(newest) },
            cache_dir: self.cache_dir.display().to_string(),
        }
    }

    fn entry_path(&self, key: &str) -> PathBuf {
        self.cache_dir.join(format!("{}.json", digest(key)))
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_and_get_roundtrip() {
        let tmp = std::env::temp_dir().join("audit-cache-test");
        let cache = OsvCache::with_dir(tmp.clone());
        cache.put("test-key", r#"{"data":"test"}"#).unwrap();
        let result = cache.get("test-key");
        assert_eq!(result.as_deref(), Some(r#"{"data":"test"}"#));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn get_missing_returns_none() {
        let tmp = std::env::temp_dir().join("audit-cache-test-miss");
        let cache = OsvCache::with_dir(tmp.clone());
        assert!(cache.get("nonexistent-key").is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clear_removes_entries() {
        let tmp = std::env::temp_dir().join("audit-cache-test-clear");
        let cache = OsvCache::with_dir(tmp.clone());
        cache.put("key1", "data1").unwrap();
        cache.put("key2", "data2").unwrap();
        let count = cache.clear().unwrap();
        assert_eq!(count, 2);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn invalidate_removes_specific_entry() {
        let tmp = std::env::temp_dir().join("audit-cache-test-inv");
        let cache = OsvCache::with_dir(tmp.clone());
        cache.put("to-remove", "data").unwrap();
        cache.invalidate("to-remove");
        assert!(cache.get("to-remove").is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stats_reflects_entries() {
        let tmp = std::env::temp_dir().join("audit-cache-test-stats");
        let cache = OsvCache::with_dir(tmp.clone());
        cache.put("s1", "hello world").unwrap();
        cache.put("s2", "test data 2").unwrap();
        let stats = cache.stats();
        assert_eq!(stats.entries, 2);
        assert!(stats.total_bytes >= 11); // "hello world" = 11 bytes
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clear_on_empty_dir_returns_zero() {
        let tmp = std::env::temp_dir().join("audit-cache-test-empty-clear");
        let cache = OsvCache::with_dir(tmp.clone());
        // Don't create the directory — clear should still succeed
        let count = cache.clear().unwrap();
        assert_eq!(count, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn put_overwrites_existing_entry() {
        let tmp = std::env::temp_dir().join("audit-cache-test-overwrite");
        let cache = OsvCache::with_dir(tmp.clone());
        cache.put("key", "first value").unwrap();
        cache.put("key", "second value").unwrap();
        assert_eq!(cache.get("key").as_deref(), Some("second value"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stats_reflects_single_entry_bytes() {
        let tmp = std::env::temp_dir().join("audit-cache-test-bytes");
        let cache = OsvCache::with_dir(tmp.clone());
        let content = "exactly twenty bytes";
        cache.put("k", content).unwrap();
        let stats = cache.stats();
        assert_eq!(stats.entries, 1);
        assert!(stats.total_bytes >= content.len() as u64);
        let _ = std::fs::remove_dir_all(&tmp);
    }
    #[test]
    fn evidence_rejects_expiry_corruption_and_other_request() {
        let dir = tempfile::tempdir().unwrap();
        let cache = OsvCache::with_dir(dir.path().to_owned());
        cache.put("request-a", "response").unwrap();
        let path = cache.entry_path("request-a");
        let original = std::fs::read(&path).unwrap();
        let mut entry: EvidenceEnvelope = serde_json::from_slice(&original).unwrap();
        entry.response = "different response".into();
        std::fs::write(&path, serde_json::to_vec(&entry).unwrap()).unwrap();
        assert!(cache.get("request-a").is_none());
        std::fs::write(cache.entry_path("request-b"), &original).unwrap();
        assert!(cache.get("request-b").is_none());
        cache.put_with_ttl("expired", "response", 0).unwrap();
        assert!(cache.get("expired").is_none());
        let mut entry: EvidenceEnvelope = serde_json::from_slice(&original).unwrap();
        entry.fetched_at = now_secs() + 100;
        entry.expires_at = entry.fetched_at + 100;
        std::fs::write(&path, serde_json::to_vec(&entry).unwrap()).unwrap();
        assert!(cache.get("request-a").is_none());
    }

    #[test]
    fn request_keys_do_not_collide_after_long_prefix_or_filename_sanitizing() {
        let dir = tempfile::tempdir().unwrap();
        let cache = OsvCache::with_dir(dir.path().to_owned());
        let prefix = "same".repeat(100);
        cache.put(&format!("{prefix}/a"), "first").unwrap();
        cache.put(&format!("{prefix}_a"), "second").unwrap();
        assert_eq!(cache.get(&format!("{prefix}/a")).as_deref(), Some("first"));
        assert_eq!(cache.get(&format!("{prefix}_a")).as_deref(), Some("second"));
    }

    #[test]
    fn concurrent_publication_only_exposes_complete_envelopes() {
        let dir = tempfile::tempdir().unwrap();
        let cache = OsvCache::with_dir(dir.path().to_owned());
        cache.put("same", "initial").unwrap();
        std::thread::scope(|scope| {
            for n in 0..4 {
                let cache = &cache;
                scope.spawn(move || {
                    for _ in 0..10 {
                        cache.put("same", &format!("response-{n}")).unwrap();
                        assert!(cache.get("same").is_some());
                    }
                });
            }
        });
    }
}
