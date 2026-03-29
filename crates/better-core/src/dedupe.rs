use std::path::Path;

use crate::types::*;
use crate::analyze;

// --- B.3: Dedupe Checker ---

pub fn check_dedupe(root: &Path) -> Result<DedupeReport, String> {
    let report = analyze(root, false)?;
    let mut entries = Vec::new();
    let mut total_dup = 0u64;
    let mut dedup_count = 0u64;
    let mut estimated_saved = 0u64;

    for d in &report.duplicates {
        let can_dedupe = d.majors.len() == 1;
        let saved = if can_dedupe { d.count.saturating_sub(1) } else { 0 };

        total_dup += 1;
        if can_dedupe { dedup_count += 1; }
        estimated_saved += saved;

        entries.push(DedupeEntry {
            name: d.name.clone(),
            versions: d.versions.clone(),
            instances: d.count,
            can_dedupe,
            saved_instances: saved,
        });
    }

    Ok(DedupeReport {
        duplicates: entries,
        total_duplicates: total_dup,
        deduplicatable: dedup_count,
        estimated_saved,
    })
}

