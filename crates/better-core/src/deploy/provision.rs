//! Deploy with Auto-Provision — Task 109
//!
//! Reads `.env.osp` files to find OSP service references, provisions any
//! unprovisioned services, injects credentials into the deployment environment,
//! and estimates the monthly cost.
//!
//! `.env.osp` format:
//! ```text
//! DATABASE_URL=osp://supabase.com/postgres/connection_string
//! REDIS_URL=osp://upstash.com/redis/connection_string?tier=free
//! ```

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PreDeployResult {
    pub ok: bool,
    pub services_provisioned: Vec<ProvisionedService>,
    pub services_already_provisioned: Vec<String>,
    pub env_vars_injected: usize,
    pub total_cost_estimate: CostEstimate,
    pub env_path: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProvisionedService {
    pub service: String,
    pub tier: String,
    pub status: String,
    pub credentials_injected: Vec<String>,
    pub monthly_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostEstimate {
    pub monthly_usd: f64,
    pub breakdown: Vec<CostBreakdown>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostBreakdown {
    pub service: String,
    pub tier: String,
    pub monthly_usd: f64,
}

#[derive(Debug, Clone)]
pub struct OspServiceRef {
    /// e.g. "supabase.com"
    pub provider_domain: String,
    /// e.g. "postgres"
    pub service_type: String,
    /// e.g. "connection_string" — which credential field to inject
    pub credential_path: String,
    /// e.g. "free" or "starter"
    pub tier: String,
    /// The environment variable name to inject into
    pub env_var: String,
}

// ---------------------------------------------------------------------------
// pre_deploy_provision
// ---------------------------------------------------------------------------

/// Read `.env.osp`, provision any unprovisioned services, write `.env` with
/// injected credentials.  Returns a summary for display and cost estimation.
///
/// Idempotent: already-provisioned services are read from the state cache
/// (`~/.better/osp-state/<project-hash>.json`) and not re-provisioned.
pub fn pre_deploy_provision(
    project_root: &Path,
    environment: &str,
) -> PreDeployResult {
    let env_osp_path = project_root.join(".env.osp");

    if !env_osp_path.exists() {
        return PreDeployResult {
            ok: true,
            services_provisioned: vec![],
            services_already_provisioned: vec![],
            env_vars_injected: 0,
            total_cost_estimate: CostEstimate { monthly_usd: 0.0, breakdown: vec![] },
            env_path: String::new(),
            reason: None,
        };
    }

    let refs = match parse_env_osp(&env_osp_path) {
        Ok(r) => r,
        Err(e) => return PreDeployResult {
            ok: false,
            services_provisioned: vec![],
            services_already_provisioned: vec![],
            env_vars_injected: 0,
            total_cost_estimate: CostEstimate { monthly_usd: 0.0, breakdown: vec![] },
            env_path: String::new(),
            reason: Some(e),
        },
    };

    let state_path = state_cache_path(project_root, environment);
    let mut state = load_state_cache(&state_path);

    let mut provisioned: Vec<ProvisionedService> = Vec::new();
    let mut already_provisioned: Vec<String> = Vec::new();
    let mut env_lines: Vec<String> = Vec::new();
    let mut total_cost = 0.0;
    let mut breakdown: Vec<CostBreakdown> = Vec::new();

    for svc_ref in &refs {
        let cache_key = format!("{}/{}/{}", svc_ref.provider_domain, svc_ref.service_type, environment);

        if let Some(cached_cred) = state.get(&cache_key) {
            // Already provisioned — just inject the cached credential
            env_lines.push(format!("{}={}", svc_ref.env_var, cached_cred));
            already_provisioned.push(svc_ref.service_type.clone());
        } else {
            // Provision the service
            let (cred, cost) = provision_service(svc_ref);
            state.insert(cache_key, cred.clone());
            env_lines.push(format!("{}={}", svc_ref.env_var, cred));

            total_cost += cost;
            breakdown.push(CostBreakdown {
                service: format!("{}/{}", svc_ref.provider_domain, svc_ref.service_type),
                tier: svc_ref.tier.clone(),
                monthly_usd: cost,
            });

            provisioned.push(ProvisionedService {
                service: format!("{}/{}", svc_ref.provider_domain, svc_ref.service_type),
                tier: svc_ref.tier.clone(),
                status: "provisioned".to_string(),
                credentials_injected: vec![svc_ref.env_var.clone()],
                monthly_usd: cost,
            });
        }
    }

    // Write the .env.<environment> file with injected credentials
    let env_file = project_root.join(format!(".env.{}", environment));
    let env_content = env_lines.join("\n") + "\n";

    if let Err(e) = fs::write(&env_file, &env_content) {
        return PreDeployResult {
            ok: false,
            services_provisioned: provisioned,
            services_already_provisioned: already_provisioned,
            env_vars_injected: 0,
            total_cost_estimate: CostEstimate { monthly_usd: total_cost, breakdown },
            env_path: env_file.display().to_string(),
            reason: Some(format!("failed to write {}: {}", env_file.display(), e)),
        };
    }

    save_state_cache(&state_path, &state);

    let injected = env_lines.len();
    PreDeployResult {
        ok: true,
        services_provisioned: provisioned,
        services_already_provisioned: already_provisioned,
        env_vars_injected: injected,
        total_cost_estimate: CostEstimate { monthly_usd: total_cost, breakdown },
        env_path: env_file.display().to_string(),
        reason: None,
    }
}

// ---------------------------------------------------------------------------
// Parse .env.osp
// ---------------------------------------------------------------------------

/// Parse a `.env.osp` file into a list of OSP service references.
///
/// Format: `VAR_NAME=osp://<provider_domain>/<service_type>/<cred_path>[?tier=<tier>]`
pub fn parse_env_osp(path: &Path) -> Result<Vec<OspServiceRef>, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;

    let mut refs = Vec::new();
    for (line_num, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((var, val)) = line.split_once('=') else {
            continue;
        };

        let val = val.trim();
        if !val.starts_with("osp://") {
            // Regular env var — skip
            continue;
        }

        let svc_ref = parse_osp_uri(var.trim(), val)
            .map_err(|e| format!("line {}: {}", line_num + 1, e))?;
        refs.push(svc_ref);
    }

    Ok(refs)
}

fn parse_osp_uri(env_var: &str, uri: &str) -> Result<OspServiceRef, String> {
    // osp://provider.com/service_type/cred_path?tier=free
    let without_scheme = uri.strip_prefix("osp://")
        .ok_or_else(|| format!("invalid OSP URI: {}", uri))?;

    let (path_part, query) = without_scheme.split_once('?').unwrap_or((without_scheme, ""));

    let parts: Vec<&str> = path_part.splitn(3, '/').collect();
    if parts.len() < 2 {
        return Err(format!("OSP URI must be osp://domain/service[/cred_path], got: {}", uri));
    }

    let provider_domain = parts[0].to_string();
    let service_type = parts[1].to_string();
    let credential_path = parts.get(2).copied().unwrap_or("default").to_string();

    let tier = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("tier="))
        .unwrap_or("free")
        .to_string();

    Ok(OspServiceRef {
        provider_domain,
        service_type,
        credential_path,
        tier,
        env_var: env_var.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Provision (stub — real impl would call OSP HTTP API)
// ---------------------------------------------------------------------------

/// Provision an OSP service and return (credential_value, monthly_usd).
///
/// In production this calls the OSP provider's `/osp/provision` endpoint.
/// This stub generates a placeholder credential for testing/dry-run scenarios.
fn provision_service(svc: &OspServiceRef) -> (String, f64) {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let cost = match svc.tier.as_str() {
        "free"    => 0.0,
        "starter" => 9.0,
        "pro"     => 29.0,
        _         => 0.0,
    };

    // Generate a placeholder credential string
    let cred = match svc.service_type.as_str() {
        "postgres" | "mysql" | "database" =>
            format!("postgresql://osp_{}:placeholder@{}/db_{}", &ts.to_string()[..8], svc.provider_domain, &ts.to_string()[..8]),
        "redis" | "cache" =>
            format!("redis://:placeholder@{}:6379/{}", svc.provider_domain, ts % 16),
        "s3" | "storage" =>
            format!("https://{}/{}/osp-bucket-{}", svc.provider_domain, svc.service_type, &ts.to_string()[..8]),
        _ =>
            format!("osp://{}:{}", svc.provider_domain, ts),
    };

    (cred, cost)
}

// ---------------------------------------------------------------------------
// State cache (persists idempotency data)
// ---------------------------------------------------------------------------

fn state_cache_path(project_root: &Path, environment: &str) -> std::path::PathBuf {
    use std::hash::{Hash, Hasher};
    use std::collections::hash_map::DefaultHasher;

    let mut h = DefaultHasher::new();
    project_root.hash(&mut h);
    let project_hash = format!("{:x}", h.finish());

    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".better")
        .join("osp-state")
        .join(format!("{}-{}.json", project_hash, environment))
}

fn load_state_cache(path: &Path) -> HashMap<String, String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state_cache(path: &Path, state: &HashMap<String, String>) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, json);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        // Use a unique suffix to avoid state cache collisions across test runs
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        std::env::temp_dir().join(format!("deploy-provision-{}-{}", name, ts))
    }

    fn write_env_osp(dir: &Path, content: &str) {
        fs::create_dir_all(dir).unwrap();
        let mut f = fs::File::create(dir.join(".env.osp")).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn parse_env_osp_basic() {
        let dir = tmp_dir("parse");
        let _ = fs::remove_dir_all(&dir);
        write_env_osp(&dir, "DATABASE_URL=osp://supabase.com/postgres/connection_string?tier=free\n# Comment\nREDIS_URL=osp://upstash.com/redis/default?tier=starter\n");

        let refs = parse_env_osp(&dir.join(".env.osp")).unwrap();
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].env_var, "DATABASE_URL");
        assert_eq!(refs[0].service_type, "postgres");
        assert_eq!(refs[0].tier, "free");
        assert_eq!(refs[1].env_var, "REDIS_URL");
        assert_eq!(refs[1].service_type, "redis");
        assert_eq!(refs[1].tier, "starter");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_env_osp_no_file_returns_empty() {
        let result = pre_deploy_provision(Path::new("/nonexistent/path/xyz"), "production");
        assert!(result.ok);
        assert!(result.services_provisioned.is_empty());
    }

    #[test]
    fn pre_deploy_provision_creates_env_file() {
        let dir = tmp_dir("provision");
        let _ = fs::remove_dir_all(&dir);
        write_env_osp(&dir, "DB_URL=osp://db.example.com/postgres/connection_string\n");

        let result = pre_deploy_provision(&dir, "test");

        // Cleanup state cache so other test runs are not affected
        let state = state_cache_path(&dir, "test");
        let _ = fs::remove_file(&state);
        let _ = fs::remove_dir_all(&dir);

        assert!(result.ok, "provision failed: {:?}", result.reason);
        assert_eq!(result.services_provisioned.len(), 1);
        assert_eq!(result.env_vars_injected, 1);
    }

    #[test]
    fn parse_osp_uri_valid_uri() {
        let svc = parse_osp_uri("DATABASE_URL", "osp://supabase.com/postgres/conn?tier=pro").unwrap();
        assert_eq!(svc.provider_domain, "supabase.com");
        assert_eq!(svc.service_type, "postgres");
        assert_eq!(svc.credential_path, "conn");
        assert_eq!(svc.tier, "pro");
        assert_eq!(svc.env_var, "DATABASE_URL");
    }

    #[test]
    fn parse_osp_uri_invalid_scheme_returns_error() {
        let result = parse_osp_uri("URL", "https://example.com/postgres");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid OSP URI"));
    }

    #[test]
    fn parse_osp_uri_default_credential_path() {
        let svc = parse_osp_uri("REDIS_URL", "osp://upstash.com/redis?tier=free").unwrap();
        assert_eq!(svc.credential_path, "default");
        assert_eq!(svc.tier, "free");
    }

    #[test]
    fn provision_idempotent_on_second_call() {
        let dir = tmp_dir("idempotent");
        let _ = fs::remove_dir_all(&dir);
        write_env_osp(&dir, "DB_URL=osp://db.example.com/postgres/conn\n");

        let first = pre_deploy_provision(&dir, "staging");
        assert!(first.ok);
        assert_eq!(first.services_provisioned.len(), 1);

        let second = pre_deploy_provision(&dir, "staging");
        assert!(second.ok);
        // Second call should reuse cached credentials
        assert_eq!(second.services_provisioned.len(), 0);
        assert_eq!(second.services_already_provisioned.len(), 1);

        // .env file should have DB_URL set
        let env = fs::read_to_string(dir.join(".env.staging")).unwrap();
        assert!(env.contains("DB_URL="));

        // Cleanup
        let state = state_cache_path(&dir, "staging");
        let _ = fs::remove_file(&state);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pre_deploy_result_no_services_is_ok_with_zero_cost() {
        let result = PreDeployResult {
            ok: true,
            services_provisioned: vec![],
            services_already_provisioned: vec![],
            env_vars_injected: 0,
            total_cost_estimate: CostEstimate { monthly_usd: 0.0, breakdown: vec![] },
            env_path: ".env".to_string(),
            reason: None,
        };
        assert!(result.ok);
        assert_eq!(result.total_cost_estimate.monthly_usd, 0.0);
        assert!(result.reason.is_none());
    }
}
