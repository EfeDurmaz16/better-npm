use serde::{Deserialize, Serialize};

/// Earnings summary.
#[derive(Debug, Serialize, Deserialize)]
pub struct EarningsSummary {
    pub total_earned: String,
    pub currency: String,
    pub period_start: String,
    pub period_end: String,
    pub packages: Vec<PackageEarnings>,
    pub pending_payout: String,
    pub last_payout_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PackageEarnings {
    pub package_name: String,
    pub total: String,
    pub installs_paid: u64,
    pub installs_free: u64,
    pub donations: u64,
    pub recurring_subscribers: u64,
    pub breakdown: Option<Vec<DailyEarning>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DailyEarning {
    pub date: String,
    pub amount: String,
    pub transactions: u64,
}

/// Fetch earnings from Sardis API.
pub fn fetch_earnings(
    session: &crate::sardis::auth::SardisSession,
    period_days: u32,
    with_breakdown: bool,
) -> Result<EarningsSummary, crate::sardis::auth::SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let url = format!(
        "https://api.sardis.dev/v1/wallet/earnings?period={}&breakdown={}",
        period_days, with_breakdown
    );

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("User-Agent", "better-npm/sardis-client")
        .send()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    if status == 401 {
        return Err(crate::sardis::auth::SardisError::SessionExpired);
    }
    if status != 200 {
        return Err(crate::sardis::auth::SardisError::Api {
            code: status.to_string(),
            message: "Failed to fetch earnings".into(),
        });
    }

    let body = resp.text()
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;
    let earnings: EarningsSummary = serde_json::from_str(&body)
        .map_err(|e| crate::sardis::auth::SardisError::Network(e.to_string()))?;

    Ok(earnings)
}
