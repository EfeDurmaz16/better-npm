use serde::{Deserialize, Serialize};

/// Wallet info from Sardis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletInfo {
    pub wallet_id: String,
    pub balance: String,
    pub currency: String,
    pub trust_tier: u8,
}

/// Spending mandate for OSP provisioning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpendingMandate {
    pub mandate_id: String,
    pub wallet_id: String,
    pub max_amount: String,
    pub currency: String,
    pub provider_id: String,
    pub offering_id: String,
    pub expires_at: String,
    pub signature: String,
}

/// Escrow hold response from Sardis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EscrowHold {
    pub escrow_id: String,
    pub amount: String,
    pub currency: String,
    pub status: EscrowStatus,
    pub timeout_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum EscrowStatus {
    Held,
    Released,
    Refunded,
    Disputed,
}

/// Query wallet balance.
pub fn wallet_balance(
    session: &super::auth::SardisSession,
) -> Result<WalletInfo, super::auth::SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    let resp = client.get("https://api.sardis.dev/v1/wallet/balance")
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("User-Agent", "better-npm/sardis-client")
        .send()
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    if status == 401 {
        return Err(super::auth::SardisError::SessionExpired);
    }
    if status != 200 {
        return Err(super::auth::SardisError::Api {
            code: status.to_string(),
            message: "Failed to fetch wallet balance".into(),
        });
    }

    let body = resp.text().map_err(|e| super::auth::SardisError::Network(e.to_string()))?;
    let wallet: WalletInfo = serde_json::from_str(&body)
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    Ok(wallet)
}

/// Create a spending mandate for a specific OSP provisioning.
pub fn create_spending_mandate(
    session: &super::auth::SardisSession,
    provider_id: &str,
    offering_id: &str,
    max_amount: &str,
    currency: &str,
) -> Result<SpendingMandate, super::auth::SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    let body = serde_json::json!({
        "provider_id": provider_id,
        "offering_id": offering_id,
        "max_amount": max_amount,
        "currency": currency,
    });

    let resp = client.post("https://api.sardis.dev/v1/wallet/mandates")
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/sardis-client")
        .body(body.to_string())
        .send()
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    if status == 401 {
        return Err(super::auth::SardisError::SessionExpired);
    }
    if status != 200 && status != 201 {
        return Err(super::auth::SardisError::Api {
            code: status.to_string(),
            message: "Failed to create spending mandate".into(),
        });
    }

    let resp_body = resp.text().map_err(|e| super::auth::SardisError::Network(e.to_string()))?;
    let mandate: SpendingMandate = serde_json::from_str(&resp_body)
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    Ok(mandate)
}

/// Create an escrow hold against a spending mandate.
pub fn create_escrow_hold(
    session: &super::auth::SardisSession,
    mandate: &SpendingMandate,
    amount: &str,
) -> Result<EscrowHold, super::auth::SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    let body = serde_json::json!({
        "mandate_id": mandate.mandate_id,
        "amount": amount,
        "currency": mandate.currency,
    });

    let resp = client.post("https://api.sardis.dev/v1/wallet/escrow")
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/sardis-client")
        .body(body.to_string())
        .send()
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    if status != 200 && status != 201 {
        return Err(super::auth::SardisError::Api {
            code: status.to_string(),
            message: "Failed to create escrow hold".into(),
        });
    }

    let resp_body = resp.text().map_err(|e| super::auth::SardisError::Network(e.to_string()))?;
    let escrow: EscrowHold = serde_json::from_str(&resp_body)
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    Ok(escrow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_escrow_status_variants() {
        assert_eq!(
            serde_json::to_string(&EscrowStatus::Held).unwrap(),
            "\"Held\""
        );
        assert_eq!(
            serde_json::to_string(&EscrowStatus::Released).unwrap(),
            "\"Released\""
        );
    }

    #[test]
    fn test_wallet_info_deserialization() {
        let json = r#"{"wallet_id":"w1","balance":"100.50","currency":"USD","trust_tier":2}"#;
        let wallet: WalletInfo = serde_json::from_str(json).unwrap();
        assert_eq!(wallet.balance, "100.50");
        assert_eq!(wallet.trust_tier, 2);
    }

    #[test]
    fn test_escrow_status_all_variants_serde() {
        for (status, expected) in &[
            (EscrowStatus::Held, "\"Held\""),
            (EscrowStatus::Released, "\"Released\""),
            (EscrowStatus::Refunded, "\"Refunded\""),
            (EscrowStatus::Disputed, "\"Disputed\""),
        ] {
            let s = serde_json::to_string(status).unwrap();
            assert_eq!(&s, expected);
        }
    }

    #[test]
    fn test_escrow_hold_serde_roundtrip() {
        let hold = EscrowHold {
            escrow_id: "esc123".into(),
            amount: "9.99".into(),
            currency: "USD".into(),
            status: EscrowStatus::Held,
            timeout_at: "2099-01-01T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&hold).unwrap();
        let back: EscrowHold = serde_json::from_str(&json).unwrap();
        assert_eq!(back.escrow_id, "esc123");
        assert_eq!(back.status, EscrowStatus::Held);
    }

    #[test]
    fn test_spending_mandate_serde_roundtrip() {
        let m = SpendingMandate {
            mandate_id: "m1".into(),
            wallet_id: "w1".into(),
            max_amount: "50.00".into(),
            currency: "EUR".into(),
            provider_id: "supabase".into(),
            offering_id: "supabase/postgres".into(),
            expires_at: "2099-01-01T00:00:00Z".into(),
            signature: "sig123".into(),
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: SpendingMandate = serde_json::from_str(&json).unwrap();
        assert_eq!(back.mandate_id, "m1");
        assert_eq!(back.max_amount, "50.00");
    }

    #[test]
    fn test_wallet_info_serde_roundtrip() {
        let w = WalletInfo {
            wallet_id: "w42".into(),
            balance: "999.00".into(),
            currency: "USD".into(),
            trust_tier: 5,
        };
        let json = serde_json::to_string(&w).unwrap();
        let back: WalletInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.wallet_id, "w42");
        assert_eq!(back.trust_tier, 5);
    }

    #[test]
    fn test_escrow_status_refunded_ne_disputed() {
        assert_ne!(EscrowStatus::Refunded, EscrowStatus::Disputed);
    }

    #[test]
    fn test_wallet_id_stored_in_wallet_info() {
        let w = WalletInfo {
            wallet_id: "wallet-abc".into(),
            balance: "0.00".into(),
            currency: "USD".into(),
            trust_tier: 0,
        };
        assert_eq!(w.wallet_id, "wallet-abc");
        assert_eq!(w.trust_tier, 0);
    }
}
