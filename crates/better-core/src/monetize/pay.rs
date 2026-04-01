use serde::{Deserialize, Serialize};

/// Payment to a single package maintainer.
#[derive(Debug, Serialize)]
pub struct PaymentRequest {
    pub package_name: String,
    pub package_version: Option<String>,
    pub amount: String,
    pub currency: String,
    pub recipient_wallet_id: Option<String>,
    pub recurring: Option<RecurringSchedule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RecurringSchedule {
    Monthly,
    Weekly,
    Quarterly,
}

/// Result of a payment.
#[derive(Debug, Serialize, Deserialize)]
pub struct PaymentResult {
    pub transaction_id: String,
    pub package_name: String,
    pub amount: String,
    pub currency: String,
    pub status: PaymentStatus,
    pub recipient: String,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum PaymentStatus {
    Completed,
    Pending,
    Failed,
    Recurring,
}

/// Distribution strategy for pay --all.
#[derive(Debug, Clone)]
pub enum DistributionStrategy {
    Equal,
    WeightedByUsage,
    WeightedByDepth,
    Custom(std::collections::HashMap<String, f64>),
}

/// Pay a single package maintainer.
pub fn pay_package(
    session: &crate::sardis::auth::SardisSession,
    package_name: &str,
    amount: &str,
    currency: &str,
) -> Result<PaymentResult, crate::sardis::auth::SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let body = serde_json::json!({
        "package_name": package_name,
        "amount": amount,
        "currency": currency,
    });

    let resp = client.post("https://api.sardis.dev/v1/wallet/pay")
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/sardis-client")
        .body(body.to_string())
        .send()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    if status == 401 {
        return Err(crate::sardis::auth::SardisError::SessionExpired);
    }
    if status != 200 && status != 201 {
        return Err(crate::sardis::auth::SardisError::Api {
            code: status.to_string(),
            message: "Payment failed".into(),
        });
    }

    let resp_body = resp.text()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;
    let result: PaymentResult = serde_json::from_str(&resp_body)
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    Ok(result)
}

/// Pay all dependencies with budget distribution.
pub fn pay_all(
    session: &crate::sardis::auth::SardisSession,
    project_root: &std::path::Path,
    budget: &str,
    currency: &str,
    _strategy: DistributionStrategy,
) -> Result<Vec<PaymentResult>, crate::sardis::auth::SardisError> {
    // Read lockfile to list all deps
    let lockfile = project_root.join("package-lock.json");
    let content = std::fs::read_to_string(&lockfile)
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    // Extract package names from lockfile (simplified)
    let deps = crate::extract_json_object_pairs(&content, "dependencies")
        .unwrap_or_default();

    if deps.is_empty() {
        return Ok(vec![]);
    }

    // Parse budget
    let budget_amount: f64 = budget.trim_end_matches(|c: char| c.is_alphabetic())
        .parse()
        .unwrap_or(0.0);

    let per_dep = budget_amount / deps.len() as f64;
    let per_dep_str = format!("{:.2}", per_dep);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let body = serde_json::json!({
        "payments": deps.iter().map(|(name, _)| {
            serde_json::json!({
                "package_name": name,
                "amount": per_dep_str,
                "currency": currency,
            })
        }).collect::<Vec<_>>(),
    });

    let resp = client.post("https://api.sardis.dev/v1/wallet/pay/batch")
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/sardis-client")
        .body(body.to_string())
        .send()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let resp_body = resp.text()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;
    let results: Vec<PaymentResult> = serde_json::from_str(&resp_body)
        .unwrap_or_default();

    Ok(results)
}

/// Set up recurring payment.
pub fn setup_recurring(
    session: &crate::sardis::auth::SardisSession,
    package_name: &str,
    amount: &str,
    currency: &str,
    schedule: RecurringSchedule,
) -> Result<PaymentResult, crate::sardis::auth::SardisError> {
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

    let resp = client.post("https://api.sardis.dev/v1/wallet/recurring")
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/sardis-client")
        .body(body.to_string())
        .send()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let resp_body = resp.text()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;
    let result: PaymentResult = serde_json::from_str(&resp_body)
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    Ok(result)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payment_status_serde_roundtrip() {
        let status = PaymentStatus::Completed;
        let json = serde_json::to_string(&status).unwrap();
        let back: PaymentStatus = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, PaymentStatus::Completed));
    }

    #[test]
    fn recurring_schedule_serde_roundtrip() {
        let schedule = RecurringSchedule::Monthly;
        let json = serde_json::to_string(&schedule).unwrap();
        let back: RecurringSchedule = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, RecurringSchedule::Monthly));
    }

    #[test]
    fn payment_result_serde_roundtrip() {
        let result = PaymentResult {
            transaction_id: "tx-001".to_string(),
            package_name: "lodash".to_string(),
            amount: "1.00".to_string(),
            currency: "USD".to_string(),
            status: PaymentStatus::Completed,
            recipient: "jdalton".to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&result).unwrap();
        let back: PaymentResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back.transaction_id, "tx-001");
        assert_eq!(back.package_name, "lodash");
    }
}
