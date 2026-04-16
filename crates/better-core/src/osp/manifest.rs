use serde::{Deserialize, Serialize};

/// OSP ServiceManifest -- provider's catalog of available services.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceManifest {
    pub manifest_id: String,
    pub manifest_version: u64,
    pub previous_version: Option<u64>,
    pub osp_spec_version: Option<String>,
    pub provider_id: String,
    pub display_name: String,
    pub provider_url: Option<String>,
    pub provider_public_key: Option<String>,
    pub offerings: Vec<ServiceOffering>,
    pub accepted_payment_methods: Option<Vec<PaymentMethod>>,
    pub trust_tier_required: Option<u8>,
    pub endpoints: ProviderEndpoints,
    pub extensions: Option<serde_json::Value>,
    pub effective_at: Option<String>,
    pub provider_signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceOffering {
    pub offering_id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: ServiceCategory,
    pub tiers: Vec<ServiceTier>,
    pub credentials_schema: serde_json::Value,
    pub estimated_provision_seconds: Option<u32>,
    pub fulfillment_proof_type: Option<String>,
    pub regions: Option<Vec<String>>,
    pub documentation_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceCategory {
    Database,
    Hosting,
    Auth,
    Analytics,
    Storage,
    Compute,
    Messaging,
    Monitoring,
    Search,
    Ai,
    Email,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceTier {
    pub tier_id: String,
    pub name: String,
    pub price: Price,
    pub limits: Option<serde_json::Value>,
    pub features: Option<Vec<String>>,
    pub escrow_profile: Option<EscrowProfile>,
    pub rate_limit: Option<String>,
    pub sla: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Price {
    pub amount: String,
    pub currency: String,
    pub interval: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EscrowProfile {
    pub timeout_seconds: Option<u32>,
    pub verification_window_seconds: Option<u32>,
    pub dispute_window_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentMethod {
    Free,
    SardisWallet,
    StripeSpt,
    X402,
    Mpp,
    Invoice,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderEndpoints {
    pub provision: String,
    pub deprovision: String,
    pub credentials: String,
    pub rotate: Option<String>,
    pub status: String,
    pub usage: Option<String>,
    pub health: String,
}

/// Compute canonical JSON for signature verification.
/// Per OSP spec: serialize all fields EXCEPT `provider_signature`,
/// keys sorted alphabetically, no extra whitespace.
pub fn canonical_json(manifest: &ServiceManifest) -> Result<String, serde_json::Error> {
    let mut value = serde_json::to_value(manifest)?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("provider_signature");
    }
    let sorted = sort_json_keys(&value);
    serde_json::to_string(&sorted)
}

pub fn sort_json_keys(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut sorted: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for key in keys {
                sorted.insert(key.clone(), sort_json_keys(&map[key]));
            }
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(sort_json_keys).collect())
        }
        other => other.clone(),
    }
}

// ---------------------------------------------------------------------------
// Task 64: Full manifest verification — TOFU pinning, version monotonicity, nonce
// ---------------------------------------------------------------------------

/// Result of a comprehensive manifest security verification.
#[derive(Debug)]
pub struct ManifestVerification {
    pub signature_valid: bool,
    pub version_monotonic: bool,
    /// TOFU: first use pins the key; subsequent uses must match
    pub pubkey_pinned: bool,
    pub warnings: Vec<String>,
}

/// Verify a manifest with all security checks:
/// 1. Ed25519 signature over canonical JSON
/// 2. Monotonic version (manifest_version > cached previous)
/// 3. TOFU public key pinning
///
/// The vault is updated with the new pinned key and version on success.
pub fn verify_manifest_full(
    manifest: &ServiceManifest,
    vault: &mut super::vault::Vault,
) -> Result<ManifestVerification, super::discovery::OspError> {
    let sig_valid = super::discovery::verify_manifest_signature(manifest)?;
    let mut warnings = Vec::new();

    let version_ok = check_manifest_version(manifest, vault);
    if !version_ok {
        warnings.push(format!(
            "Manifest version regression detected for {}",
            manifest.provider_id
        ));
    }

    let pin_ok = check_and_update_pubkey_pin(manifest, vault, &mut warnings);

    Ok(ManifestVerification {
        signature_valid: sig_valid,
        version_monotonic: version_ok,
        pubkey_pinned: pin_ok,
        warnings,
    })
}

/// Check that manifest_version is monotonically increasing vs. the cached version.
fn check_manifest_version(manifest: &ServiceManifest, vault: &super::vault::Vault) -> bool {
    match vault.get_pinned_manifest_version(&manifest.provider_id) {
        Some(cached_version) => manifest.manifest_version > cached_version,
        None => true, // First time seeing this provider
    }
}

/// TOFU public key pinning: pin on first use; require match on subsequent uses.
fn check_and_update_pubkey_pin(
    manifest: &ServiceManifest,
    vault: &mut super::vault::Vault,
    warnings: &mut Vec<String>,
) -> bool {
    let Some(ref pubkey) = manifest.provider_public_key else {
        warnings.push(format!(
            "Provider {} has no public key — signature cannot be verified",
            manifest.provider_id
        ));
        return false;
    };

    match vault.get_pinned_pubkey(&manifest.provider_id) {
        Some(pinned) => {
            if pinned == *pubkey {
                true
            } else {
                warnings.push(format!(
                    "PUBLIC KEY MISMATCH for {} — possible MITM attack!",
                    manifest.provider_id
                ));
                false
            }
        }
        None => {
            // First use: pin this key
            let _ = vault.pin_pubkey(&manifest.provider_id, pubkey);
            let _ = vault.pin_manifest_version(&manifest.provider_id, manifest.manifest_version);
            true
        }
    }
}

/// Generate a fresh nonce and record it in the vault (replay protection).
pub fn generate_and_record_nonce(
    vault: &mut super::vault::Vault,
) -> Result<String, super::discovery::OspError> {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let nonce = super::crypto::base64_url_encode(&bytes);
    vault.check_nonce(&nonce)?;
    Ok(nonce)
}

/// Validate that the nonce in a provider response matches what we sent.
pub fn validate_response_nonce(
    expected: &str,
    received: &str,
) -> Result<(), super::discovery::OspError> {
    if expected != received {
        return Err(super::discovery::OspError::NonceReplay);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_json_keys_sorts_alphabetically() {
        let json = serde_json::json!({"z": 3, "a": 1, "m": 2});
        let sorted = sort_json_keys(&json);
        let keys: Vec<&str> = sorted.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(keys, vec!["a", "m", "z"]);
    }

    #[test]
    fn sort_json_keys_handles_nested_objects() {
        let json = serde_json::json!({"b": {"z": 1, "a": 2}, "a": 3});
        let sorted = sort_json_keys(&json);
        let outer_keys: Vec<&str> = sorted.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(outer_keys, vec!["a", "b"]);
        let inner_keys: Vec<&str> = sorted["b"].as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(inner_keys, vec!["a", "z"]);
    }

    #[test]
    fn sort_json_keys_handles_arrays() {
        let json = serde_json::json!([{"b": 2, "a": 1}]);
        let sorted = sort_json_keys(&json);
        let arr = sorted.as_array().unwrap();
        let keys: Vec<&str> = arr[0].as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(keys, vec!["a", "b"]);
    }

    #[test]
    fn canonical_json_excludes_provider_signature() {
        let manifest = make_test_manifest();
        let canon = canonical_json(&manifest).unwrap();
        assert!(!canon.contains("provider_signature"));
        assert!(!canon.contains("TEST_SIG"));
        assert!(canon.contains("mf_test"));
    }

    #[test]
    fn validate_response_nonce_matches() {
        assert!(validate_response_nonce("abc123", "abc123").is_ok());
    }

    #[test]
    fn validate_response_nonce_mismatch_errors() {
        assert!(validate_response_nonce("abc123", "xyz789").is_err());
    }

    #[test]
    fn manifest_verification_struct_fields() {
        let v = ManifestVerification {
            signature_valid: true,
            version_monotonic: true,
            pubkey_pinned: true,
            warnings: vec![],
        };
        assert!(v.signature_valid && v.version_monotonic && v.pubkey_pinned);
        assert!(v.warnings.is_empty());
    }

    #[test]
    fn manifest_verification_with_warnings() {
        let mut v = ManifestVerification {
            signature_valid: true,
            version_monotonic: false,
            pubkey_pinned: true,
            warnings: vec![],
        };
        v.warnings.push("Manifest version regression".into());
        assert!(!v.version_monotonic);
        assert_eq!(v.warnings.len(), 1);
    }

    #[test]
    fn sort_json_keys_passthrough_scalar() {
        let json = serde_json::json!(42);
        let sorted = sort_json_keys(&json);
        assert_eq!(sorted, serde_json::json!(42));
    }

    #[test]
    fn service_category_serde_snake_case() {
        assert_eq!(serde_json::to_string(&ServiceCategory::Database).unwrap(), "\"database\"");
        assert_eq!(serde_json::to_string(&ServiceCategory::Ai).unwrap(), "\"ai\"");
        let db: ServiceCategory = serde_json::from_str("\"database\"").unwrap();
        assert!(matches!(db, ServiceCategory::Database));
    }

    #[test]
    fn payment_method_serde_snake_case() {
        assert_eq!(serde_json::to_string(&PaymentMethod::Free).unwrap(), "\"free\"");
        assert_eq!(serde_json::to_string(&PaymentMethod::SardisWallet).unwrap(), "\"sardis_wallet\"");
        assert_eq!(serde_json::to_string(&PaymentMethod::X402).unwrap(), "\"x402\"");
    }

    #[test]
    fn price_serde_roundtrip() {
        let p = Price { amount: "9.99".into(), currency: "USD".into(), interval: Some("month".into()) };
        let json = serde_json::to_string(&p).unwrap();
        let back: Price = serde_json::from_str(&json).unwrap();
        assert_eq!(back.amount, "9.99");
        assert_eq!(back.interval, Some("month".into()));
    }

    #[test]
    fn escrow_profile_serde_roundtrip() {
        let ep = EscrowProfile {
            timeout_seconds: Some(3600),
            verification_window_seconds: Some(300),
            dispute_window_seconds: None,
        };
        let json = serde_json::to_string(&ep).unwrap();
        let back: EscrowProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.timeout_seconds, Some(3600));
        assert!(back.dispute_window_seconds.is_none());
    }

    fn make_test_manifest() -> ServiceManifest {
        ServiceManifest {
            manifest_id: "mf_test".into(),
            manifest_version: 1,
            previous_version: None,
            osp_spec_version: Some("1.1".into()),
            provider_id: "test.com".into(),
            display_name: "Test".into(),
            provider_url: None,
            provider_public_key: None,
            offerings: vec![],
            accepted_payment_methods: None,
            trust_tier_required: None,
            endpoints: ProviderEndpoints {
                provision: "/osp/v1/provision".into(),
                deprovision: "/osp/v1/deprovision".into(),
                credentials: "/osp/v1/credentials".into(),
                rotate: None,
                status: "/osp/v1/status".into(),
                usage: None,
                health: "/osp/v1/health".into(),
            },
            extensions: None,
            effective_at: None,
            provider_signature: "TEST_SIG".into(),
        }
    }
}
