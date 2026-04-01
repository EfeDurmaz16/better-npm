use std::collections::HashMap;
use std::sync::Mutex;

use super::crypto;
use super::manifest::ServiceManifest;

static MANIFEST_CACHE: std::sync::LazyLock<Mutex<HashMap<String, ServiceManifest>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Fetch a ServiceManifest from `https://{domain}/.well-known/osp.json`.
/// Verifies the Ed25519 signature and caches in memory.
pub fn discover(domain: &str) -> Result<ServiceManifest, OspError> {
    if let Ok(cache) = MANIFEST_CACHE.lock() {
        if let Some(cached) = cache.get(domain) {
            return Ok(cached.clone());
        }
    }

    let manifest = fetch_manifest(domain)?;
    verify_manifest_signature(&manifest)?;

    if let Ok(mut cache) = MANIFEST_CACHE.lock() {
        cache.insert(domain.to_string(), manifest.clone());
    }

    Ok(manifest)
}

/// Fetch ServiceManifest from a provider's well-known endpoint.
pub fn fetch_manifest(provider_domain: &str) -> Result<ServiceManifest, OspError> {
    let url = format!("https://{}/.well-known/osp.json", provider_domain);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| OspError::Network(e.to_string()))?;

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .header("User-Agent", "better-npm/osp-client")
        .send()
        .map_err(|e| OspError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    if status != 200 {
        return Err(OspError::HttpError(status));
    }

    let body = resp.text().map_err(|e| OspError::Network(e.to_string()))?;
    let manifest: ServiceManifest =
        serde_json::from_str(&body).map_err(|e| OspError::ParseError(e.to_string()))?;

    Ok(manifest)
}

/// Verify the Ed25519 signature on a ServiceManifest.
pub fn verify_manifest_signature(manifest: &ServiceManifest) -> Result<bool, OspError> {
    let pubkey_b64 = manifest
        .provider_public_key
        .as_ref()
        .ok_or(OspError::MissingPublicKey)?;

    let canonical = super::manifest::canonical_json(manifest)
        .map_err(|e| OspError::SerializationError(e.to_string()))?;

    crypto::verify_ed25519(pubkey_b64, canonical.as_bytes(), &manifest.provider_signature)
}

/// Search offerings by category within a manifest.
pub fn search_offerings<'a>(
    manifest: &'a ServiceManifest,
    category: Option<&str>,
) -> Vec<&'a super::manifest::ServiceOffering> {
    manifest
        .offerings
        .iter()
        .filter(|o| {
            if let Some(cat) = category {
                let cat_str = serde_json::to_string(&o.category).unwrap_or_default();
                let cat_str = cat_str.trim_matches('"');
                cat_str == cat
            } else {
                true
            }
        })
        .collect()
}

/// Find a specific offering by ID in a manifest.
pub fn find_offering<'a>(
    manifest: &'a ServiceManifest,
    offering_id: &str,
) -> Result<&'a super::manifest::ServiceOffering, OspError> {
    manifest
        .offerings
        .iter()
        .find(|o| o.offering_id == offering_id)
        .ok_or_else(|| OspError::OfferingNotFound(offering_id.to_string()))
}

/// Find a specific tier within an offering.
pub fn find_tier<'a>(
    offering: &'a super::manifest::ServiceOffering,
    tier_id: &str,
) -> Result<&'a super::manifest::ServiceTier, OspError> {
    offering
        .tiers
        .iter()
        .find(|t| t.tier_id == tier_id)
        .ok_or_else(|| OspError::TierNotFound(tier_id.to_string()))
}

/// Clear the in-memory manifest cache.
pub fn clear_cache() {
    if let Ok(mut cache) = MANIFEST_CACHE.lock() {
        cache.clear();
    }
}

#[derive(Debug)]
pub enum OspError {
    HttpError(u16),
    MissingPublicKey,
    InvalidPublicKey,
    InvalidSignature,
    SignatureVerificationFailed,
    Base64Error(String),
    SerializationError(String),
    Network(String),
    ParseError(String),
    NoOfferings(String),
    OfferingNotFound(String),
    TierNotFound(String),
    NonceReplay,
    VaultError(String),
    DecryptionFailed,
    ResourceNotFound(String),
    ProvisionFailed { code: String, message: String },
    AsyncTimeout(u64),
}

impl std::fmt::Display for OspError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HttpError(code) => write!(f, "Provider returned non-200: {}", code),
            Self::MissingPublicKey => write!(f, "Provider manifest missing provider_public_key"),
            Self::InvalidPublicKey => write!(f, "Invalid Ed25519 public key"),
            Self::InvalidSignature => write!(f, "Invalid Ed25519 signature format"),
            Self::SignatureVerificationFailed => {
                write!(f, "Manifest signature verification FAILED")
            }
            Self::Base64Error(e) => write!(f, "Base64 decode error: {}", e),
            Self::SerializationError(e) => write!(f, "Serialization error: {}", e),
            Self::Network(e) => write!(f, "Network error: {}", e),
            Self::ParseError(e) => write!(f, "Manifest parse error: {}", e),
            Self::NoOfferings(c) => write!(f, "No offerings found for category: {}", c),
            Self::OfferingNotFound(o) => write!(f, "Offering not found: {}", o),
            Self::TierNotFound(t) => write!(f, "Tier not found: {}", t),
            Self::NonceReplay => write!(f, "Nonce replay detected"),
            Self::VaultError(e) => write!(f, "Vault error: {}", e),
            Self::DecryptionFailed => write!(f, "Credential decryption failed"),
            Self::ResourceNotFound(r) => write!(f, "Resource not found: {}", r),
            Self::ProvisionFailed { code, message } => {
                write!(f, "Provisioning failed: {} -- {}", code, message)
            }
            Self::AsyncTimeout(s) => write!(f, "Async provisioning timed out after {}s", s),
        }
    }
}

impl std::error::Error for OspError {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::manifest::{ProviderEndpoints, ServiceManifest};

    fn make_test_manifest() -> ServiceManifest {
        ServiceManifest {
            manifest_id: "test".to_string(),
            manifest_version: 1,
            previous_version: None,
            osp_spec_version: None,
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
    fn search_offerings_empty_manifest_returns_empty() {
        let manifest = make_test_manifest();
        let results = search_offerings(&manifest, None);
        assert!(results.is_empty());
    }

    #[test]
    fn find_offering_not_found_returns_err() {
        let manifest = make_test_manifest();
        let result = find_offering(&manifest, "nonexistent-offering");
        assert!(result.is_err());
        if let Err(OspError::OfferingNotFound(id)) = result {
            assert_eq!(id, "nonexistent-offering");
        }
    }

    #[test]
    fn clear_cache_does_not_panic() {
        clear_cache();
    }

    #[test]
    fn osp_error_display_nonce_replay() {
        let err = OspError::NonceReplay;
        assert!(err.to_string().contains("replay"));
    }
}
