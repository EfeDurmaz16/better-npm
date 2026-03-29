use super::discovery::OspError;
use super::vault::{Vault, VaultEntry, ServiceStatus};

/// List all provisioned services from the vault.
pub fn list_services(vault: &Vault) -> Vec<&VaultEntry> {
    vault.list_entries()
}

/// Get the status of a specific service.
pub fn service_status<'a>(
    vault: &'a Vault,
    provider: &str,
    offering: &str,
) -> Result<&'a VaultEntry, OspError> {
    vault
        .get_entry(provider, offering)
        .ok_or_else(|| OspError::ResourceNotFound(
            format!("No service found for {}/{}", provider, offering)
        ))
}

/// Check health of a provisioned service by hitting its health endpoint.
pub fn check_service_health(
    entry: &VaultEntry,
    manifest: &super::manifest::ServiceManifest,
) -> Result<bool, OspError> {
    let url = format!(
        "https://{}{}?resource_id={}",
        manifest.provider_id,
        manifest.endpoints.health,
        entry.resource_id
    );

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| OspError::Network(e.to_string()))?;

    let resp = client
        .get(&url)
        .header("User-Agent", "better-npm/osp-client")
        .send()
        .map_err(|e| OspError::Network(e.to_string()))?;

    Ok(resp.status().is_success())
}

/// Update service status in vault.
pub fn update_service_status(
    vault: &mut Vault,
    provider: &str,
    offering: &str,
    new_status: ServiceStatus,
) -> Result<(), OspError> {
    let entry = vault
        .get_entry(provider, offering)
        .ok_or_else(|| OspError::ResourceNotFound(
            format!("No service found for {}/{}", provider, offering)
        ))?
        .clone();

    let mut updated = entry;
    updated.status = new_status;
    vault.update_entry(updated)
}
