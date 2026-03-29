use serde::{Deserialize, Serialize};

/// Pricing model for a published package.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackagePricing {
    pub model: PricingModel,
    pub suggested_amount: Option<String>,
    pub currency: Option<String>,
    pub sardis_wallet_id: String,
    pub minimum_amount: Option<String>,
    pub tiers: Option<Vec<PricingTier>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PricingModel {
    Donation,
    PayWhatYouWant,
    PerInstall,
    Subscription,
    FreemiumLicense,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PricingTier {
    pub name: String,
    pub amount: String,
    pub currency: String,
    pub features: Vec<String>,
}

/// Validate and inject pricing metadata into package.json before publish.
pub fn inject_pricing(
    package_json: &mut serde_json::Value,
    pricing: &PackagePricing,
) -> Result<(), String> {
    let better = package_json.as_object_mut()
        .ok_or("Invalid package.json")?
        .entry("better")
        .or_insert(serde_json::json!({}));

    better.as_object_mut()
        .ok_or("Invalid better field")?
        .insert(
            "pricing".into(),
            serde_json::to_value(pricing).map_err(|e| e.to_string())?,
        );

    Ok(())
}

/// Validate pricing before publish.
pub fn validate_pricing(pricing: &PackagePricing) -> Result<(), Vec<String>> {
    let mut errors = vec![];

    if pricing.sardis_wallet_id.is_empty() {
        errors.push("sardis_wallet_id is required".into());
    }

    if let Some(ref amount) = pricing.suggested_amount {
        if amount.parse::<f64>().is_err() {
            errors.push(format!("Invalid suggested_amount: {}", amount));
        }
    }

    if let Some(ref min) = pricing.minimum_amount {
        if min.parse::<f64>().is_err() {
            errors.push(format!("Invalid minimum_amount: {}", min));
        }
    }

    if errors.is_empty() { Ok(()) } else { Err(errors) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inject_pricing() {
        let mut pkg = serde_json::json!({"name": "test-pkg", "version": "1.0.0"});
        let pricing = PackagePricing {
            model: PricingModel::Donation,
            suggested_amount: Some("5.00".into()),
            currency: Some("USD".into()),
            sardis_wallet_id: "w_123".into(),
            minimum_amount: None,
            tiers: None,
        };
        inject_pricing(&mut pkg, &pricing).unwrap();
        assert!(pkg["better"]["pricing"]["sardis_wallet_id"].as_str() == Some("w_123"));
    }

    #[test]
    fn test_validate_pricing_missing_wallet() {
        let pricing = PackagePricing {
            model: PricingModel::Donation,
            suggested_amount: None,
            currency: None,
            sardis_wallet_id: "".into(),
            minimum_amount: None,
            tiers: None,
        };
        let result = validate_pricing(&pricing);
        assert!(result.is_err());
        assert!(result.unwrap_err()[0].contains("sardis_wallet_id"));
    }

    #[test]
    fn test_validate_pricing_valid() {
        let pricing = PackagePricing {
            model: PricingModel::PayWhatYouWant,
            suggested_amount: Some("10.00".into()),
            currency: Some("USD".into()),
            sardis_wallet_id: "w_valid".into(),
            minimum_amount: Some("1.00".into()),
            tiers: None,
        };
        assert!(validate_pricing(&pricing).is_ok());
    }

    #[test]
    fn test_pricing_model_serialization() {
        let model = PricingModel::PayWhatYouWant;
        let json = serde_json::to_string(&model).unwrap();
        assert_eq!(json, "\"pay-what-you-want\"");
    }
}
