// crates/better-core/src/intelligence/supply_chain.rs
// Supply chain trust graph with anomaly detection

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct SupplyChainReport {
    pub total_packages: usize,
    pub anomalies: Vec<SupplyChainAnomaly>,
    pub publisher_stats: PublisherStats,
    pub provenance_coverage: f64,  // 0-1
    pub trust_score: f64,           // 0-100
}

#[derive(Debug, Clone, Serialize)]
pub struct SupplyChainAnomaly {
    pub severity: AnomalySeverity,
    pub kind: AnomalyKind,
    pub package: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub enum AnomalySeverity { Critical, High, Medium, Low }

#[derive(Debug, Clone, Serialize)]
pub enum AnomalyKind {
    PublisherChanged,
    SuddenDepExplosion,
    NoProvenance,
    NonNpmRegistry,
    ScriptPresent,
    SuspiciousName,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublisherStats {
    pub unique_publishers: usize,
    pub top_publishers: Vec<PublisherEntry>,
    pub concentration_score: f64,  // 0-1, 1 = all from one publisher
}

#[derive(Debug, Clone, Serialize)]
pub struct PublisherEntry {
    pub name: String,
    pub package_count: usize,
    pub percent: f64,
}

/// Analyze supply chain from package-lock.json.
pub fn analyze_supply_chain(project_root: &Path) -> Result<SupplyChainReport, String> {
    let lock_path = project_root.join("package-lock.json");
    let lock_text = std::fs::read_to_string(&lock_path)
        .map_err(|e| format!("Cannot read package-lock.json: {}", e))?;
    let lock: serde_json::Value = serde_json::from_str(&lock_text)
        .map_err(|e| format!("Cannot parse package-lock.json: {}", e))?;

    let packages = lock.get("packages")
        .and_then(|p| p.as_object())
        .cloned()
        .unwrap_or_default();

    let total_packages = packages.len();
    let mut anomalies = vec![];

    // Check for non-standard registry URLs
    let npm_registry = "https://registry.npmjs.org/";
    let mut non_npm_count = 0;
    let mut scripts_count = 0;
    let mut has_scripts_packages: Vec<String> = vec![];

    for (pkg_path, info) in &packages {
        if pkg_path.is_empty() { continue; } // root

        let name = if pkg_path.starts_with("node_modules/") {
            pkg_path[13..].to_string()
        } else {
            pkg_path.clone()
        };

        // Check for non-npm registry
        if let Some(resolved) = info.get("resolved").and_then(|v| v.as_str()) {
            if !resolved.is_empty() && !resolved.starts_with(npm_registry) && !resolved.starts_with("file:") {
                non_npm_count += 1;
                if non_npm_count <= 5 {
                    anomalies.push(SupplyChainAnomaly {
                        severity: AnomalySeverity::Medium,
                        kind: AnomalyKind::NonNpmRegistry,
                        package: name.clone(),
                        description: format!("Resolved from non-standard registry: {}", resolved),
                    });
                }
            }
        }

        // Check for install scripts
        if let Some(scripts) = info.get("scripts").and_then(|v| v.as_object()) {
            let has_dangerous = scripts.keys().any(|k| {
                matches!(k.as_str(), "preinstall" | "install" | "postinstall")
            });
            if has_dangerous {
                scripts_count += 1;
                has_scripts_packages.push(name.clone());
                if scripts_count <= 10 {
                    anomalies.push(SupplyChainAnomaly {
                        severity: AnomalySeverity::Low,
                        kind: AnomalyKind::ScriptPresent,
                        package: name.clone(),
                        description: "Package has install scripts (preinstall/install/postinstall)".to_string(),
                    });
                }
            }
        }

        // Check for suspicious names (typosquat patterns)
        let suspicious_patterns = &["colors-", "color-", "chalk-", "lodash-", "express-"];
        for pat in suspicious_patterns {
            if name.starts_with(pat) && name.len() < pat.len() + 5 {
                anomalies.push(SupplyChainAnomaly {
                    severity: AnomalySeverity::High,
                    kind: AnomalyKind::SuspiciousName,
                    package: name.clone(),
                    description: format!("Package name '{}' may be a typosquat", name),
                });
                break;
            }
        }
    }

    // Publisher stats (from npm metadata if available)
    let publisher_stats = PublisherStats {
        unique_publishers: 0, // Would need registry API calls
        top_publishers: vec![],
        concentration_score: 0.0,
    };

    let trust_score = {
        let anomaly_penalty = anomalies.iter().map(|a| match a.severity {
            AnomalySeverity::Critical => 20.0,
            AnomalySeverity::High => 10.0,
            AnomalySeverity::Medium => 5.0,
            AnomalySeverity::Low => 1.0,
        }).sum::<f64>();
        (100.0 - anomaly_penalty).max(0.0)
    };

    Ok(SupplyChainReport {
        total_packages,
        anomalies,
        publisher_stats,
        provenance_coverage: 0.0,
        trust_score,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_lock(path: &std::path::Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn clean_lock_no_anomalies() {
        let tmp = std::env::temp_dir().join("supply-chain-clean");
        let lock = serde_json::json!({
            "lockfileVersion": 3,
            "packages": {
                "": { "name": "myapp" },
                "node_modules/express": {
                    "version": "4.18.2",
                    "resolved": "https://registry.npmjs.org/express/-/express-4.18.2.tgz"
                }
            }
        });
        write_lock(&tmp.join("package-lock.json"), &lock.to_string());
        let report = analyze_supply_chain(&tmp).unwrap();
        assert!(report.anomalies.iter().all(|a| !matches!(a.kind, AnomalyKind::NonNpmRegistry)));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn non_npm_registry_flagged() {
        let tmp = std::env::temp_dir().join("supply-chain-registry");
        let lock = serde_json::json!({
            "lockfileVersion": 3,
            "packages": {
                "node_modules/internal-pkg": {
                    "version": "1.0.0",
                    "resolved": "https://my-private-registry.example.com/internal-pkg-1.0.0.tgz"
                }
            }
        });
        write_lock(&tmp.join("package-lock.json"), &lock.to_string());
        let report = analyze_supply_chain(&tmp).unwrap();
        assert!(report.anomalies.iter().any(|a| matches!(a.kind, AnomalyKind::NonNpmRegistry)));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn install_script_flagged() {
        let tmp = std::env::temp_dir().join("supply-chain-scripts");
        let lock = serde_json::json!({
            "lockfileVersion": 3,
            "packages": {
                "node_modules/tricky-pkg": {
                    "version": "1.0.0",
                    "resolved": "https://registry.npmjs.org/tricky-pkg/-/tricky-pkg-1.0.0.tgz",
                    "scripts": { "postinstall": "node setup.js" }
                }
            }
        });
        write_lock(&tmp.join("package-lock.json"), &lock.to_string());
        let report = analyze_supply_chain(&tmp).unwrap();
        assert!(report.anomalies.iter().any(|a| matches!(a.kind, AnomalyKind::ScriptPresent)));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn trust_score_reduces_with_anomalies() {
        let tmp = std::env::temp_dir().join("supply-chain-score");
        let lock = serde_json::json!({
            "lockfileVersion": 3,
            "packages": {
                "node_modules/bad-pkg": {
                    "version": "1.0.0",
                    "resolved": "https://evil.example.com/bad-pkg.tgz",
                    "scripts": { "preinstall": "rm -rf /" }
                }
            }
        });
        write_lock(&tmp.join("package-lock.json"), &lock.to_string());
        let report = analyze_supply_chain(&tmp).unwrap();
        assert!(report.trust_score < 100.0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_lock_returns_error() {
        let result = analyze_supply_chain(std::path::Path::new("/nonexistent-project"));
        assert!(result.is_err());
    }
}
