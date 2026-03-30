// crates/better-core/src/services.rs
// Infrastructure as Dependencies — services field in package.json/better.toml

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Services declared in package.json under "better.services"
/// Example:
/// {
///   "better": {
///     "services": {
///       "db": "osp://supabase.com/postgres@free",
///       "cache": "osp://upstash.com/redis@pro"
///     }
///   }
/// }
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServiceDependencies {
    pub services: HashMap<String, String>,  // alias -> osp:// URI
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceSpec {
    pub provider: String,
    pub service: String,
    pub tier: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedService {
    pub alias: String,
    pub provider: String,
    pub service: String,
    pub tier: String,
    pub status: ServiceStatus,
    pub env_vars: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub enum ServiceStatus {
    Provisioned,
    NeedsProvision,
    Unknown,
}

#[derive(Debug)]
pub enum ServiceError {
    InvalidUri(String),
    ParseError(String),
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServiceError::InvalidUri(u) => write!(f, "Invalid service URI: {}", u),
            ServiceError::ParseError(e) => write!(f, "Parse error: {}", e),
        }
    }
}

/// Parse osp:// URI: osp://provider.com/service@tier
pub fn parse_service_uri(uri: &str) -> Result<ServiceSpec, ServiceError> {
    if !uri.starts_with("osp://") {
        return Err(ServiceError::InvalidUri(uri.to_string()));
    }
    let rest = &uri[6..];

    let (provider_service, tier) = if let Some(at) = rest.find('@') {
        (&rest[..at], rest[at+1..].to_string())
    } else {
        (rest, "free".to_string())
    };

    let slash = provider_service.find('/').ok_or_else(|| ServiceError::InvalidUri(uri.to_string()))?;
    let provider = provider_service[..slash].to_string();
    let service = provider_service[slash+1..].to_string();

    Ok(ServiceSpec { provider, service, tier })
}

/// Load service dependencies from package.json
pub fn load_service_dependencies(project_root: &Path) -> Result<ServiceDependencies, ServiceError> {
    let pkg_path = project_root.join("package.json");
    let content = std::fs::read_to_string(&pkg_path)
        .map_err(|e| ServiceError::ParseError(e.to_string()))?;
    let pkg: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| ServiceError::ParseError(e.to_string()))?;

    let services = pkg.get("better")
        .and_then(|b| b.get("services"))
        .and_then(|s| s.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    Ok(ServiceDependencies { services })
}

/// Resolve and check status of service dependencies
pub fn resolve_services(deps: &ServiceDependencies, vault_dir: &Path) -> Vec<ResolvedService> {
    deps.services.iter().map(|(alias, uri)| {
        let spec = parse_service_uri(uri).unwrap_or(ServiceSpec {
            provider: "unknown".to_string(),
            service: "unknown".to_string(),
            tier: "free".to_string(),
        });

        // Check vault for existing provisioned service
        let vault_file = vault_dir.join(format!("{}.json", alias));
        let (status, env_vars) = if vault_file.exists() {
            let content = std::fs::read_to_string(&vault_file).unwrap_or_default();
            let data: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
            let env: HashMap<String, String> = data.get("env")
                .and_then(|e| e.as_object())
                .map(|obj| obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect())
                .unwrap_or_default();
            (ServiceStatus::Provisioned, env)
        } else {
            (ServiceStatus::NeedsProvision, HashMap::new())
        };

        ResolvedService {
            alias: alias.clone(),
            provider: spec.provider,
            service: spec.service,
            tier: spec.tier,
            status,
            env_vars,
        }
    }).collect()
}

/// Check if all service dependencies are provisioned
pub fn check_services_ready(project_root: &Path) -> Result<Vec<ResolvedService>, ServiceError> {
    let deps = load_service_dependencies(project_root)?;
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let vault_dir = std::path::PathBuf::from(home).join(".better").join("vault");
    Ok(resolve_services(&deps, &vault_dir))
}
