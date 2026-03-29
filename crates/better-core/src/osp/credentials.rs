use serde::{Deserialize, Serialize};

use super::crypto;
use super::discovery::OspError;

/// CredentialBundle -- encrypted credentials from a provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialBundle {
    pub bundle_id: Option<String>,
    pub resource_id: Option<String>,
    pub offering_id: Option<String>,
    pub encrypted_payload: Option<String>,
    pub encryption_method: Option<String>,
    pub ephemeral_public_key: Option<String>,
    pub nonce: Option<String>,
    pub provider_signature: Option<String>,
    pub agent_public_key_fingerprint: Option<String>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub rotation_available_at: Option<String>,
    pub credential_type: Option<String>,
    pub version: Option<u32>,
    pub previous_bundle_id: Option<String>,
    pub osp_uri: Option<String>,
    pub fields: Option<serde_json::Value>,
}

/// Decrypted credential payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecryptedCredentials {
    pub fields: serde_json::Map<String, serde_json::Value>,
}

/// Decrypt a CredentialBundle using the agent's X25519 secret key.
pub fn decrypt_credential_bundle(
    bundle: &CredentialBundle,
    agent_secret_key: &[u8; 32],
) -> Result<DecryptedCredentials, OspError> {
    let ephemeral_pubkey_b64 = bundle
        .ephemeral_public_key
        .as_ref()
        .ok_or(OspError::DecryptionFailed)?;

    let encrypted_payload = bundle
        .encrypted_payload
        .as_ref()
        .ok_or(OspError::DecryptionFailed)?;

    let nonce_b64 = bundle.nonce.as_ref().ok_or(OspError::DecryptionFailed)?;

    // X25519 DH -> shared secret
    let shared_secret = crypto::x25519_diffie_hellman(agent_secret_key, ephemeral_pubkey_b64)?;

    // Decrypt with AES-256-GCM
    let ciphertext = crypto::base64_url_decode(encrypted_payload)?;
    let nonce_bytes = crypto::base64_url_decode(nonce_b64)?;

    let plaintext =
        crypto::aes_256_gcm_decrypt_with_key_and_nonce(&shared_secret, &nonce_bytes, &ciphertext)?;

    let fields: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&plaintext).map_err(|e| OspError::ParseError(e.to_string()))?;

    Ok(DecryptedCredentials { fields })
}

/// Parse an osp:// URI into (provider, offering_suffix, field_name).
pub fn parse_osp_uri(uri: &str) -> Result<(String, String, String), OspError> {
    let stripped = uri
        .strip_prefix("osp://")
        .ok_or_else(|| OspError::ParseError(format!("Invalid osp:// URI: {}", uri)))?;

    let parts: Vec<&str> = stripped.splitn(3, '/').collect();
    if parts.len() != 3 {
        return Err(OspError::ParseError(format!(
            "osp:// URI must have format osp://provider/offering/field, got: {}",
            uri
        )));
    }

    Ok((
        parts[0].to_string(),
        parts[1].to_string(),
        parts[2].to_string(),
    ))
}

/// Resolve an osp:// URI to a credential field value from the vault.
pub fn resolve_osp_uri(
    uri: &str,
    vault: &super::vault::Vault,
    _agent_secret_key: &[u8; 32],
) -> Result<String, OspError> {
    let (provider, offering, field) = parse_osp_uri(uri)?;

    let entry = vault.get_entry(&provider, &offering).ok_or_else(|| {
        OspError::ResourceNotFound(format!(
            "No credentials for {}/{}. Run: better provision {}/{}",
            provider, offering, provider, offering
        ))
    })?;

    if let Some(ref fields) = entry.credential_bundle.fields {
        if let Some(value) = fields.get(&field) {
            if let Some(s) = value.as_str() {
                return Ok(s.to_string());
            }
            return Ok(value.to_string());
        }
    }

    Err(OspError::ResourceNotFound(format!(
        "Field '{}' not found in credentials for {}/{}",
        field, provider, offering
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_osp_uri_valid() {
        let (provider, offering, field) =
            parse_osp_uri("osp://supabase.com/postgres/connection_string").unwrap();
        assert_eq!(provider, "supabase.com");
        assert_eq!(offering, "postgres");
        assert_eq!(field, "connection_string");
    }

    #[test]
    fn test_parse_osp_uri_invalid_prefix() {
        assert!(parse_osp_uri("https://supabase.com/postgres/url").is_err());
    }

    #[test]
    fn test_parse_osp_uri_missing_field() {
        assert!(parse_osp_uri("osp://supabase.com/postgres").is_err());
    }
}
