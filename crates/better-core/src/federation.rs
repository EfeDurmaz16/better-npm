// crates/better-core/src/federation.rs
//
// Registry federation — resolve packages across multiple registries in
// priority order with scope matching (v1.3 Task 103).
//
// The resolver selects which registry to try first; actual network I/O is
// handled by the caller via the `try_resolve` callback pattern.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationConfig {
    pub registries: Vec<FedRegistryEntry>,
}

impl Default for FederationConfig {
    fn default() -> Self {
        Self {
            registries: vec![FedRegistryEntry {
                name: "npm-public".to_string(),
                url: "https://registry.npmjs.org".to_string(),
                registry_type: RegistryKind::Npm,
                priority: 10,
                scopes: vec![],
                auth_token: None,
                enabled: true,
            }],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FedRegistryEntry {
    pub name: String,
    pub url: String,
    pub registry_type: RegistryKind,
    /// Lower number = tried first
    pub priority: u32,
    /// Scope prefixes this registry handles, e.g. `["@mycompany"]`.
    /// Empty = handles all packages.
    pub scopes: Vec<String>,
    pub auth_token: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RegistryKind {
    Npm,
    Packagist,
    PyPI,
    NuGet,
    CratesIo,
    BetterNative,
    OspRegistry,
}

// ---------------------------------------------------------------------------
// Resolution result
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct FedResolutionPlan {
    /// Ordered list of registries to attempt, with reason why each was selected
    pub candidates: Vec<FedCandidate>,
    /// Names of registries that were skipped (disabled or scope mismatch)
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FedCandidate {
    pub registry_name: String,
    pub registry_url: String,
    pub auth_token: Option<String>,
    pub match_reason: MatchReason,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchReason {
    ScopeMatch { scope: String },
    FallbackAll,
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/// Builds a resolution plan for `package_name` against the configured registries.
///
/// Returns an ordered list of registries to try (priority-sorted), with
/// scope-matched registries first.
pub fn plan_resolution(
    config: &FederationConfig,
    package_name: &str,
) -> FedResolutionPlan {
    let mut enabled: Vec<&FedRegistryEntry> = config.registries.iter()
        .filter(|r| r.enabled)
        .collect();
    enabled.sort_by_key(|r| r.priority);

    let mut candidates: Vec<FedCandidate> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    // First pass: scope-matched registries
    for reg in &enabled {
        if !reg.scopes.is_empty() {
            let matched = reg.scopes.iter().find(|scope| {
                let prefix = scope.trim_end_matches("/*").trim_end_matches('/');
                package_name == prefix || package_name.starts_with(&format!("{}/", prefix))
            });
            if let Some(scope) = matched {
                candidates.push(FedCandidate {
                    registry_name: reg.name.clone(),
                    registry_url: reg.url.clone(),
                    auth_token: reg.auth_token.clone(),
                    match_reason: MatchReason::ScopeMatch { scope: scope.clone() },
                });
            }
        }
    }

    // Second pass: catch-all registries (empty scopes = handles all packages)
    for reg in &enabled {
        if reg.scopes.is_empty() {
            // Only add if not already added by scope match
            if !candidates.iter().any(|c| c.registry_name == reg.name) {
                candidates.push(FedCandidate {
                    registry_name: reg.name.clone(),
                    registry_url: reg.url.clone(),
                    auth_token: reg.auth_token.clone(),
                    match_reason: MatchReason::FallbackAll,
                });
            }
        }
    }

    // Disabled registries
    for reg in config.registries.iter().filter(|r| !r.enabled) {
        skipped.push(reg.name.clone());
    }

    FedResolutionPlan { candidates, skipped }
}

/// Check which registry a scoped package belongs to.
///
/// Returns the first enabled registry whose scopes contain `package_name`,
/// or the default (first enabled) registry if none match.
pub fn registry_for<'a>(config: &'a FederationConfig, package_name: &str) -> Option<&'a FedRegistryEntry> {
    let plan = plan_resolution(config, package_name);
    let name = plan.candidates.first().map(|c| c.registry_name.as_str())?;
    config.registries.iter().find(|r| r.name == name)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config() -> FederationConfig {
        FederationConfig {
            registries: vec![
                FedRegistryEntry {
                    name: "private".to_string(),
                    url: "https://registry.mycompany.com".to_string(),
                    registry_type: RegistryKind::Npm,
                    priority: 1,
                    scopes: vec!["@mycompany".to_string()],
                    auth_token: Some("token123".to_string()),
                    enabled: true,
                },
                FedRegistryEntry {
                    name: "npmjs".to_string(),
                    url: "https://registry.npmjs.org".to_string(),
                    registry_type: RegistryKind::Npm,
                    priority: 10,
                    scopes: vec![],
                    auth_token: None,
                    enabled: true,
                },
                FedRegistryEntry {
                    name: "disabled-reg".to_string(),
                    url: "https://disabled.example.com".to_string(),
                    registry_type: RegistryKind::Npm,
                    priority: 5,
                    scopes: vec![],
                    auth_token: None,
                    enabled: false,
                },
            ],
        }
    }

    #[test]
    fn scoped_package_routed_to_private_registry() {
        let config = make_config();
        let plan = plan_resolution(&config, "@mycompany/utils");
        assert!(!plan.candidates.is_empty());
        assert_eq!(plan.candidates[0].registry_name, "private");
        assert!(matches!(plan.candidates[0].match_reason, MatchReason::ScopeMatch { .. }));
    }

    #[test]
    fn public_package_routed_to_npmjs() {
        let config = make_config();
        let plan = plan_resolution(&config, "lodash");
        // lodash doesn't match @mycompany scope → falls back to npmjs
        let npmjs = plan.candidates.iter().find(|c| c.registry_name == "npmjs");
        assert!(npmjs.is_some());
        assert!(matches!(npmjs.unwrap().match_reason, MatchReason::FallbackAll));
    }

    #[test]
    fn disabled_registry_skipped() {
        let config = make_config();
        let plan = plan_resolution(&config, "express");
        assert!(plan.skipped.contains(&"disabled-reg".to_string()));
        assert!(!plan.candidates.iter().any(|c| c.registry_name == "disabled-reg"));
    }

    #[test]
    fn priority_ordering_respected() {
        let mut config = make_config();
        // Add another catch-all at lower priority
        config.registries.push(FedRegistryEntry {
            name: "backup".to_string(),
            url: "https://backup.registry.com".to_string(),
            registry_type: RegistryKind::Npm,
            priority: 99,
            scopes: vec![],
            auth_token: None,
            enabled: true,
        });
        let plan = plan_resolution(&config, "react");
        // npmjs (priority 10) should come before backup (priority 99)
        let npmjs_pos = plan.candidates.iter().position(|c| c.registry_name == "npmjs");
        let backup_pos = plan.candidates.iter().position(|c| c.registry_name == "backup");
        if let (Some(a), Some(b)) = (npmjs_pos, backup_pos) {
            assert!(a < b);
        }
    }

    #[test]
    fn auth_token_propagated() {
        let config = make_config();
        let plan = plan_resolution(&config, "@mycompany/core");
        let private = plan.candidates.iter().find(|c| c.registry_name == "private").unwrap();
        assert_eq!(private.auth_token.as_deref(), Some("token123"));
    }

    #[test]
    fn registry_for_scoped_pkg() {
        let config = make_config();
        let reg = registry_for(&config, "@mycompany/api").unwrap();
        assert_eq!(reg.name, "private");
    }

    #[test]
    fn empty_config_returns_empty_plan() {
        let config = FederationConfig { registries: vec![] };
        let plan = plan_resolution(&config, "express");
        assert!(plan.candidates.is_empty());
        assert!(plan.skipped.is_empty());
    }

    #[test]
    fn registry_for_unscoped_pkg_returns_none_when_all_registries_have_scopes() {
        let config = FederationConfig {
            registries: vec![FedRegistryEntry {
                name: "scoped-only".to_string(),
                url: "https://registry.example.com".to_string(),
                registry_type: RegistryKind::Npm,
                priority: 1,
                scopes: vec!["@internal".to_string()],
                auth_token: None,
                enabled: true,
            }],
        };
        // An unscoped package should not match a registry that only handles @internal
        let reg = registry_for(&config, "lodash");
        assert!(reg.is_none());
    }
}
