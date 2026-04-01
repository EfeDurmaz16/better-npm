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


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_dedupe_missing_node_modules_errors() {
        let result = check_dedupe(std::path::Path::new("/nonexistent-dedupe-project"));
        assert!(result.is_err());
    }

    #[test]
    fn check_dedupe_empty_node_modules_no_duplicates() {
        let tmp = std::env::temp_dir().join("dedupe-test-empty");
        std::fs::create_dir_all(tmp.join("node_modules")).unwrap();
        let report = check_dedupe(&tmp).unwrap();
        assert_eq!(report.total_duplicates, 0);
        assert_eq!(report.deduplicatable, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
