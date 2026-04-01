use serde::{Deserialize, Serialize};

/// Sponsorship entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sponsorship {
    pub sponsor_wallet_id: String,
    pub package_name: Option<String>,
    pub maintainer_id: Option<String>,
    pub amount: String,
    pub currency: String,
    pub schedule: SponsorSchedule,
    pub started_at: String,
    pub status: SponsorStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SponsorSchedule {
    OneTime,
    Monthly,
    Quarterly,
    Annual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SponsorStatus {
    Active,
    Paused,
    Cancelled,
    Completed,
}

/// Create a sponsorship.
pub fn create_sponsorship(
    session: &crate::sardis::auth::SardisSession,
    package_name: &str,
    amount: &str,
    currency: &str,
    schedule: SponsorSchedule,
) -> Result<Sponsorship, crate::sardis::auth::SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let body = serde_json::json!({
        "package_name": package_name,
        "amount": amount,
        "currency": currency,
        "schedule": schedule,
    });

    let resp = client.post("https://api.sardis.dev/v1/wallet/sponsor")
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/sardis-client")
        .body(body.to_string())
        .send()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let resp_body = resp.text()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;
    let sponsorship: Sponsorship = serde_json::from_str(&resp_body)
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    Ok(sponsorship)
}

/// List active sponsorships.
pub fn list_sponsorships(
    session: &crate::sardis::auth::SardisSession,
) -> Result<Vec<Sponsorship>, crate::sardis::auth::SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let resp = client.get("https://api.sardis.dev/v1/wallet/sponsorships")
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("User-Agent", "better-npm/sardis-client")
        .send()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let resp_body = resp.text()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;
    let sponsorships: Vec<Sponsorship> = serde_json::from_str(&resp_body)
        .unwrap_or_default();

    Ok(sponsorships)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sponsorship_struct_construction() {
        let s = Sponsorship {
            sponsor_wallet_id: "wallet-123".to_string(),
            package_name: Some("lodash".to_string()),
            maintainer_id: None,
            amount: "5.00".to_string(),
            currency: "USD".to_string(),
            schedule: SponsorSchedule::Monthly,
            started_at: "2024-01-01".to_string(),
            status: SponsorStatus::Active,
        };
        assert_eq!(s.currency, "USD");
        assert!(matches!(s.schedule, SponsorSchedule::Monthly));
        assert!(matches!(s.status, SponsorStatus::Active));
    }

    #[test]
    fn sponsor_schedule_variants() {
        let _ = SponsorSchedule::OneTime;
        let _ = SponsorSchedule::Quarterly;
        let _ = SponsorSchedule::Annual;
    }
}
