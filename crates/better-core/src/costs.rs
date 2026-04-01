// crates/better-core/src/costs.rs
//
// Infrastructure cost tracking and optimization (v1.4 Task 112).
//
// Aggregates monthly cost estimates across OSP-provisioned services,
// identifies optimization opportunities, and tracks spend trends.
// No network I/O — caller populates ServiceCost entries from OSP receipts.

use std::collections::HashMap;

use serde::Serialize;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CostReport {
    pub total_monthly_usd: f64,
    pub by_environment: HashMap<String, f64>,
    pub by_service: Vec<ServiceCost>,
    pub by_provider: HashMap<String, f64>,
    pub trend: CostTrend,
    pub optimizations: Vec<CostOptimization>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceCost {
    pub provider: String,
    pub service: String,
    pub tier: String,
    pub environment: String,
    /// Monthly cost in USD
    pub monthly_usd: f64,
    /// Percentage of tier quota used (0–100)
    pub usage_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostTrend {
    pub current_month_usd: f64,
    pub previous_month_usd: f64,
    /// Positive = increase, negative = decrease
    pub change_pct: f64,
    pub projected_month_end_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostOptimization {
    pub suggestion: String,
    pub potential_savings_usd: f64,
    pub service: String,
    pub action: OptimizationAction,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OptimizationAction {
    Downgrade { from_tier: String, to_tier: String },
    Consolidate { services: Vec<String>, into: String },
    Remove { reason: String },
    SwitchProvider { from: String, to: String },
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/// Build a cost report from a list of service cost entries.
///
/// `current_day_of_month` (1–31) is used for month-end projection.
pub fn generate_cost_report(
    services: &[ServiceCost],
    previous_month_total: f64,
    current_day_of_month: u32,
) -> CostReport {
    let total = services.iter().map(|s| s.monthly_usd).sum::<f64>();

    // Aggregate by environment
    let mut by_env: HashMap<String, f64> = HashMap::new();
    for s in services {
        *by_env.entry(s.environment.clone()).or_insert(0.0) += s.monthly_usd;
    }

    // Aggregate by provider
    let mut by_provider: HashMap<String, f64> = HashMap::new();
    for s in services {
        *by_provider.entry(s.provider.clone()).or_insert(0.0) += s.monthly_usd;
    }

    let change_pct = if previous_month_total > 0.0 {
        (total - previous_month_total) / previous_month_total * 100.0
    } else {
        0.0
    };

    let days = current_day_of_month.max(1) as f64;
    let projected = total / days * 30.0;

    let trend = CostTrend {
        current_month_usd: total,
        previous_month_usd: previous_month_total,
        change_pct,
        projected_month_end_usd: projected,
    };

    let optimizations = generate_optimizations(services);

    CostReport {
        total_monthly_usd: total,
        by_environment: by_env,
        by_service: services.to_vec(),
        by_provider,
        trend,
        optimizations,
    }
}

// ---------------------------------------------------------------------------
// Optimization engine
// ---------------------------------------------------------------------------

fn generate_optimizations(services: &[ServiceCost]) -> Vec<CostOptimization> {
    let mut suggestions: Vec<CostOptimization> = Vec::new();

    for svc in services {
        // Low utilisation → suggest downgrade
        if svc.usage_pct < 10.0 && svc.tier != "free" && svc.monthly_usd > 0.0 {
            suggestions.push(CostOptimization {
                suggestion: format!(
                    "{} ({}) uses only {:.0}% of its {} tier — consider downgrading",
                    svc.service, svc.provider, svc.usage_pct, svc.tier
                ),
                potential_savings_usd: svc.monthly_usd * 0.5, // rough estimate
                service: svc.service.clone(),
                action: OptimizationAction::Downgrade {
                    from_tier: svc.tier.clone(),
                    to_tier: "free".to_string(),
                },
            });
        }

        // Expensive provider — suggest free-tier alternatives
        if svc.monthly_usd > 50.0 && svc.tier != "free" {
            if let Some(alt) = free_tier_alternative(&svc.provider, &svc.service) {
                suggestions.push(CostOptimization {
                    suggestion: format!(
                        "Consider {} instead of {} for {} (potential ${:.0}/mo savings)",
                        alt, svc.provider, svc.service, svc.monthly_usd
                    ),
                    potential_savings_usd: svc.monthly_usd,
                    service: svc.service.clone(),
                    action: OptimizationAction::SwitchProvider {
                        from: svc.provider.clone(),
                        to: alt.to_string(),
                    },
                });
            }
        }
    }

    // Detect consolidation opportunities: multiple HTTP databases
    let db_services: Vec<&ServiceCost> = services.iter()
        .filter(|s| is_database(&s.service))
        .collect();
    if db_services.len() > 2 {
        let names: Vec<String> = db_services.iter().map(|s| s.service.clone()).collect();
        let savings: f64 = db_services.iter().skip(1).map(|s| s.monthly_usd).sum();
        suggestions.push(CostOptimization {
            suggestion: format!(
                "{} database services detected — consolidating to one could save ~${:.0}/mo",
                db_services.len(), savings
            ),
            potential_savings_usd: savings,
            service: names.first().cloned().unwrap_or_default(),
            action: OptimizationAction::Consolidate {
                services: names.clone(),
                into: names.first().cloned().unwrap_or_default(),
            },
        });
    }

    suggestions.sort_by(|a, b| b.potential_savings_usd.partial_cmp(&a.potential_savings_usd)
        .unwrap_or(std::cmp::Ordering::Equal));
    suggestions
}

fn is_database(service: &str) -> bool {
    let s = service.to_lowercase();
    s.contains("postgres") || s.contains("mysql") || s.contains("mongo")
        || s.contains("redis") || s.contains("database") || s.contains("db")
}

fn free_tier_alternative(provider: &str, _service: &str) -> Option<&'static str> {
    match provider.to_lowercase().as_str() {
        "aws" | "amazon" => Some("Supabase (free tier)"),
        "azure" => Some("PlanetScale (free tier)"),
        "gcp" | "google" => Some("Neon (free tier)"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn svc(provider: &str, service: &str, tier: &str, env: &str, cost: f64, usage: f64) -> ServiceCost {
        ServiceCost {
            provider: provider.to_string(),
            service: service.to_string(),
            tier: tier.to_string(),
            environment: env.to_string(),
            monthly_usd: cost,
            usage_pct: usage,
        }
    }

    #[test]
    fn total_cost_summed_correctly() {
        let services = vec![
            svc("supabase", "postgres", "pro", "production", 25.0, 50.0),
            svc("upstash", "redis", "pay-as-you-go", "production", 5.0, 30.0),
        ];
        let report = generate_cost_report(&services, 0.0, 15);
        assert!((report.total_monthly_usd - 30.0).abs() < 0.01);
    }

    #[test]
    fn by_environment_aggregation() {
        let services = vec![
            svc("aws", "rds", "t3", "production", 50.0, 60.0),
            svc("aws", "elasticache", "t3", "staging", 20.0, 40.0),
            svc("aws", "lambda", "free", "production", 0.0, 10.0),
        ];
        let report = generate_cost_report(&services, 0.0, 15);
        let prod = report.by_environment.get("production").copied().unwrap_or(0.0);
        let staging = report.by_environment.get("staging").copied().unwrap_or(0.0);
        assert!((prod - 50.0).abs() < 0.01);
        assert!((staging - 20.0).abs() < 0.01);
    }

    #[test]
    fn low_usage_triggers_downgrade_suggestion() {
        let services = vec![svc("heroku", "postgres", "standard", "dev", 50.0, 3.0)];
        let report = generate_cost_report(&services, 0.0, 15);
        assert!(report.optimizations.iter().any(|o|
            matches!(&o.action, OptimizationAction::Downgrade { .. })
        ));
    }

    #[test]
    fn cost_trend_change_pct() {
        let services = vec![svc("aws", "rds", "t3", "prod", 110.0, 70.0)];
        let report = generate_cost_report(&services, 100.0, 15);
        assert!((report.trend.change_pct - 10.0).abs() < 0.1);
    }

    #[test]
    fn projected_month_end_scales_daily() {
        let services = vec![svc("vercel", "hosting", "pro", "prod", 15.0, 50.0)];
        // Current day 15 → spend of 15 over 15 days → project 30/mo
        let report = generate_cost_report(&services, 0.0, 15);
        assert!((report.trend.projected_month_end_usd - 30.0).abs() < 1.0);
    }

    #[test]
    fn many_databases_suggest_consolidation() {
        let services = vec![
            svc("supabase", "postgres-db", "pro", "prod", 25.0, 50.0),
            svc("mongo", "mongodb-db", "m10", "prod", 60.0, 40.0),
            svc("redis-labs", "redis-db", "essentials", "prod", 15.0, 30.0),
        ];
        let report = generate_cost_report(&services, 0.0, 15);
        assert!(report.optimizations.iter().any(|o|
            matches!(&o.action, OptimizationAction::Consolidate { .. })
        ));
    }
}
