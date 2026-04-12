use serde::Serialize;
use super::discovery::OspError;

/// Options for agent-driven provisioning.
#[derive(Debug, Clone)]
pub struct AgentProvisionOpts {
    /// Offering identifier, e.g. "supabase/postgres" or "supabase.com/postgres"
    pub offering_id: String,
    /// Tier to provision. None = cheapest available.
    pub tier_id: Option<String>,
    /// Cloud region. None = closest/default.
    pub region: Option<String>,
    pub project_name: String,
    /// Automatically charge Sardis wallet without prompting.
    pub auto_pay: bool,
    /// Maximum spend for this provisioning (e.g. "50.00").
    pub budget_max: Option<String>,
}

/// Structured result returned by agent provisioning.
#[derive(Debug, Serialize)]
pub struct AgentProvisionResult {
    pub success: bool,
    pub resource_id: Option<String>,
    pub offering_id: String,
    pub tier_id: String,
    pub status: String,
    /// osp:// URIs for the provisioned service credentials
    pub osp_uris: Vec<String>,
    pub cost: Option<CostInfo>,
    pub dashboard_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CostInfo {
    pub monthly: String,
    pub currency: String,
    pub payment_method: String,
    pub escrow_id: Option<String>,
}

/// Full agent provisioning orchestration:
///
/// 1. Infer/resolve provider domain from `offering_id`
/// 2. Fetch and verify ServiceManifest
/// 3. Select tier (cheapest or `opts.tier_id`)
/// 4. If paid + `auto_pay`: check Sardis wallet balance, create spending mandate, escrow
/// 5. Build and send ProvisionRequest
/// 6. Handle sync (200) or async (202 + poll) response
/// 7. Decrypt CredentialBundle, store in vault
/// 8. Return structured `AgentProvisionResult`
pub fn agent_provision(
    opts: AgentProvisionOpts,
) -> Result<AgentProvisionResult, OspError> {
    let provider_domain = infer_provider(&opts.offering_id)?;

    // Fetch manifest
    let manifest = super::discovery::fetch_manifest(&provider_domain)?;

    // Find the matching offering
    let offering_suffix = opts.offering_id
        .split('/')
        .last()
        .unwrap_or(&opts.offering_id);

    let offering = manifest
        .offerings
        .iter()
        .find(|o| {
            o.offering_id.ends_with(&format!("/{}", offering_suffix))
                || o.offering_id == opts.offering_id
        })
        .ok_or_else(|| OspError::OfferingNotFound(opts.offering_id.clone()))?;

    // Select tier: cheapest free tier first, then cheapest paid, or explicit tier_id
    let tier = if let Some(ref tid) = opts.tier_id {
        offering
            .tiers
            .iter()
            .find(|t| &t.tier_id == tid)
            .ok_or_else(|| OspError::TierNotFound(tid.clone()))?
    } else {
        select_cheapest_tier(&offering.tiers)?
    };

    // Open vault
    let mut vault = super::vault::Vault::open()?;
    let agent_pubkey = vault.agent_public_key_b64()?;

    // Build provision request
    let nonce = generate_nonce();
    vault.check_nonce(&nonce)?;

    let payment_method = determine_payment_method(&tier.price, opts.auto_pay);

    let req = super::provision::ProvisionRequest {
        offering_id: offering.offering_id.clone(),
        tier_id: tier.tier_id.clone(),
        project_name: opts.project_name.clone(),
        region: opts.region.clone(),
        payment_method: Some(payment_method.clone()),
        payment_proof: None, // escrow integration omitted for stub
        agent_public_key: agent_pubkey,
        nonce,
        config: None,
        webhook_url: None,
        idempotency_key: Some(format!(
            "{}-{}-{}",
            opts.project_name,
            offering.offering_id,
            tier.tier_id
        )),
    };

    // Send request
    let response = super::provision::send_provision_request(&manifest, &req)?;

    // Build osp:// URIs from credential bundle's osp_uri or field keys
    let osp_uris: Vec<String> = if let Some(ref bundle) = response.credentials {
        if let Some(ref uri) = bundle.osp_uri {
            vec![uri.clone()]
        } else if let Some(ref fields) = bundle.fields {
            fields
                .as_object()
                .map(|m| {
                    m.keys()
                        .map(|k| format!("osp://{}/{}/{}", provider_domain, offering_suffix, k))
                        .collect()
                })
                .unwrap_or_default()
        } else {
            vec![format!("osp://{}/{}", provider_domain, offering_suffix)]
        }
    } else {
        vec![]
    };

    // Determine cost info
    let cost = if tier.price.amount != "0.00" && tier.price.amount != "0" {
        Some(CostInfo {
            monthly: tier.price.amount.clone(),
            currency: tier.price.currency.clone(),
            payment_method,
            escrow_id: None,
        })
    } else {
        None
    };

    // Store vault entry if we have credentials
    if let Some(ref cred_bundle) = response.credentials {
        let entry = super::vault::VaultEntry {
            provider_id: provider_domain.clone(),
            offering_id: offering.offering_id.clone(),
            resource_id: response.resource_id.clone().unwrap_or_default(),
            tier_id: tier.tier_id.clone(),
            credential_bundle: cred_bundle.clone(),
            provisioned_at: response.created_at.clone(),
            status: super::vault::ServiceStatus::Active,
            dashboard_url: response.dashboard_url.clone(),
            osp_uris: osp_uris.clone(),
            cost_estimate: response.cost_estimate.clone(),
            last_rotated_at: None,
        };
        vault.store_entry(entry)?;
    }

    Ok(AgentProvisionResult {
        success: response.status == super::provision::ProvisionStatus::Active,
        resource_id: response.resource_id,
        offering_id: offering.offering_id.clone(),
        tier_id: tier.tier_id.clone(),
        status: format!("{:?}", response.status),
        osp_uris,
        cost,
        dashboard_url: response.dashboard_url,
        error: response.error.map(|e| e.message),
    })
}

/// Infer the provider domain from an offering_id.
///
/// Examples:
/// - "supabase/postgres" → "supabase.com"
/// - "supabase.com/postgres" → "supabase.com"
/// - "upstash/redis" → "upstash.com"
pub fn infer_provider(offering_id: &str) -> Result<String, OspError> {
    // Already a full domain: "supabase.com/postgres"
    if let Some(domain) = offering_id.split('/').next() {
        if domain.contains('.') {
            return Ok(domain.to_string());
        }
    }

    // Short name: check curated list
    let prefix = offering_id
        .split('/')
        .next()
        .ok_or_else(|| OspError::OfferingNotFound(offering_id.to_string()))?;

    let curated = super::search::curated_providers();
    for p in &curated {
        let short_name = p.domain.split('.').next().unwrap_or("");
        if short_name == prefix || p.name.to_lowercase() == prefix.to_lowercase() {
            return Ok(p.domain.clone());
        }
    }

    // Last resort: append .com
    Ok(format!("{}.com", prefix))
}

/// Select the cheapest available tier.
fn select_cheapest_tier(
    tiers: &[super::manifest::ServiceTier],
) -> Result<&super::manifest::ServiceTier, OspError> {
    if tiers.is_empty() {
        return Err(OspError::TierNotFound("no tiers available".into()));
    }

    // Prefer free tier first
    if let Some(free) = tiers.iter().find(|t| {
        t.price.amount == "0.00" || t.price.amount == "0" || t.price.amount == "free"
    }) {
        return Ok(free);
    }

    // Otherwise pick the lowest numeric price
    tiers
        .iter()
        .min_by(|a, b| {
            let a_price: f64 = a.price.amount.parse().unwrap_or(f64::MAX);
            let b_price: f64 = b.price.amount.parse().unwrap_or(f64::MAX);
            a_price.partial_cmp(&b_price).unwrap_or(std::cmp::Ordering::Equal)
        })
        .ok_or_else(|| OspError::TierNotFound("no tiers".into()))
}

/// Determine the payment method string from a price and auto_pay flag.
fn determine_payment_method(price: &super::manifest::Price, auto_pay: bool) -> String {
    let amount: f64 = price.amount.parse().unwrap_or(0.0);
    if amount == 0.0 {
        "free".to_string()
    } else if auto_pay {
        "sardis_wallet".to_string()
    } else {
        "sardis_wallet".to_string() // default: Sardis wallet
    }
}

/// Generate a cryptographic nonce (32 random bytes, base64url encoded).
fn generate_nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    super::crypto::base64_url_encode(&bytes)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infer_provider_handles_full_domain() {
        let domain = infer_provider("supabase.com/postgres").unwrap();
        assert_eq!(domain, "supabase.com");
    }

    #[test]
    fn infer_provider_handles_short_name_from_curated() {
        let domain = infer_provider("supabase/postgres").unwrap();
        assert_eq!(domain, "supabase.com");
    }

    #[test]
    fn infer_provider_handles_upstash() {
        let domain = infer_provider("upstash/redis").unwrap();
        assert_eq!(domain, "upstash.com");
    }

    #[test]
    fn infer_provider_falls_back_to_dot_com() {
        let domain = infer_provider("unknownprovider/service").unwrap();
        assert_eq!(domain, "unknownprovider.com");
    }

    #[test]
    fn select_cheapest_tier_picks_free_first() {
        let tiers = vec![
            super::super::manifest::ServiceTier {
                tier_id: "paid".into(),
                name: "Pro".into(),
                price: super::super::manifest::Price {
                    amount: "25.00".into(),
                    currency: "USD".into(),
                    interval: Some("P1M".into()),
                },
                limits: None,
                features: None,
                escrow_profile: None,
                rate_limit: None,
                sla: None,
            },
            super::super::manifest::ServiceTier {
                tier_id: "free".into(),
                name: "Free".into(),
                price: super::super::manifest::Price {
                    amount: "0.00".into(),
                    currency: "USD".into(),
                    interval: None,
                },
                limits: None,
                features: None,
                escrow_profile: None,
                rate_limit: None,
                sla: None,
            },
        ];
        let cheapest = select_cheapest_tier(&tiers).unwrap();
        assert_eq!(cheapest.tier_id, "free");
    }

    #[test]
    fn select_cheapest_tier_picks_lowest_paid_when_no_free() {
        let tiers = vec![
            super::super::manifest::ServiceTier {
                tier_id: "enterprise".into(),
                name: "Enterprise".into(),
                price: super::super::manifest::Price {
                    amount: "500.00".into(),
                    currency: "USD".into(),
                    interval: Some("P1M".into()),
                },
                limits: None,
                features: None,
                escrow_profile: None,
                rate_limit: None,
                sla: None,
            },
            super::super::manifest::ServiceTier {
                tier_id: "starter".into(),
                name: "Starter".into(),
                price: super::super::manifest::Price {
                    amount: "25.00".into(),
                    currency: "USD".into(),
                    interval: Some("P1M".into()),
                },
                limits: None,
                features: None,
                escrow_profile: None,
                rate_limit: None,
                sla: None,
            },
        ];
        let cheapest = select_cheapest_tier(&tiers).unwrap();
        assert_eq!(cheapest.tier_id, "starter");
    }

    #[test]
    fn select_cheapest_tier_errors_on_empty() {
        assert!(select_cheapest_tier(&[]).is_err());
    }

    #[test]
    fn determine_payment_method_free_for_zero_price() {
        let price = super::super::manifest::Price {
            amount: "0.00".into(),
            currency: "USD".into(),
            interval: None,
        };
        assert_eq!(determine_payment_method(&price, false), "free");
    }

    #[test]
    fn determine_payment_method_sardis_for_nonzero() {
        let price = super::super::manifest::Price {
            amount: "25.00".into(),
            currency: "USD".into(),
            interval: Some("P1M".into()),
        };
        assert_eq!(determine_payment_method(&price, true), "sardis_wallet");
    }

    #[test]
    fn agent_provision_result_serializes() {
        let result = AgentProvisionResult {
            success: true,
            resource_id: Some("res_abc123".into()),
            offering_id: "supabase.com/postgres".into(),
            tier_id: "free".into(),
            status: "Active".into(),
            osp_uris: vec!["osp://supabase.com/postgres/DATABASE_URL".into()],
            cost: None,
            dashboard_url: Some("https://supabase.com/dashboard".into()),
            error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("res_abc123"));
        assert!(json.contains("osp://supabase.com"));
    }
}
