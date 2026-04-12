use serde::{Deserialize, Serialize};
use super::manifest::ServiceCategory;
use super::discovery::OspError;

/// Search result from OSP registry or curated fallback list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryResult {
    pub provider_id: String,
    pub display_name: String,
    pub offering_id: String,
    pub offering_name: String,
    pub category: ServiceCategory,
    pub description: Option<String>,
    pub tiers: Vec<TierSummary>,
    pub regions: Vec<String>,
    pub payment_methods: Vec<String>,
    pub trust_tier_required: u8,
    pub source: DiscoverySource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierSummary {
    pub tier_id: String,
    pub name: String,
    /// Human-readable price: "Free", "$25/mo", "$0.10/GB"
    pub price_display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DiscoverySource {
    Registry,
    Curated,
    Cached,
}

/// A curated provider entry (compile-time embedded).
#[derive(Debug, Clone)]
pub struct CuratedProvider {
    pub domain: String,
    pub name: String,
    pub categories: Vec<&'static str>,
    pub offerings: Vec<CuratedOffering>,
}

#[derive(Debug, Clone)]
pub struct CuratedOffering {
    pub offering_id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub description: &'static str,
    pub free_tier: bool,
}

/// Curated fallback list of known OSP providers.
/// Updated with each better release; embedded at compile time.
pub fn curated_providers() -> Vec<CuratedProvider> {
    vec![
        CuratedProvider {
            domain: "supabase.com".into(),
            name: "Supabase".into(),
            categories: vec!["database", "auth", "storage"],
            offerings: vec![
                CuratedOffering {
                    offering_id: "supabase.com/postgres",
                    name: "Postgres",
                    category: "database",
                    description: "Managed PostgreSQL with realtime and Row Level Security",
                    free_tier: true,
                },
                CuratedOffering {
                    offering_id: "supabase.com/auth",
                    name: "Auth",
                    category: "auth",
                    description: "User management with JWT, OAuth, and magic links",
                    free_tier: true,
                },
                CuratedOffering {
                    offering_id: "supabase.com/storage",
                    name: "Storage",
                    category: "storage",
                    description: "S3-compatible object storage",
                    free_tier: true,
                },
            ],
        },
        CuratedProvider {
            domain: "neon.tech".into(),
            name: "Neon".into(),
            categories: vec!["database"],
            offerings: vec![
                CuratedOffering {
                    offering_id: "neon.tech/postgres",
                    name: "Serverless Postgres",
                    category: "database",
                    description: "Serverless Postgres with autoscaling and branching",
                    free_tier: true,
                },
            ],
        },
        CuratedProvider {
            domain: "vercel.com".into(),
            name: "Vercel".into(),
            categories: vec!["hosting", "compute"],
            offerings: vec![
                CuratedOffering {
                    offering_id: "vercel.com/hosting",
                    name: "Hosting",
                    category: "hosting",
                    description: "Frontend cloud with edge functions and CI/CD",
                    free_tier: true,
                },
            ],
        },
        CuratedProvider {
            domain: "upstash.com".into(),
            name: "Upstash".into(),
            categories: vec!["database", "messaging"],
            offerings: vec![
                CuratedOffering {
                    offering_id: "upstash.com/redis",
                    name: "Redis",
                    category: "database",
                    description: "Serverless Redis with REST API",
                    free_tier: true,
                },
                CuratedOffering {
                    offering_id: "upstash.com/kafka",
                    name: "Kafka",
                    category: "messaging",
                    description: "Serverless Kafka with REST API",
                    free_tier: true,
                },
            ],
        },
        CuratedProvider {
            domain: "resend.com".into(),
            name: "Resend".into(),
            categories: vec!["email"],
            offerings: vec![
                CuratedOffering {
                    offering_id: "resend.com/email",
                    name: "Email API",
                    category: "email",
                    description: "Developer-friendly transactional email API",
                    free_tier: true,
                },
            ],
        },
        CuratedProvider {
            domain: "cloudflare.com".into(),
            name: "Cloudflare".into(),
            categories: vec!["compute", "storage"],
            offerings: vec![
                CuratedOffering {
                    offering_id: "cloudflare.com/workers-kv",
                    name: "Workers KV",
                    category: "storage",
                    description: "Edge key-value storage",
                    free_tier: true,
                },
                CuratedOffering {
                    offering_id: "cloudflare.com/r2",
                    name: "R2",
                    category: "storage",
                    description: "Zero-egress S3-compatible object storage",
                    free_tier: true,
                },
            ],
        },
        CuratedProvider {
            domain: "planetscale.com".into(),
            name: "PlanetScale".into(),
            categories: vec!["database"],
            offerings: vec![
                CuratedOffering {
                    offering_id: "planetscale.com/mysql",
                    name: "MySQL",
                    category: "database",
                    description: "Serverless MySQL with branching and schema changes",
                    free_tier: false,
                },
            ],
        },
        CuratedProvider {
            domain: "mongodb.com".into(),
            name: "MongoDB Atlas".into(),
            categories: vec!["database"],
            offerings: vec![
                CuratedOffering {
                    offering_id: "mongodb.com/atlas",
                    name: "Atlas",
                    category: "database",
                    description: "Fully managed MongoDB in the cloud",
                    free_tier: true,
                },
            ],
        },
    ]
}

/// Search for OSP providers by query (category or keyword).
///
/// Tries the OSP registry first; falls back to the curated list on failure.
pub fn discover(
    query: &str,
    category_filter: Option<&str>,
    payment_filter: Option<&str>,
    max_results: usize,
) -> Result<Vec<DiscoveryResult>, OspError> {
    // Try registry first
    match query_registry(query, category_filter, max_results) {
        Ok(results) if !results.is_empty() => return Ok(results),
        _ => {} // fall through to curated
    }

    // Fall back to curated providers
    let results = search_curated(query, category_filter, payment_filter, max_results);
    Ok(results)
}

/// Query the OSP registry for providers matching the search term.
fn query_registry(
    query: &str,
    category: Option<&str>,
    max_results: usize,
) -> Result<Vec<DiscoveryResult>, OspError> {
    let mut url = format!(
        "https://registry.osp.dev/v1/search?q={}&limit={}",
        urlencoding(query),
        max_results,
    );
    if let Some(cat) = category {
        url.push_str(&format!("&category={}", urlencoding(cat)));
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| OspError::Network(e.to_string()))?;

    let resp = client
        .get(&url)
        .header("User-Agent", "better-npm/osp-client")
        .send()
        .map_err(|e| OspError::Network(e.to_string()))?;

    if !resp.status().is_success() {
        return Ok(vec![]);
    }

    #[derive(Deserialize)]
    struct RegistryResponse {
        results: Vec<RegistryEntry>,
    }

    #[derive(Deserialize)]
    struct RegistryEntry {
        provider_id: String,
        display_name: String,
        offering_id: String,
        offering_name: String,
        category: String,
        description: Option<String>,
        free_tier: Option<bool>,
        regions: Option<Vec<String>>,
    }

    let text = resp
        .text()
        .map_err(|e: reqwest::Error| OspError::Network(e.to_string()))?;
    let body: RegistryResponse = serde_json::from_str(&text)
        .map_err(|e| OspError::ParseError(e.to_string()))?;

    let results = body
        .results
        .into_iter()
        .map(|e| {
            let tier_display = if e.free_tier.unwrap_or(false) {
                "Free".to_string()
            } else {
                "Paid".to_string()
            };
            DiscoveryResult {
                provider_id: e.provider_id,
                display_name: e.display_name,
                offering_id: e.offering_id.clone(),
                offering_name: e.offering_name,
                category: category_from_str(&e.category),
                description: e.description,
                tiers: vec![TierSummary {
                    tier_id: "default".into(),
                    name: "Default".into(),
                    price_display: tier_display,
                }],
                regions: e.regions.unwrap_or_default(),
                payment_methods: vec!["sardis_wallet".into(), "free".into()],
                trust_tier_required: 0,
                source: DiscoverySource::Registry,
            }
        })
        .collect();

    Ok(results)
}

/// Public alias for use by the registry::unified module.
pub fn search_curated_pub(
    query: &str,
    category_filter: Option<&str>,
    payment_filter: Option<&str>,
    max_results: usize,
) -> Vec<DiscoveryResult> {
    search_curated(query, category_filter, payment_filter, max_results)
}

/// Search the embedded curated provider list.
fn search_curated(
    query: &str,
    category_filter: Option<&str>,
    payment_filter: Option<&str>,
    max_results: usize,
) -> Vec<DiscoveryResult> {
    let query_lower = query.to_lowercase();
    let providers = curated_providers();
    let mut results = Vec::new();

    for provider in &providers {
        // Provider-level category pre-filter (skip providers with no matching category)
        if let Some(cat) = category_filter {
            if !provider.categories.contains(&cat) {
                continue;
            }
        }

        for offering in &provider.offerings {
            // Offering-level category filter (must match the specific offering's category)
            if let Some(cat) = category_filter {
                if offering.category != cat {
                    continue;
                }
            }

            // Payment filter: "free" means only free-tier offerings
            if let Some("free") = payment_filter {
                if !offering.free_tier {
                    continue;
                }
            }

            // Text match: query matches provider name, domain, category, or description
            let matches = query_lower.is_empty()
                || provider.name.to_lowercase().contains(&query_lower)
                || provider.domain.contains(&query_lower)
                || offering.category.contains(&query_lower)
                || offering.name.to_lowercase().contains(&query_lower)
                || offering.description.to_lowercase().contains(&query_lower);

            if matches {
                let price_display = if offering.free_tier {
                    "Free tier available".to_string()
                } else {
                    "Paid".to_string()
                };

                results.push(DiscoveryResult {
                    provider_id: provider.domain.clone(),
                    display_name: provider.name.clone(),
                    offering_id: offering.offering_id.to_string(),
                    offering_name: offering.name.to_string(),
                    category: category_from_str(offering.category),
                    description: Some(offering.description.to_string()),
                    tiers: vec![TierSummary {
                        tier_id: "default".into(),
                        name: "Default".into(),
                        price_display,
                    }],
                    regions: vec![],
                    payment_methods: if offering.free_tier {
                        vec!["free".into(), "sardis_wallet".into()]
                    } else {
                        vec!["sardis_wallet".into()]
                    },
                    trust_tier_required: 0,
                    source: DiscoverySource::Curated,
                });
            }

            if results.len() >= max_results {
                return results;
            }
        }
    }

    results
}

fn category_from_str(s: &str) -> ServiceCategory {
    match s {
        "database" => ServiceCategory::Database,
        "hosting" => ServiceCategory::Hosting,
        "auth" => ServiceCategory::Auth,
        "analytics" => ServiceCategory::Analytics,
        "storage" => ServiceCategory::Storage,
        "compute" => ServiceCategory::Compute,
        "messaging" => ServiceCategory::Messaging,
        "monitoring" => ServiceCategory::Monitoring,
        "search" => ServiceCategory::Search,
        "ai" => ServiceCategory::Ai,
        "email" => ServiceCategory::Email,
        _ => ServiceCategory::Other,
    }
}

fn urlencoding(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
                vec![c]
            } else {
                format!("%{:02X}", c as u32).chars().collect()
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curated_providers_is_non_empty() {
        let providers = curated_providers();
        assert!(!providers.is_empty());
    }

    #[test]
    fn search_curated_finds_database_providers() {
        let results = search_curated("", Some("database"), None, 20);
        assert!(!results.is_empty());
        for r in &results {
            assert!(matches!(r.category, ServiceCategory::Database));
        }
    }

    #[test]
    fn search_curated_keyword_matches_provider_name() {
        let results = search_curated("supabase", None, None, 10);
        assert!(!results.is_empty());
        assert!(results.iter().any(|r| r.provider_id == "supabase.com"));
    }

    #[test]
    fn search_curated_keyword_matches_category() {
        let results = search_curated("email", None, None, 10);
        assert!(!results.is_empty());
        assert!(results.iter().any(|r| matches!(r.category, ServiceCategory::Email)));
    }

    #[test]
    fn search_curated_free_filter_excludes_paid_only() {
        let all = search_curated("", None, None, 100);
        let free_only = search_curated("", None, Some("free"), 100);
        assert!(free_only.len() <= all.len());
        for r in &free_only {
            let provider = curated_providers()
                .into_iter()
                .find(|p| p.domain == r.provider_id)
                .unwrap();
            let offering = provider.offerings.iter()
                .find(|o| o.offering_id == r.offering_id.as_str())
                .unwrap();
            assert!(offering.free_tier, "Expected free_tier=true for {}", r.offering_id);
        }
    }

    #[test]
    fn search_curated_respects_max_results() {
        let results = search_curated("", None, None, 2);
        assert!(results.len() <= 2);
    }

    #[test]
    fn urlencoding_encodes_spaces() {
        assert!(urlencoding("hello world").contains('%'));
    }

    #[test]
    fn urlencoding_leaves_alphanumeric_unchanged() {
        assert_eq!(urlencoding("postgres"), "postgres");
    }

    #[test]
    fn discovery_result_serializes_to_json() {
        let result = DiscoveryResult {
            provider_id: "supabase.com".into(),
            display_name: "Supabase".into(),
            offering_id: "supabase.com/postgres".into(),
            offering_name: "Postgres".into(),
            category: ServiceCategory::Database,
            description: Some("Managed PostgreSQL".into()),
            tiers: vec![TierSummary {
                tier_id: "free".into(),
                name: "Free".into(),
                price_display: "Free tier available".into(),
            }],
            regions: vec!["us-east-1".into()],
            payment_methods: vec!["free".into()],
            trust_tier_required: 0,
            source: DiscoverySource::Curated,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("supabase.com"));
        // ServiceCategory::Database serializes as "database" (snake_case)
        assert!(json.contains("database"));
    }
}
