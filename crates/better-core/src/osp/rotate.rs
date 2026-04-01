use super::discovery::OspError;
use super::manifest::{ServiceManifest, ProviderEndpoints};
use super::vault::{Vault, ServiceStatus};

/// Rotate credentials for a provisioned service.
pub fn rotate_credentials(
    vault: &mut Vault,
    manifest: &ServiceManifest,
    provider: &str,
    offering: &str,
) -> Result<(), OspError> {
    let rotate_endpoint = manifest.endpoints.rotate.as_ref()
        .ok_or_else(|| OspError::VaultError(
            format!("Provider {} does not support credential rotation", provider)
        ))?;

    let entry = vault.get_entry(provider, offering)
        .ok_or_else(|| OspError::ResourceNotFound(
            format!("No service found for {}/{}", provider, offering)
        ))?
        .clone();

    let url = format!(
        "https://{}{}?resource_id={}",
        manifest.provider_id, rotate_endpoint, entry.resource_id
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
    if status != 200 && status != 201 {
        return Err(OspError::HttpError(status));
    }

    let body = resp.text().map_err(|e| OspError::Network(e.to_string()))?;
    let new_bundle: super::credentials::CredentialBundle = serde_json::from_str(&body)
        .map_err(|e| OspError::ParseError(e.to_string()))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();

    let mut updated = entry;
    updated.credential_bundle = new_bundle;
    updated.last_rotated_at = Some(now);
    updated.status = ServiceStatus::Active;

    vault.update_entry(updated)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_manifest_no_rotate() -> ServiceManifest {
        ServiceManifest {
            manifest_id: "test-manifest".to_string(),
            manifest_version: 1,
            previous_version: None,
            osp_spec_version: Some("1.0".to_string()),
            provider_id: "test.provider.com".to_string(),
            display_name: "Test Provider".to_string(),
            provider_url: None,
            provider_public_key: None,
            offerings: vec![],
            accepted_payment_methods: None,
            trust_tier_required: None,
            endpoints: ProviderEndpoints {
                provision: "/provision".to_string(),
                deprovision: "/deprovision".to_string(),
                credentials: "/credentials".to_string(),
                rotate: None,
                status: "/status".to_string(),
                usage: None,
                health: "/health".to_string(),
            },
            extensions: None,
            effective_at: None,
            provider_signature: "sig".to_string(),
        }
    }

    #[test]
    fn rotate_no_rotate_endpoint_returns_vault_error() {
        let mut vault = Vault::open().unwrap();
        let manifest = make_manifest_no_rotate();
        let result = rotate_credentials(&mut vault, &manifest, "test.provider.com", "postgres");
        assert!(result.is_err());
        if let Err(OspError::VaultError(msg)) = result {
            assert!(msg.contains("does not support credential rotation"));
        } else {
            panic!("Expected VaultError");
        }
    }
}
