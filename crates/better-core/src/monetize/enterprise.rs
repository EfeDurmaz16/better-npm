use serde::{Deserialize, Serialize};

/// Organization configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgConfig {
    pub org_id: String,
    pub org_name: String,
    pub monthly_budget: String,
    pub currency: String,
    pub approval_required_above: Option<String>,
    pub allowed_payment_targets: Option<Vec<String>>,
    pub blocked_payment_targets: Option<Vec<String>>,
    pub members: Vec<OrgMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgMember {
    pub user_id: String,
    pub role: OrgRole,
    pub spending_limit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OrgRole {
    Admin,
    Developer,
    Viewer,
}

/// Compliance report for auditing.
#[derive(Debug, Serialize, Deserialize)]
pub struct ComplianceReport {
    pub org_id: String,
    pub period_start: String,
    pub period_end: String,
    pub total_spend: String,
    pub currency: String,
    pub transactions: Vec<ComplianceTransaction>,
    pub services_provisioned: Vec<ComplianceService>,
    pub generated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ComplianceTransaction {
    pub transaction_id: String,
    pub user_id: String,
    pub package_or_service: String,
    pub amount: String,
    pub currency: String,
    pub timestamp: String,
    pub approved_by: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ComplianceService {
    pub provider_id: String,
    pub offering_id: String,
    pub resource_id: String,
    pub monthly_cost: String,
    pub provisioned_by: String,
    pub provisioned_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BudgetCheck {
    pub allowed: bool,
    pub remaining_budget: String,
    pub requires_approval: bool,
    pub reason: Option<String>,
}

/// Generate compliance report.
pub fn generate_compliance_report(
    session: &crate::sardis::auth::SardisSession,
    org_id: &str,
    period_days: u32,
) -> Result<ComplianceReport, crate::sardis::auth::SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let url = format!(
        "https://api.sardis.dev/v1/org/{}/compliance?period={}",
        org_id, period_days
    );

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("User-Agent", "better-npm/sardis-client")
        .send()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let resp_body = resp.text()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;
    let report: ComplianceReport = serde_json::from_str(&resp_body)
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    Ok(report)
}

/// Check org budget before payment.
pub fn check_org_budget(
    session: &crate::sardis::auth::SardisSession,
    org_id: &str,
    amount: &str,
) -> Result<BudgetCheck, crate::sardis::auth::SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let url = format!(
        "https://api.sardis.dev/v1/org/{}/budget/check?amount={}",
        org_id, amount
    );

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("User-Agent", "better-npm/sardis-client")
        .send()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let resp_body = resp.text()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;
    let check: BudgetCheck = serde_json::from_str(&resp_body)
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    Ok(check)
}
