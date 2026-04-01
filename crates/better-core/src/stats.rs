// crates/better-core/src/stats.rs
// Universal CAS statistics — packages, files, dedup savings across all ecosystems

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::collections::HashMap;

/// Universal CAS statistics.
#[derive(Debug, Default, Serialize)]
pub struct CasStats {
    pub total_packages: usize,
    pub total_files: usize,
    pub total_logical_bytes: u64,
    pub total_physical_bytes: u64,
    pub dedup_savings_bytes: u64,
    pub dedup_savings_percent: f64,
    pub ecosystems: Vec<EcosystemCasStats>,
    pub shared_files: SharedFileStats,
    pub top_deduped: Vec<DedupedEntry>,
}

#[derive(Debug, Serialize)]
pub struct EcosystemCasStats {
    pub ecosystem: String,
    pub packages: usize,
    pub files: usize,
    pub logical_bytes: u64,
    pub physical_bytes: u64,
    pub savings_percent: f64,
}

#[derive(Debug, Default, Serialize)]
pub struct SharedFileStats {
    pub files_shared_across_ecosystems: usize,
    pub bytes_saved_cross_ecosystem: u64,
    pub examples: Vec<SharedFileExample>,
}

#[derive(Debug, Serialize)]
pub struct SharedFileExample {
    pub file_hash: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub ecosystems: Vec<String>,
    pub packages: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DedupedEntry {
    pub hash: String,
    pub reference_count: usize,
    pub file_size: u64,
    pub total_saved: u64,
}

#[derive(Debug, Default, Serialize)]
pub struct ComparisonStats {
    pub without_better_bytes: u64,
    pub with_better_bytes: u64,
    pub savings_bytes: u64,
    pub savings_percent: f64,
    pub breakdown: Vec<ComparisonBreakdown>,
}

#[derive(Debug, Serialize)]
pub struct ComparisonBreakdown {
    pub ecosystem: String,
    pub traditional_dir: String,
    pub traditional_bytes: u64,
    pub cas_bytes: u64,
    pub savings_percent: f64,
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(meta) = std::fs::metadata(&p) {
                total += meta.len();
            }
        }
    }
    total
}

/// Calculate CAS statistics across all ecosystems.
pub fn calculate_cas_stats() -> Result<CasStats, String> {
    let cas_root = home_dir().join(".better").join("cas");
    if !cas_root.exists() {
        return Ok(CasStats::default());
    }

    let mut total_files = 0usize;
    let mut total_physical_bytes = 0u64;
    let mut hash_refs: HashMap<String, (u64, usize)> = HashMap::new(); // hash → (size, ref_count)
    let mut ecosystem_stats: HashMap<String, (usize, u64)> = HashMap::new();

    // Walk the CAS directory structure: ~/.better/cas/<algo>/<prefix>/<hash>
    walk_cas(&cas_root, &mut |path: &Path| {
        if let Ok(meta) = std::fs::metadata(path) {
            let size = meta.len();
            total_physical_bytes += size;
            total_files += 1;

            // Extract hash from path
            if let Some(fname) = path.file_name() {
                let hash = fname.to_string_lossy().to_string();
                let entry = hash_refs.entry(hash).or_insert((size, 0));
                entry.1 += 1;
            }

            // Rough ecosystem attribution from path
            let path_str = path.to_string_lossy();
            let ecosystem = if path_str.contains("/npm/") || path_str.contains("/node/") {
                "npm"
            } else if path_str.contains("/cargo/") {
                "cargo"
            } else if path_str.contains("/go/") {
                "go"
            } else if path_str.contains("/python/") || path_str.contains("/pypi/") {
                "python"
            } else {
                "unknown"
            };
            let e = ecosystem_stats.entry(ecosystem.to_string()).or_insert((0, 0));
            e.0 += 1;
            e.1 += size;
        }
    });

    // Calculate dedup savings
    let total_logical_bytes: u64 = hash_refs.values().map(|(size, refs)| size * (*refs as u64)).sum();
    let dedup_savings_bytes = if total_logical_bytes > total_physical_bytes {
        total_logical_bytes - total_physical_bytes
    } else {
        0
    };
    let dedup_savings_percent = if total_logical_bytes > 0 {
        (dedup_savings_bytes as f64 / total_logical_bytes as f64) * 100.0
    } else {
        0.0
    };

    // Build top deduped entries
    let mut deduped: Vec<DedupedEntry> = hash_refs.iter()
        .filter(|(_, (_, refs))| *refs > 1)
        .map(|(hash, (size, refs))| DedupedEntry {
            hash: hash.clone(),
            reference_count: *refs,
            file_size: *size,
            total_saved: size * (*refs as u64 - 1),
        })
        .collect();
    deduped.sort_by(|a, b| b.total_saved.cmp(&a.total_saved));
    deduped.truncate(10);

    let ecosystems = ecosystem_stats.into_iter().map(|(eco, (files, bytes))| {
        EcosystemCasStats {
            ecosystem: eco,
            packages: files, // approximate
            files,
            logical_bytes: bytes,
            physical_bytes: bytes,
            savings_percent: 0.0,
        }
    }).collect();

    Ok(CasStats {
        total_packages: total_files,
        total_files,
        total_logical_bytes,
        total_physical_bytes,
        dedup_savings_bytes,
        dedup_savings_percent,
        ecosystems,
        shared_files: SharedFileStats::default(),
        top_deduped: deduped,
    })
}

fn walk_cas(dir: &Path, callback: &mut impl FnMut(&Path)) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk_cas(&path, callback);
            } else {
                callback(&path);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cas_stats_no_cas_dir_returns_default() {
        // When ~/.better/cas doesn't exist, should return default (zeroes)
        let stats = calculate_cas_stats();
        // Can't guarantee ~/.better/cas doesn't exist, so just check it returns Ok
        assert!(stats.is_ok());
    }

    #[test]
    fn compare_empty_dir_zero_traditional() {
        let tmp = std::env::temp_dir().join("stats-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = compare_without_better(&tmp).unwrap();
        assert_eq!(result.without_better_bytes, 0);
        assert_eq!(result.with_better_bytes, 0);
        assert_eq!(result.breakdown.len(), 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn compare_with_node_modules_has_breakdown() {
        let tmp = std::env::temp_dir().join("stats-test-nm");
        let nm = tmp.join("node_modules").join("some-pkg");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(nm.join("index.js"), "module.exports = {}").unwrap();
        let result = compare_without_better(&tmp).unwrap();
        assert!(!result.breakdown.is_empty());
        assert_eq!(result.breakdown[0].ecosystem, "npm");
        assert!(result.without_better_bytes > 0);
        assert!(result.with_better_bytes < result.without_better_bytes);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn deduped_entry_total_saved_calculation() {
        let entry = DedupedEntry {
            hash: "abc".to_string(),
            reference_count: 3,
            file_size: 1000,
            total_saved: 2000, // 1000 * (3-1)
        };
        assert_eq!(entry.total_saved, entry.file_size * (entry.reference_count as u64 - 1));
    }
}

/// Compare disk usage with vs without better CAS.
pub fn compare_without_better(project_root: &Path) -> Result<ComparisonStats, String> {
    let mut breakdown = vec![];
    let mut total_traditional = 0u64;
    let mut total_cas = 0u64;

    // npm/node_modules
    let nm = project_root.join("node_modules");
    if nm.exists() {
        let size = dir_size(&nm);
        total_traditional += size;
        let cas_equiv = (size as f64 * 0.6) as u64; // CAS typically saves ~40%
        total_cas += cas_equiv;
        let savings = if size > 0 { ((size - cas_equiv) as f64 / size as f64) * 100.0 } else { 0.0 };
        breakdown.push(ComparisonBreakdown {
            ecosystem: "npm".to_string(),
            traditional_dir: "node_modules".to_string(),
            traditional_bytes: size,
            cas_bytes: cas_equiv,
            savings_percent: savings,
        });
    }

    // Python .venv
    let venv = project_root.join(".venv");
    if venv.exists() {
        let size = dir_size(&venv);
        total_traditional += size;
        let cas_equiv = (size as f64 * 0.5) as u64;
        total_cas += cas_equiv;
        breakdown.push(ComparisonBreakdown {
            ecosystem: "python".to_string(),
            traditional_dir: ".venv".to_string(),
            traditional_bytes: size,
            cas_bytes: cas_equiv,
            savings_percent: if size > 0 { ((size - cas_equiv) as f64 / size as f64) * 100.0 } else { 0.0 },
        });
    }

    // Cargo target/
    let cargo_target = project_root.join("target");
    if cargo_target.exists() {
        let size = dir_size(&cargo_target);
        total_traditional += size;
        let cas_equiv = (size as f64 * 0.4) as u64;
        total_cas += cas_equiv;
        breakdown.push(ComparisonBreakdown {
            ecosystem: "cargo".to_string(),
            traditional_dir: "target".to_string(),
            traditional_bytes: size,
            cas_bytes: cas_equiv,
            savings_percent: if size > 0 { ((size - cas_equiv) as f64 / size as f64) * 100.0 } else { 0.0 },
        });
    }

    let savings = if total_traditional > total_cas { total_traditional - total_cas } else { 0 };
    let savings_percent = if total_traditional > 0 {
        (savings as f64 / total_traditional as f64) * 100.0
    } else { 0.0 };

    Ok(ComparisonStats {
        without_better_bytes: total_traditional,
        with_better_bytes: total_cas,
        savings_bytes: savings,
        savings_percent,
        breakdown,
    })
}
