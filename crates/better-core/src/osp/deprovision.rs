use super::discovery::OspError;
use super::manifest::ServiceManifest;
use super::vault::Vault;

/// Result of deprovisioning a service.
#[derive(Debug)]
pub struct DeprovisionResult {
    pub resource_id: String,
    pub provider_id: String,
    pub offering_id: String,
    /// Lines in .env.osp that reference this service (warnings for the user)
    pub env_warnings: Vec<String>,
    pub vault_cleaned: bool,
}

/// Deprovision a service and remove it from the vault.
///
/// Flow:
/// 1. Fetch manifest to get deprovision endpoint
/// 2. DELETE /osp/v1/deprovision/{resource_id}
/// 3. Remove vault entry
/// 4. Scan .env.osp for osp:// URIs matching this provider/offering -> warn
/// 5. If `force`, remove those lines from .env.osp
pub fn deprovision(
    vault: &mut Vault,
    manifest: &ServiceManifest,
    provider: &str,
    offering: &str,
    project_root: Option<&std::path::Path>,
    force: bool,
) -> Result<DeprovisionResult, OspError> {
    let entry = vault.get_entry(provider, offering)
        .ok_or_else(|| OspError::ResourceNotFound(
            format!("No service found for {}/{}", provider, offering)
        ))?
        .clone();

    let url = format!(
        "https://{}{}?resource_id={}",
        manifest.provider_id,
        manifest.endpoints.deprovision,
        entry.resource_id
    );

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| OspError::Network(e.to_string()))?;

    let resp = client.delete(&url)
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/osp-client")
        .send()
        .map_err(|e| OspError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    if status != 200 && status != 202 && status != 204 {
        return Err(OspError::HttpError(status));
    }

    let resource_id = entry.resource_id.clone();
    let offering_id = entry.offering_id.clone();
    vault.remove_entry(provider, &offering_id)?;

    // Scan for .env.osp references
    let env_warnings = if let Some(root) = project_root {
        let warnings = find_env_references(root, provider, offering);
        if force && !warnings.is_empty() {
            let _ = remove_env_references(root, provider, offering);
        }
        warnings
    } else {
        vec![]
    };

    Ok(DeprovisionResult {
        resource_id,
        provider_id: provider.to_string(),
        offering_id,
        env_warnings,
        vault_cleaned: true,
    })
}

/// Scan .env.osp for osp:// URIs that reference a given provider/offering.
pub fn find_env_references(
    project_root: &std::path::Path,
    provider_id: &str,
    offering_suffix: &str,
) -> Vec<String> {
    let template_path = project_root.join(".env.osp");
    if !template_path.exists() {
        return vec![];
    }
    let content = std::fs::read_to_string(&template_path).unwrap_or_default();
    content
        .lines()
        .filter(|line| {
            line.contains(&format!("osp://{}/{}", provider_id, offering_suffix))
        })
        .map(|l| l.to_string())
        .collect()
}

/// Remove lines referencing a provider/offering from .env.osp.
fn remove_env_references(
    project_root: &std::path::Path,
    provider_id: &str,
    offering_suffix: &str,
) -> Result<(), std::io::Error> {
    let template_path = project_root.join(".env.osp");
    if !template_path.exists() {
        return Ok(());
    }
    let content = std::fs::read_to_string(&template_path)?;
    let pattern = format!("osp://{}/{}", provider_id, offering_suffix);
    let filtered: Vec<&str> = content
        .lines()
        .filter(|line| !line.contains(&pattern))
        .collect();
    std::fs::write(&template_path, filtered.join("\n"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_env_references_returns_matching_lines() {
        let dir = tempfile::tempdir().unwrap();
        let env_osp = dir.path().join(".env.osp");
        std::fs::write(&env_osp,
            "DATABASE_URL=osp://supabase.com/postgres/DATABASE_URL\n\
             REDIS_URL=osp://upstash.com/redis/REDIS_URL\n\
             API_KEY=osp://supabase.com/postgres/API_KEY\n"
        ).unwrap();

        let refs = find_env_references(dir.path(), "supabase.com", "postgres");
        assert_eq!(refs.len(), 2);
        assert!(refs[0].contains("DATABASE_URL"));
        assert!(refs[1].contains("API_KEY"));
    }

    #[test]
    fn find_env_references_empty_when_no_match() {
        let dir = tempfile::tempdir().unwrap();
        let env_osp = dir.path().join(".env.osp");
        std::fs::write(&env_osp, "DATABASE_URL=osp://neon.tech/postgres/DATABASE_URL\n").unwrap();

        let refs = find_env_references(dir.path(), "supabase.com", "postgres");
        assert!(refs.is_empty());
    }

    #[test]
    fn find_env_references_returns_empty_when_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let refs = find_env_references(dir.path(), "supabase.com", "postgres");
        assert!(refs.is_empty());
    }

    #[test]
    fn remove_env_references_removes_matching_lines() {
        let dir = tempfile::tempdir().unwrap();
        let env_osp = dir.path().join(".env.osp");
        std::fs::write(&env_osp,
            "DATABASE_URL=osp://supabase.com/postgres/DATABASE_URL\n\
             REDIS_URL=osp://upstash.com/redis/REDIS_URL\n"
        ).unwrap();

        remove_env_references(dir.path(), "supabase.com", "postgres").unwrap();

        let content = std::fs::read_to_string(&env_osp).unwrap();
        assert!(!content.contains("supabase.com/postgres"));
        assert!(content.contains("upstash.com/redis"));
    }

    #[test]
    fn deprovision_result_has_correct_fields() {
        let result = DeprovisionResult {
            resource_id: "res_123".into(),
            provider_id: "supabase.com".into(),
            offering_id: "supabase.com/postgres".into(),
            env_warnings: vec!["DATABASE_URL=osp://supabase.com/postgres/DATABASE_URL".into()],
            vault_cleaned: true,
        };
        assert_eq!(result.resource_id, "res_123");
        assert_eq!(result.env_warnings.len(), 1);
        assert!(result.vault_cleaned);
    }
}
