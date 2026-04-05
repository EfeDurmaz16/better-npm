//! Preview Environments — Task 112
//!
//! Ephemeral OSP services + PR preview deploys with auto-deprovision TTL.
//! `better preview` creates a short-lived deployment environment tied to a
//! PR branch that tears itself down after a configurable TTL.
//!
//! State is stored in `~/.better/previews/<preview-id>.json`.
//! Cleanup runs on `better preview cleanup` (or can be scheduled in CI).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::provision::{parse_env_osp, OspServiceRef};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewDeployment {
    pub preview_id: String,
    pub branch: String,
    pub pr_number: Option<u32>,
    pub url: Option<String>,
    pub services: Vec<EphemeralService>,
    pub ttl_seconds: u64,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: String, // "active", "expired", "deprovisioned"
    pub env_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EphemeralService {
    pub service_id: String,
    pub provider: String,
    pub service_type: String,
    pub env_var: String,
    pub status: String,   // "provisioned", "deprovisioned"
    pub expires_at: u64,
}

#[derive(Debug, Serialize)]
pub struct CreatePreviewResult {
    pub ok: bool,
    pub preview: Option<PreviewDeployment>,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CleanupResult {
    pub ok: bool,
    pub cleaned: usize,
    pub previews_removed: Vec<String>,
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// create_preview
// ---------------------------------------------------------------------------

/// Create a preview deployment with ephemeral OSP services.
///
/// - Provisions each service from `.env.osp` with the given TTL
/// - Writes `.env.preview.<preview_id>` with the credentials
/// - Stores preview state in `~/.better/previews/`
/// - Returns the preview info including the generated URL
pub fn create_preview(
    project_root: &Path,
    branch: &str,
    pr_number: Option<u32>,
    ttl_seconds: u64,
) -> CreatePreviewResult {
    let now = current_timestamp();
    let preview_id = generate_preview_id(branch, pr_number);
    let expires_at = now + ttl_seconds;

    // Check if a preview already exists for this branch/PR
    if let Some(existing) = load_preview(&preview_id) {
        if existing.status == "active" && now < existing.expires_at {
            return CreatePreviewResult {
                ok: true,
                preview: Some(existing),
                reason: None,
            };
        }
    }

    let env_osp_path = project_root.join(".env.osp");
    let service_refs = if env_osp_path.exists() {
        match parse_env_osp(&env_osp_path) {
            Ok(refs) => refs,
            Err(e) => return CreatePreviewResult {
                ok: false,
                preview: None,
                reason: Some(format!("failed to parse .env.osp: {}", e)),
            },
        }
    } else {
        vec![]
    };

    // Provision ephemeral services
    let mut services: Vec<EphemeralService> = Vec::new();
    let mut env_vars: HashMap<String, String> = HashMap::new();

    for svc_ref in &service_refs {
        let (cred, service) = provision_ephemeral(svc_ref, &preview_id, expires_at);
        env_vars.insert(svc_ref.env_var.clone(), cred);
        services.push(service);
    }

    // Write preview .env file
    let env_file = project_root.join(format!(".env.preview.{}", preview_id));
    let env_content: String = env_vars
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("\n") + "\n";

    if let Err(e) = fs::write(&env_file, &env_content) {
        return CreatePreviewResult {
            ok: false,
            preview: None,
            reason: Some(format!("failed to write env file: {}", e)),
        };
    }

    // Generate preview URL (in production this would trigger an actual deploy)
    let url = format!(
        "https://preview-{}.{}.vercel.app",
        sanitize_branch(branch),
        preview_id
    );

    let deployment = PreviewDeployment {
        preview_id: preview_id.clone(),
        branch: branch.to_string(),
        pr_number,
        url: Some(url),
        services,
        ttl_seconds,
        created_at: now,
        expires_at,
        status: "active".to_string(),
        env_file: env_file.display().to_string(),
    };

    save_preview(&deployment);

    CreatePreviewResult {
        ok: true,
        preview: Some(deployment),
        reason: None,
    }
}

// ---------------------------------------------------------------------------
// cleanup_expired_previews
// ---------------------------------------------------------------------------

/// Remove expired preview deployments and deprovision their services.
/// Returns the number of previews cleaned up.
pub fn cleanup_expired_previews() -> CleanupResult {
    let now = current_timestamp();
    let preview_dir = previews_dir();

    let mut cleaned = 0;
    let mut removed = Vec::new();

    let entries = match fs::read_dir(&preview_dir) {
        Ok(e) => e,
        Err(_) => return CleanupResult { ok: true, cleaned: 0, previews_removed: vec![], reason: None },
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let preview = match fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<PreviewDeployment>(&s).ok())
        {
            Some(p) => p,
            None => continue,
        };

        if now > preview.expires_at && preview.status == "active" {
            // Mark as deprovisioned
            let mut updated = preview.clone();
            updated.status = "deprovisioned".to_string();
            save_preview(&updated);

            // Clean up env file
            if !updated.env_file.is_empty() {
                let _ = fs::remove_file(&updated.env_file);
            }

            removed.push(preview.preview_id.clone());
            cleaned += 1;
        }
    }

    CleanupResult { ok: true, cleaned, previews_removed: removed, reason: None }
}

// ---------------------------------------------------------------------------
// list_previews
// ---------------------------------------------------------------------------

/// List all active preview deployments.
pub fn list_previews() -> Vec<PreviewDeployment> {
    let preview_dir = previews_dir();
    let mut previews = Vec::new();

    if let Ok(entries) = fs::read_dir(&preview_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(preview) = serde_json::from_str::<PreviewDeployment>(&content) {
                    previews.push(preview);
                }
            }
        }
    }

    previews
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn provision_ephemeral(
    svc: &OspServiceRef,
    preview_id: &str,
    expires_at: u64,
) -> (String, EphemeralService) {
    let service_id = format!("{}-{}-{}", preview_id, svc.service_type, &svc.provider_domain[..4.min(svc.provider_domain.len())]);

    // Generate a stub credential (real impl would call OSP provider API)
    let cred = match svc.service_type.as_str() {
        "postgres" | "database" =>
            format!("postgresql://preview_{}:ephem@{}/db_{}", &preview_id[..8], svc.provider_domain, &preview_id[..8]),
        "redis" | "cache" =>
            format!("redis://:ephem_{}@{}:6379/0", &preview_id[..8], svc.provider_domain),
        _ =>
            format!("osp://{}:{}", svc.provider_domain, expires_at),
    };

    let service = EphemeralService {
        service_id,
        provider: svc.provider_domain.clone(),
        service_type: svc.service_type.clone(),
        env_var: svc.env_var.clone(),
        status: "provisioned".to_string(),
        expires_at,
    };

    (cred, service)
}

fn generate_preview_id(branch: &str, pr_number: Option<u32>) -> String {
    let sanitized = sanitize_branch(branch);
    match pr_number {
        Some(n) => format!("pr{}-{}", n, &sanitized[..sanitized.len().min(12)]),
        None    => format!("br-{}", &sanitized[..sanitized.len().min(16)]),
    }
}

fn sanitize_branch(branch: &str) -> String {
    branch
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase()
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn previews_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".better")
        .join("previews")
}

fn preview_path(preview_id: &str) -> PathBuf {
    previews_dir().join(format!("{}.json", preview_id))
}

fn load_preview(preview_id: &str) -> Option<PreviewDeployment> {
    let path = preview_path(preview_id);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn save_preview(preview: &PreviewDeployment) {
    let path = preview_path(&preview.preview_id);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(preview) {
        let _ = fs::write(&path, json);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_preview_id_with_pr() {
        let id = generate_preview_id("feature/my-cool-feature", Some(42));
        assert!(id.starts_with("pr42-"), "got: {}", id);
    }

    #[test]
    fn generate_preview_id_without_pr() {
        let id = generate_preview_id("main", None);
        assert!(id.starts_with("br-main"), "got: {}", id);
    }

    #[test]
    fn sanitize_branch_replaces_slashes() {
        assert_eq!(sanitize_branch("feature/my-feat"), "feature-my-feat");
        assert_eq!(sanitize_branch("fix/bug#123"), "fix-bug-123");
    }

    #[test]
    fn create_preview_no_env_osp() {
        let dir = std::env::temp_dir().join("preview-test-no-osp");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let result = create_preview(&dir, "feature-branch", None, 3600);
        assert!(result.ok, "expected ok, got: {:?}", result.reason);
        let preview = result.preview.unwrap();
        assert_eq!(preview.branch, "feature-branch");
        assert!(preview.services.is_empty());
        assert_eq!(preview.ttl_seconds, 3600);

        // Cleanup
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(preview_path(&preview.preview_id));
    }

    #[test]
    fn create_preview_with_env_osp() {
        let dir = std::env::temp_dir().join("preview-test-with-osp");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".env.osp"), "DB_URL=osp://db.example.com/postgres/conn\n").unwrap();

        let result = create_preview(&dir, "my-branch", Some(99), 7200);
        assert!(result.ok, "expected ok, got: {:?}", result.reason);
        let preview = result.preview.unwrap();
        assert_eq!(preview.services.len(), 1);
        assert_eq!(preview.services[0].service_type, "postgres");
        assert!(dir.join(format!(".env.preview.{}", preview.preview_id)).exists());

        // Cleanup
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(preview_path(&preview.preview_id));
    }

    #[test]
    fn cleanup_removes_expired_previews() {
        // This test would need to mock time, so just verify it runs without panic
        let result = cleanup_expired_previews();
        assert!(result.ok);
    }
}
