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
}
