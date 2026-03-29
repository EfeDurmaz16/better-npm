use super::discovery::OspError;
use super::manifest::ServiceManifest;
use super::vault::Vault;

/// Deprovision a service and remove it from the vault.
pub fn deprovision(
    vault: &mut Vault,
    manifest: &ServiceManifest,
    provider: &str,
    offering: &str,
) -> Result<(), OspError> {
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

    let resp = client.post(&url)
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/osp-client")
        .send()
        .map_err(|e| OspError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    if status != 200 && status != 202 && status != 204 {
        return Err(OspError::HttpError(status));
    }

    vault.remove_entry(provider, &entry.offering_id)?;
    Ok(())
}
