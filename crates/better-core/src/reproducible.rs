// crates/better-core/src/reproducible.rs
//
// Reproducible build verification — ensure the same inputs always produce
// the same output, regardless of build environment.

use std::path::Path;
use std::collections::HashMap;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BuildManifest {
    pub version: u32,
    pub created_at: String,
    pub node_version: String,
    pub better_version: String,
    pub platform: String,
    pub lockfile_hash: String,
    pub packages: Vec<PackageManifestEntry>,
    pub environment_hash: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PackageManifestEntry {
    pub name: String,
    pub version: String,
    pub integrity: String,
    pub resolved: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReproducibilityReport {
    pub reproducible: bool,
    pub differences: Vec<BuildDiff>,
    pub summary: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BuildDiff {
    pub package: String,
    pub field: String,
    pub baseline: String,
    pub current: String,
}

/// Generate a reproducible build manifest from the current lockfile.
pub fn generate_manifest(project_root: &Path, better_version: &str) -> Result<BuildManifest, String> {
    let lockfile = project_root.join("package-lock.json");
    let content = std::fs::read_to_string(&lockfile)
        .map_err(|e| format!("Cannot read package-lock.json: {}", e))?;

    let lockfile_hash = sha256_hex(content.as_bytes());
    let lock: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Cannot parse package-lock.json: {}", e))?;

    let mut packages = Vec::new();
    if let Some(pkgs) = lock["packages"].as_object() {
        for (key, val) in pkgs {
            if key.is_empty() { continue; }
            let name = key.trim_start_matches("node_modules/");
            packages.push(PackageManifestEntry {
                name: name.to_string(),
                version: val["version"].as_str().unwrap_or("").to_string(),
                integrity: val["integrity"].as_str().unwrap_or("").to_string(),
                resolved: val["resolved"].as_str().unwrap_or("").to_string(),
            });
        }
    }

    let env_input = format!("{}:{}", std::env::var("PATH").unwrap_or_default(), better_version);
    let environment_hash = sha256_hex(env_input.as_bytes())[..16].to_string();

    Ok(BuildManifest {
        version: 1,
        created_at: "2026-03-30T00:00:00Z".to_string(),
        node_version: std::env::var("NODE_VERSION").unwrap_or_else(|_| "unknown".to_string()),
        better_version: better_version.to_string(),
        platform: std::env::consts::OS.to_string(),
        lockfile_hash,
        packages,
        environment_hash,
    })
}

/// Save a build manifest to `.better-build-manifest.json`.
pub fn save_manifest(manifest: &BuildManifest, project_root: &Path) -> Result<(), String> {
    let path = project_root.join(".better-build-manifest.json");
    let content = serde_json::to_string_pretty(manifest)
        .map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| e.to_string())
}

/// Load a build manifest from disk.
pub fn load_manifest(project_root: &Path) -> Result<BuildManifest, String> {
    let path = project_root.join(".better-build-manifest.json");
    let content = std::fs::read_to_string(&path)
        .map_err(|_| "No build manifest found. Run 'better lock manifest' first.".to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

/// Verify current state against a baseline manifest.
pub fn verify_reproducibility(baseline: &BuildManifest, project_root: &Path, better_version: &str) -> Result<ReproducibilityReport, String> {
    let current = generate_manifest(project_root, better_version)?;

    let mut differences = Vec::new();

    // Check lockfile hash
    if baseline.lockfile_hash != current.lockfile_hash {
        differences.push(BuildDiff {
            package: "(lockfile)".to_string(),
            field: "lockfile_hash".to_string(),
            baseline: baseline.lockfile_hash[..8].to_string(),
            current: current.lockfile_hash[..8].to_string(),
        });
    }

    // Check packages
    let baseline_map: HashMap<&str, &PackageManifestEntry> = baseline.packages.iter()
        .map(|p| (p.name.as_str(), p))
        .collect();
    let current_map: HashMap<&str, &PackageManifestEntry> = current.packages.iter()
        .map(|p| (p.name.as_str(), p))
        .collect();

    for (name, curr) in &current_map {
        if let Some(base) = baseline_map.get(name) {
            if base.version != curr.version {
                differences.push(BuildDiff {
                    package: name.to_string(),
                    field: "version".to_string(),
                    baseline: base.version.clone(),
                    current: curr.version.clone(),
                });
            }
            if !base.integrity.is_empty() && base.integrity != curr.integrity {
                differences.push(BuildDiff {
                    package: name.to_string(),
                    field: "integrity".to_string(),
                    baseline: base.integrity[..12.min(base.integrity.len())].to_string(),
                    current: curr.integrity[..12.min(curr.integrity.len())].to_string(),
                });
            }
        }
    }

    let reproducible = differences.is_empty();
    let summary = if reproducible {
        format!("Build is reproducible ({} packages verified)", current.packages.len())
    } else {
        format!("{} differences found — build is NOT reproducible", differences.len())
    };

    Ok(ReproducibilityReport { reproducible, differences, summary })
}

fn sha256_hex(data: &[u8]) -> String {
    // Simple FNV-1a hash as stand-in (not SHA-256, but deterministic)
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}{:016x}{:016x}{:016x}", h, h.rotate_left(13), h.rotate_right(7), h ^ 0xdeadbeef)
}
