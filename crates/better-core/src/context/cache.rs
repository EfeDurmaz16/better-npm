use std::path::{Path, PathBuf};

/// Cache layout:
/// ~/.better/context/
///   npm/
///     lodash@4.17.21.md
///     express@4.18.2.md
///   python/
///     requests@2.31.0.md
///     flask@3.1.0.md
///   index.json

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CacheIndex {
    pub entries: Vec<CacheEntry>,
    pub total_size_bytes: u64,
    pub last_gc: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CacheEntry {
    pub ecosystem: String,
    pub name: String,
    pub version: String,
    pub path: String,
    pub size_bytes: u64,
    pub generated_at: String,
    pub last_accessed: String,
    pub authored: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct GcResult {
    pub removed: u64,
    pub freed_bytes: u64,
    pub kept: u64,
    pub dry_run: bool,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct CacheStats {
    pub total_entries: usize,
    pub total_size_bytes: u64,
    pub npm_entries: usize,
    pub python_entries: usize,
    pub authored_entries: usize,
    pub last_gc: Option<String>,
}

pub fn cache_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".better").join("context")
}

pub fn cache_path(ecosystem: &str, name: &str, version: &str) -> PathBuf {
    cache_root()
        .join(ecosystem)
        .join(format!("{}@{}.md", name.replace('/', "__"), version))
}

pub fn read_cached(ecosystem: &str, name: &str, version: &str) -> Option<String> {
    let path = cache_path(ecosystem, name, version);
    if path.exists() {
        std::fs::read_to_string(&path).ok()
    } else {
        None
    }
}

pub fn write_cached(
    ecosystem: &str,
    name: &str,
    version: &str,
    content: &str,
    authored: bool,
) -> Result<(), String> {
    let path = cache_path(ecosystem, name, version);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create cache dir: {}", e))?;
    }
    std::fs::write(&path, content)
        .map_err(|e| format!("failed to write cache: {}", e))?;

    update_index(CacheEntry {
        ecosystem: ecosystem.to_string(),
        name: name.to_string(),
        version: version.to_string(),
        path: path.to_string_lossy().to_string(),
        size_bytes: content.len() as u64,
        generated_at: now_iso(),
        last_accessed: now_iso(),
        authored,
    });

    Ok(())
}

pub fn gc(max_age_days: u64, dry_run: bool) -> Result<GcResult, String> {
    let root = cache_root();
    let index_path = root.join("index.json");

    let index = read_index(&index_path);

    let cutoff_secs = max_age_days * 86400;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut removed = 0u64;
    let mut freed_bytes = 0u64;
    let mut kept = 0u64;

    let remaining: Vec<CacheEntry> = index
        .entries
        .into_iter()
        .filter(|entry| {
            let entry_secs = parse_iso_to_epoch(&entry.last_accessed).unwrap_or(0);
            if now.saturating_sub(entry_secs) > cutoff_secs {
                if !dry_run {
                    std::fs::remove_file(&entry.path).ok();
                }
                removed += 1;
                freed_bytes += entry.size_bytes;
                false
            } else {
                kept += 1;
                true
            }
        })
        .collect();

    if !dry_run {
        let new_index = CacheIndex {
            total_size_bytes: remaining.iter().map(|e| e.size_bytes).sum(),
            entries: remaining,
            last_gc: Some(now_iso()),
        };
        write_index(&index_path, &new_index);
    }

    Ok(GcResult {
        removed,
        freed_bytes,
        kept,
        dry_run,
    })
}

pub fn stats() -> Result<CacheStats, String> {
    let root = cache_root();
    let index_path = root.join("index.json");

    let index = read_index(&index_path);

    let npm_count = index.entries.iter().filter(|e| e.ecosystem == "npm").count();
    let python_count = index
        .entries
        .iter()
        .filter(|e| e.ecosystem == "python")
        .count();
    let authored_count = index.entries.iter().filter(|e| e.authored).count();

    Ok(CacheStats {
        total_entries: index.entries.len(),
        total_size_bytes: index.total_size_bytes,
        npm_entries: npm_count,
        python_entries: python_count,
        authored_entries: authored_count,
        last_gc: index.last_gc,
    })
}

fn read_index(path: &Path) -> CacheIndex {
    if !path.exists() {
        return CacheIndex {
            entries: Vec::new(),
            total_size_bytes: 0,
            last_gc: None,
        };
    }
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(CacheIndex {
            entries: Vec::new(),
            total_size_bytes: 0,
            last_gc: None,
        }),
        Err(_) => CacheIndex {
            entries: Vec::new(),
            total_size_bytes: 0,
            last_gc: None,
        },
    }
}

fn write_index(path: &Path, index: &CacheIndex) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(json) = serde_json::to_string_pretty(index) {
        std::fs::write(path, json).ok();
    }
}

fn update_index(new_entry: CacheEntry) {
    let root = cache_root();
    let index_path = root.join("index.json");
    let mut index = read_index(&index_path);

    // Remove existing entry for same package
    index.entries.retain(|e| {
        !(e.ecosystem == new_entry.ecosystem
            && e.name == new_entry.name
            && e.version == new_entry.version)
    });

    index.entries.push(new_entry);
    index.total_size_bytes = index.entries.iter().map(|e| e.size_bytes).sum();
    write_index(&index_path, &index);
}

fn now_iso() -> String {
    crate::chrono_now()
}

fn parse_iso_to_epoch(iso: &str) -> Option<u64> {
    // Simple ISO 8601 parser: "YYYY-MM-DDThh:mm:ss.mmmZ"
    if iso.len() < 19 {
        return None;
    }
    let year: u64 = iso[0..4].parse().ok()?;
    let month: u64 = iso[5..7].parse().ok()?;
    let day: u64 = iso[8..10].parse().ok()?;
    let hour: u64 = iso[11..13].parse().ok()?;
    let min: u64 = iso[14..16].parse().ok()?;
    let sec: u64 = iso[17..19].parse().ok()?;

    // Rough epoch calculation (not accounting for leap years precisely)
    let days = (year - 1970) * 365 + (year - 1969) / 4 + (month - 1) * 30 + day;
    Some(days * 86400 + hour * 3600 + min * 60 + sec)
}
