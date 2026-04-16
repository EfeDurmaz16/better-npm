use serde::{Deserialize, Serialize};

use super::crypto;
use super::discovery::OspError;
use super::manifest::{ServiceManifest, ServiceOffering, ServiceTier};

/// ProvisionRequest per OSP spec.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvisionRequest {
    pub offering_id: String,
    pub tier_id: String,
    pub project_name: String,
    pub region: Option<String>,
    pub payment_method: Option<String>,
    pub payment_proof: Option<String>,
    pub agent_public_key: String,
    pub nonce: String,
    pub config: Option<serde_json::Value>,
    pub webhook_url: Option<String>,
    pub idempotency_key: Option<String>,
}

/// ProvisionResponse per OSP spec.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvisionResponse {
    pub request_id: String,
    pub offering_id: String,
    pub tier_id: String,
    pub status: ProvisionStatus,
    pub resource_id: Option<String>,
    pub credentials: Option<super::credentials::CredentialBundle>,
    pub fulfillment_proof: Option<FulfillmentProof>,
    pub status_url: Option<String>,
    pub estimated_ready_seconds: Option<u32>,
    pub region: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub dashboard_url: Option<String>,
    pub error: Option<ProvisionError>,
    pub cost_estimate: Option<CostEstimate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProvisionStatus {
    Provisioning,
    Active,
    Failed,
    PendingPayment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvisionError {
    pub code: String,
    pub message: String,
    pub retry_after_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FulfillmentProof {
    pub r#type: String,
    pub health_check_url: Option<String>,
    pub receipt_signature: Option<String>,
    pub receipt_payload: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostEstimate {
    pub monthly_estimate: Option<String>,
    pub currency: Option<String>,
    pub breakdown: Option<Vec<CostBreakdownItem>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostBreakdownItem {
    pub dimension: String,
    pub estimated_usage: String,
    pub unit_price: String,
    pub estimated_cost: String,
}

// ──────────────────────────────────────────────
// ProvisionRequest builder
// ──────────────────────────────────────────────

pub struct ProvisionRequestBuilder {
    offering: ServiceOffering,
    tier: ServiceTier,
    project_name: String,
    region: Option<String>,
    payment_method: Option<String>,
    payment_proof: Option<String>,
    agent_public_key: String,
    config: Option<serde_json::Value>,
    webhook_url: Option<String>,
}

impl ProvisionRequestBuilder {
    pub fn new(
        offering: ServiceOffering,
        tier: ServiceTier,
        project_name: String,
        agent_public_key: String,
    ) -> Self {
        Self {
            offering,
            tier,
            project_name,
            region: None,
            payment_method: None,
            payment_proof: None,
            agent_public_key,
            config: None,
            webhook_url: None,
        }
    }

    pub fn region(mut self, region: impl Into<String>) -> Self {
        self.region = Some(region.into());
        self
    }

    pub fn payment(mut self, method: impl Into<String>, proof: impl Into<String>) -> Self {
        self.payment_method = Some(method.into());
        self.payment_proof = Some(proof.into());
        self
    }

    pub fn config(mut self, config: serde_json::Value) -> Self {
        self.config = Some(config);
        self
    }

    pub fn webhook(mut self, url: impl Into<String>) -> Self {
        self.webhook_url = Some(url.into());
        self
    }

    pub fn build(self) -> Result<ProvisionRequest, OspError> {
        let nonce = crypto::generate_nonce();
        let idempotency_key = crypto::generate_idempotency_key(
            &self.offering.offering_id,
            &self.tier.tier_id,
            &self.project_name,
        );

        Ok(ProvisionRequest {
            offering_id: self.offering.offering_id,
            tier_id: self.tier.tier_id,
            project_name: self.project_name,
            region: self.region,
            payment_method: self.payment_method,
            payment_proof: self.payment_proof,
            agent_public_key: self.agent_public_key,
            nonce,
            config: self.config,
            webhook_url: self.webhook_url,
            idempotency_key: Some(idempotency_key),
        })
    }
}

// ──────────────────────────────────────────────
// Sync/async provisioning
// ──────────────────────────────────────────────

/// Send a ProvisionRequest to the provider.
/// Handles sync (HTTP 200/201) and async (HTTP 202) flows.
pub fn send_provision_request(
    manifest: &ServiceManifest,
    request: &ProvisionRequest,
) -> Result<ProvisionResponse, OspError> {
    let base_url = manifest
        .provider_url
        .as_deref()
        .unwrap_or(&manifest.provider_id);
    let url = format!("https://{}{}", base_url, manifest.endpoints.provision);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| OspError::Network(e.to_string()))?;

    let body =
        serde_json::to_string(request).map_err(|e| OspError::SerializationError(e.to_string()))?;

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/osp-client")
        .body(body)
        .send()
        .map_err(|e| OspError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    let resp_body = resp.text().map_err(|e| OspError::Network(e.to_string()))?;

    match status {
        200 | 201 => {
            // Sync: credentials should be present
            let response: ProvisionResponse = serde_json::from_str(&resp_body)
                .map_err(|e| OspError::ParseError(e.to_string()))?;
            Ok(response)
        }
        202 => {
            // Async: poll status_url
            let response: ProvisionResponse = serde_json::from_str(&resp_body)
                .map_err(|e| OspError::ParseError(e.to_string()))?;
            if let Some(status_url) = &response.status_url {
                let timeout = response.estimated_ready_seconds.unwrap_or(120) as u64;
                poll_provision_status(status_url, timeout, 3)
            } else {
                Ok(response)
            }
        }
        _ => {
            // Try to parse error from body
            if let Ok(response) = serde_json::from_str::<ProvisionResponse>(&resp_body) {
                if let Some(err) = response.error {
                    return Err(OspError::ProvisionFailed {
                        code: err.code,
                        message: err.message,
                    });
                }
            }
            Err(OspError::HttpError(status))
        }
    }
}

/// Poll an async provisioning status URL until completion or timeout.
pub fn poll_provision_status(
    status_url: &str,
    timeout_seconds: u64,
    poll_interval_seconds: u64,
) -> Result<ProvisionResponse, OspError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| OspError::Network(e.to_string()))?;

    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_seconds);

    loop {
        if start.elapsed() > timeout {
            return Err(OspError::AsyncTimeout(timeout_seconds));
        }

        std::thread::sleep(std::time::Duration::from_secs(poll_interval_seconds));

        let resp = client
            .get(status_url)
            .header("User-Agent", "better-npm/osp-client")
            .send()
            .map_err(|e| OspError::Network(e.to_string()))?;

        let body = resp.text().map_err(|e| OspError::Network(e.to_string()))?;

        let response: ProvisionResponse =
            serde_json::from_str(&body).map_err(|e| OspError::ParseError(e.to_string()))?;

        match response.status {
            ProvisionStatus::Active => return Ok(response),
            ProvisionStatus::Failed => {
                if let Some(err) = response.error {
                    return Err(OspError::ProvisionFailed {
                        code: err.code,
                        message: err.message,
                    });
                }
                return Err(OspError::ProvisionFailed {
                    code: "unknown".into(),
                    message: "Provisioning failed".into(),
                });
            }
            ProvisionStatus::Provisioning | ProvisionStatus::PendingPayment => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::manifest::*;

    #[test]
    fn test_provision_request_builder() {
        let offering = ServiceOffering {
            offering_id: "supabase/postgres".into(),
            name: "Supabase PostgreSQL".into(),
            description: None,
            category: ServiceCategory::Database,
            tiers: vec![],
            credentials_schema: serde_json::json!({}),
            estimated_provision_seconds: Some(30),
            fulfillment_proof_type: None,
            regions: Some(vec!["us-east-1".into()]),
            documentation_url: None,
        };
        let tier = ServiceTier {
            tier_id: "free".into(),
            name: "Free".into(),
            price: Price {
                amount: "0.00".into(),
                currency: "USD".into(),
                interval: None,
            },
            limits: None,
            features: None,
            escrow_profile: None,
            rate_limit: None,
            sla: None,
        };

        let req = ProvisionRequestBuilder::new(
            offering,
            tier,
            "my-project".into(),
            "agent_pubkey_base64url".into(),
        )
        .region("us-east-1")
        .build()
        .unwrap();

        assert_eq!(req.offering_id, "supabase/postgres");
        assert_eq!(req.tier_id, "free");
        assert_eq!(req.project_name, "my-project");
        assert_eq!(req.region.unwrap(), "us-east-1");
        assert!(!req.nonce.is_empty());
        assert!(req.idempotency_key.is_some());
    }

    #[test]
    fn test_provision_status_serde() {
        let json = "\"active\"";
        let status: ProvisionStatus = serde_json::from_str(json).unwrap();
        assert_eq!(status, ProvisionStatus::Active);
    }

    #[test]
    fn test_provision_status_all_variants() {
        let cases = [
            ("\"provisioning\"", ProvisionStatus::Provisioning),
            ("\"active\"", ProvisionStatus::Active),
            ("\"failed\"", ProvisionStatus::Failed),
            ("\"pending_payment\"", ProvisionStatus::PendingPayment),
        ];
        for (json, expected) in &cases {
            let status: ProvisionStatus = serde_json::from_str(json).unwrap();
            assert_eq!(&status, expected);
        }
    }

    #[test]
    fn test_provision_request_builder_with_payment_and_webhook() {
        let offering = ServiceOffering {
            offering_id: "svc/db".into(),
            name: "DB".into(),
            description: None,
            category: ServiceCategory::Database,
            tiers: vec![],
            credentials_schema: serde_json::json!({}),
            estimated_provision_seconds: None,
            fulfillment_proof_type: None,
            regions: None,
            documentation_url: None,
        };
        let tier = ServiceTier {
            tier_id: "pro".into(),
            name: "Pro".into(),
            price: Price { amount: "20.00".into(), currency: "USD".into(), interval: Some("month".into()) },
            limits: None,
            features: None,
            escrow_profile: None,
            rate_limit: None,
            sla: None,
        };
        let req = ProvisionRequestBuilder::new(offering, tier, "proj".into(), "pk".into())
            .payment("sardis_wallet", "proof_abc")
            .webhook("https://example.com/hook")
            .build()
            .unwrap();

        assert_eq!(req.payment_method.as_deref(), Some("sardis_wallet"));
        assert_eq!(req.payment_proof.as_deref(), Some("proof_abc"));
        assert_eq!(req.webhook_url.as_deref(), Some("https://example.com/hook"));
    }

    #[test]
    fn test_fulfillment_proof_serde_roundtrip() {
        let proof = FulfillmentProof {
            r#type: "receipt".into(),
            health_check_url: Some("https://example.com/health".into()),
            receipt_signature: Some("sig123".into()),
            receipt_payload: None,
            timestamp: "2024-01-01T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&proof).unwrap();
        let back: FulfillmentProof = serde_json::from_str(&json).unwrap();
        assert_eq!(back.r#type, "receipt");
        assert!(back.receipt_payload.is_none());
    }

    #[test]
    fn test_provision_request_nonce_is_nonempty() {
        let offering = ServiceOffering {
            offering_id: "o1".into(),
            name: "O".into(),
            description: None,
            category: ServiceCategory::Ai,
            tiers: vec![],
            credentials_schema: serde_json::json!({}),
            estimated_provision_seconds: None,
            fulfillment_proof_type: None,
            regions: None,
            documentation_url: None,
        };
        let tier = ServiceTier {
            tier_id: "t1".into(),
            name: "T".into(),
            price: Price { amount: "0".into(), currency: "USD".into(), interval: None },
            limits: None, features: None, escrow_profile: None, rate_limit: None, sla: None,
        };
        let req = ProvisionRequestBuilder::new(offering, tier, "p".into(), "k".into())
            .build()
            .unwrap();
        assert!(!req.nonce.is_empty());
        assert!(req.idempotency_key.is_some());
    }
}
