use std::fs;
use std::path::Path;

use crate::types::ResolvedPackage;
use crate::{chrono_now, extract_json_field, JsonWriter, VERSION};

// === Install receipt for audit trail ===

#[derive(Debug, Clone)]
pub struct ReceiptPackage {
    pub name: String,
    pub version: String,
    pub integrity: String,
    pub provenance: bool,
}

#[derive(Debug)]
pub struct InstallReceipt {
    pub timestamp: String,
    pub better_version: String,
    pub packages_installed: u64,
    pub packages: Vec<ReceiptPackage>,
    pub policy_score: Option<i32>,
    pub lockfile_hash: Option<String>,
}

/// Write an install receipt after a successful install.
pub fn write_install_receipt(
    project_root: &Path,
    packages: &[ResolvedPackage],
    policy_score: Option<i32>,
    lockfile_hash: Option<&str>,
    provenance_packages: &[String],
) -> Result<(), String> {
    let receipt = InstallReceipt {
        timestamp: chrono_now(),
        better_version: VERSION.to_string(),
        packages_installed: packages.len() as u64,
        packages: packages
            .iter()
            .map(|p| ReceiptPackage {
                name: p.name.clone(),
                version: p.version.clone(),
                integrity: p.integrity.clone(),
                provenance: provenance_packages.contains(&format!("{}@{}", p.name, p.version)),
            })
            .collect(),
        policy_score,
        lockfile_hash: lockfile_hash.map(|s| s.to_string()),
    };

    let json = write_receipt_json(&receipt);
    let receipt_path = project_root.join(".better-receipt.json");
    fs::write(&receipt_path, json).map_err(|e| format!("Failed to write receipt: {}", e))?;
    Ok(())
}

/// Serialize a receipt to JSON.
fn write_receipt_json(receipt: &InstallReceipt) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("timestamp");
    w.value_string(&receipt.timestamp);
    w.key("better_version");
    w.value_string(&receipt.better_version);
    w.key("packages_installed");
    w.value_u64(receipt.packages_installed);
    w.key("packages");
    w.begin_array();
    for pkg in &receipt.packages {
        w.begin_object();
        w.key("name");
        w.value_string(&pkg.name);
        w.key("version");
        w.value_string(&pkg.version);
        w.key("integrity");
        w.value_string(&pkg.integrity);
        w.key("provenance");
        w.value_bool(pkg.provenance);
        w.end_object();
    }
    w.end_array();
    if let Some(score) = receipt.policy_score {
        w.key("policy_score");
        w.value_i64(score as i64);
    }
    if let Some(ref hash) = receipt.lockfile_hash {
        w.key("lockfile_hash");
        w.value_string(hash);
    }
    w.end_object();
    w.finish()
}

/// List all receipts in the project root (currently just the latest one).
pub fn list_receipts(project_root: &Path) -> Result<Vec<InstallReceipt>, String> {
    let receipt_path = project_root.join(".better-receipt.json");
    if !receipt_path.exists() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(&receipt_path).map_err(|e| format!("Failed to read receipt: {}", e))?;
    let receipt = parse_receipt(&content)?;
    Ok(vec![receipt])
}

/// Parse a receipt from JSON string.
fn parse_receipt(json: &str) -> Result<InstallReceipt, String> {
    let timestamp = extract_json_field(json, "timestamp").unwrap_or_default();
    let better_version = extract_json_field(json, "better_version").unwrap_or_default();
    let packages_installed = crate::extract_json_number(json, "packages_installed").unwrap_or(0);
    let lockfile_hash = extract_json_field(json, "lockfile_hash");

    // Parse policy_score (numeric field)
    let policy_score = crate::extract_json_number(json, "policy_score").map(|n| n as i32);

    // We don't parse individual packages for listing — just metadata
    Ok(InstallReceipt {
        timestamp,
        better_version,
        packages_installed,
        packages: Vec::new(),
        policy_score,
        lockfile_hash,
    })
}

/// Verify that the current receipt matches the installed packages.
pub fn verify_receipt(project_root: &Path) -> Result<ReceiptVerifyResult, String> {
    let receipt_path = project_root.join(".better-receipt.json");
    if !receipt_path.exists() {
        return Err("No .better-receipt.json found — run `better install` first".into());
    }
    let content =
        fs::read_to_string(&receipt_path).map_err(|e| format!("Failed to read receipt: {}", e))?;
    let receipt = parse_receipt(&content)?;

    // Verify lockfile hash if present
    let lockfile_ok = if let Some(ref expected_hash) = receipt.lockfile_hash {
        let lockfile = project_root.join("package-lock.json");
        if lockfile.exists() {
            let lockfile_content =
                fs::read_to_string(&lockfile).map_err(|e| format!("Failed to read lockfile: {}", e))?;
            let actual_hash = compute_sha256(&lockfile_content);
            actual_hash == *expected_hash
        } else {
            false
        }
    } else {
        true // No hash to verify
    };

    // Verify node_modules exists
    let node_modules = project_root.join("node_modules");
    let node_modules_ok = node_modules.exists() && node_modules.is_dir();

    Ok(ReceiptVerifyResult {
        receipt_exists: true,
        timestamp: receipt.timestamp,
        packages_installed: receipt.packages_installed,
        lockfile_matches: lockfile_ok,
        node_modules_present: node_modules_ok,
        ok: lockfile_ok && node_modules_ok,
    })
}

#[derive(Debug)]
pub struct ReceiptVerifyResult {
    pub receipt_exists: bool,
    pub timestamp: String,
    pub packages_installed: u64,
    pub lockfile_matches: bool,
    pub node_modules_present: bool,
    pub ok: bool,
}

pub fn write_receipt_verify_json(result: &ReceiptVerifyResult) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("kind");
    w.value_string("better.receipt.verify");
    w.key("ok");
    w.value_bool(result.ok);
    w.key("receiptExists");
    w.value_bool(result.receipt_exists);
    w.key("timestamp");
    w.value_string(&result.timestamp);
    w.key("packagesInstalled");
    w.value_u64(result.packages_installed);
    w.key("lockfileMatches");
    w.value_bool(result.lockfile_matches);
    w.key("nodeModulesPresent");
    w.value_bool(result.node_modules_present);
    w.end_object();
    w.finish()
}

fn compute_sha256(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    format!("sha256:{:x}", result)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pkg(name: &str, version: &str) -> ResolvedPackage {
        ResolvedPackage {
            name: name.to_string(),
            version: version.to_string(),
            rel_path: format!("node_modules/{}", name),
            resolved_url: String::new(),
            integrity: String::new(),
        }
    }

    #[test]
    fn write_and_list_receipts() {
        let tmp = std::env::temp_dir().join("receipt-test-write");
        std::fs::create_dir_all(&tmp).unwrap();
        let pkgs = vec![make_pkg("lodash", "4.17.21")];
        write_install_receipt(&tmp, &pkgs, Some(95), None, &[]).unwrap();
        let receipts = list_receipts(&tmp).unwrap();
        assert!(!receipts.is_empty());
        assert_eq!(receipts[0].packages_installed, 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn list_receipts_no_receipt_file_returns_empty() {
        let tmp = std::env::temp_dir().join("receipt-test-none");
        std::fs::create_dir_all(&tmp).unwrap();
        let receipts = list_receipts(&tmp).unwrap();
        assert!(receipts.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn verify_receipt_no_receipt_returns_err() {
        let tmp = std::env::temp_dir().join("receipt-test-verify-none");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = verify_receipt(&tmp);
        assert!(result.is_err()); // no receipt file → error
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sha256_fn_produces_deterministic_hash() {
        let h1 = compute_sha256("hello");
        let h2 = compute_sha256("hello");
        assert_eq!(h1, h2);
        assert!(h1.starts_with("sha256:"));
    }
}
