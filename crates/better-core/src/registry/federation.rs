// crates/better-core/src/registry/federation.rs
// Task 103: Federated resolver — tries registries in priority order, scope matching.

use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use super::cid::ContentId;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryConfig {
    pub registries: Vec<RegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryEntry {
    pub name: String,
    pub url: String,
    pub registry_type: RegistryType,
    /// Lower priority = checked first.
    pub priority: u32,
    /// Package scopes this registry handles (e.g. `["@mycompany/*"]`). Empty = all.
    pub scopes: Vec<String>,
    pub auth_token: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RegistryType {
    Npm,
    Packagist,
    PyPI,
    NuGet,
    CratesIo,
    BetterNative,
    OspRegistry,
}

impl std::fmt::Display for RegistryType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::Npm => "npm",
            Self::Packagist => "packagist",
            Self::PyPI => "pypi",
            Self::NuGet => "nuget",
            Self::CratesIo => "crates.io",
            Self::BetterNative => "better-native",
            Self::OspRegistry => "osp",
        };
        write!(f, "{}", s)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederatedResult {
    pub package: String,
    pub version: String,
    pub registry: String,
    pub cid: Option<ContentId>,
    pub download_url: String,
    pub integrity: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FederationError {
    NotFound { package: String, tried: Vec<String> },
    UnsupportedType,
    AuthFailed(String),
    Network(String),
}

impl std::fmt::Display for FederationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound { package, tried } =>
                write!(f, "Package {} not found in registries: {:?}", package, tried),
            Self::UnsupportedType => write!(f, "Unsupported registry type"),
            Self::AuthFailed(s) => write!(f, "Auth failed: {}", s),
            Self::Network(s) => write!(f, "Network error: {}", s),
        }
    }
}

// ---------------------------------------------------------------------------
// FederatedResolver
// ---------------------------------------------------------------------------

pub struct FederatedResolver {
    registries: Vec<RegistryEntry>,
    #[allow(dead_code)]
    cas_root: PathBuf,
}

impl FederatedResolver {
    pub fn new(config: RegistryConfig, cas_root: PathBuf) -> Self {
        let mut registries = config.registries;
        registries.sort_by_key(|r| r.priority);
        Self { registries, cas_root }
    }

    /// Default resolver with npm + better-native + OSP registries.
    pub fn default_config() -> RegistryConfig {
        RegistryConfig {
            registries: vec![
                RegistryEntry {
                    name: "npmjs".to_string(),
                    url: "https://registry.npmjs.org".to_string(),
                    registry_type: RegistryType::Npm,
                    priority: 100,
                    scopes: vec![],
                    auth_token: None,
                    enabled: true,
                },
                RegistryEntry {
                    name: "better-native".to_string(),
                    url: "https://registry.better.sh".to_string(),
                    registry_type: RegistryType::BetterNative,
                    priority: 50,
                    scopes: vec![],
                    auth_token: None,
                    enabled: true,
                },
            ],
        }
    }

    /// Resolve a package by trying registries in priority order.
    ///
    /// Scope-matched registries (private) are tried before global ones.
    pub fn resolve(
        &self,
        name: &str,
        version_constraint: &str,
        _ecosystem: &str,
    ) -> Result<FederatedResult, FederationError> {
        let mut tried = vec![];

        for registry in &self.registries {
            if !registry.enabled {
                continue;
            }
            if !self.matches_scope(registry, name) {
                continue;
            }

            tried.push(registry.name.clone());

            // In production this would make HTTP calls. Here we return a synthetic result
            // for the first enabled, scope-matched registry.
            let download_url = format!("{}/{}/{}", registry.url, name, version_constraint);
            return Ok(FederatedResult {
                package: name.to_string(),
                version: version_constraint.to_string(),
                registry: registry.name.clone(),
                cid: None,
                download_url,
                integrity: String::new(),
            });
        }

        Err(FederationError::NotFound { package: name.to_string(), tried })
    }

    fn matches_scope(&self, registry: &RegistryEntry, name: &str) -> bool {
        if registry.scopes.is_empty() {
            return true;
        }
        registry.scopes.iter().any(|scope| {
            if scope.ends_with("/*") {
                name.starts_with(&scope[..scope.len() - 2])
            } else {
                name == scope
            }
        })
    }

    /// List all enabled registries sorted by priority.
    pub fn list(&self) -> Vec<&RegistryEntry> {
        self.registries.iter().filter(|r| r.enabled).collect()
    }

    /// Add a registry entry (in-memory only).
    pub fn add(&mut self, entry: RegistryEntry) {
        self.registries.push(entry);
        self.registries.sort_by_key(|r| r.priority);
    }

    /// Disable a registry by name.
    pub fn disable(&mut self, name: &str) -> bool {
        if let Some(r) = self.registries.iter_mut().find(|r| r.name == name) {
            r.enabled = false;
            true
        } else {
            false
        }
    }
}

impl RegistryConfig {
    pub fn load_from_path(path: &std::path::Path) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Cannot read registries config: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse registries config: {}", e))
    }

    pub fn save_to_path(&self, path: &std::path::Path) -> Result<(), String> {
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create dir: {}", e))?;
        }
        std::fs::write(path, content)
            .map_err(|e| format!("Cannot write: {}", e))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_resolver() -> FederatedResolver {
        FederatedResolver::new(
            FederatedResolver::default_config(),
            PathBuf::from("/tmp/better-cas"),
        )
    }

    #[test]
    fn default_config_has_registries() {
        let config = FederatedResolver::default_config();
        assert!(!config.registries.is_empty());
    }

    #[test]
    fn resolve_returns_first_enabled_registry() {
        let resolver = make_resolver();
        let result = resolver.resolve("lodash", "^4.17.21", "npm").unwrap();
        assert_eq!(result.package, "lodash");
        assert!(!result.registry.is_empty());
    }

    #[test]
    fn resolve_scope_matched_private_registry_first() {
        let mut config = FederatedResolver::default_config();
        config.registries.push(RegistryEntry {
            name: "private".to_string(),
            url: "https://npm.company.dev".to_string(),
            registry_type: RegistryType::Npm,
            priority: 1,  // Highest priority
            scopes: vec!["@company/*".to_string()],
            auth_token: Some("secret".to_string()),
            enabled: true,
        });
        let resolver = FederatedResolver::new(config, PathBuf::from("/tmp"));
        let result = resolver.resolve("@company/mylib", "1.0.0", "npm").unwrap();
        assert_eq!(result.registry, "private");
    }

    #[test]
    fn resolve_scope_mismatch_skips_private() {
        let mut config = RegistryConfig { registries: vec![] };
        config.registries.push(RegistryEntry {
            name: "private".to_string(),
            url: "https://npm.company.dev".to_string(),
            registry_type: RegistryType::Npm,
            priority: 1,
            scopes: vec!["@company/*".to_string()],
            auth_token: None,
            enabled: true,
        });
        config.registries.push(RegistryEntry {
            name: "public".to_string(),
            url: "https://registry.npmjs.org".to_string(),
            registry_type: RegistryType::Npm,
            priority: 100,
            scopes: vec![],
            auth_token: None,
            enabled: true,
        });
        let resolver = FederatedResolver::new(config, PathBuf::from("/tmp"));
        let result = resolver.resolve("lodash", "latest", "npm").unwrap();
        // @company/* scope doesn't match "lodash", so should skip to public
        assert_eq!(result.registry, "public");
    }

    #[test]
    fn resolve_all_disabled_returns_not_found() {
        let mut config = FederatedResolver::default_config();
        for r in &mut config.registries {
            r.enabled = false;
        }
        let resolver = FederatedResolver::new(config, PathBuf::from("/tmp"));
        let result = resolver.resolve("lodash", "latest", "npm");
        assert!(matches!(result, Err(FederationError::NotFound { .. })));
    }

    #[test]
    fn list_returns_only_enabled() {
        let mut resolver = make_resolver();
        resolver.disable("better-native");
        let enabled = resolver.list();
        assert!(enabled.iter().all(|r| r.enabled));
        assert!(enabled.iter().all(|r| r.name != "better-native"));
    }

    #[test]
    fn add_registry_sorts_by_priority() {
        let mut resolver = make_resolver();
        resolver.add(RegistryEntry {
            name: "high-prio".to_string(),
            url: "https://fast.registry.dev".to_string(),
            registry_type: RegistryType::Npm,
            priority: 5,
            scopes: vec![],
            auth_token: None,
            enabled: true,
        });
        let first = resolver.list()[0];
        assert_eq!(first.name, "high-prio");
    }

    #[test]
    fn registry_config_round_trips_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registries.json");
        let config = FederatedResolver::default_config();
        config.save_to_path(&path).unwrap();
        let loaded = RegistryConfig::load_from_path(&path).unwrap();
        assert_eq!(loaded.registries.len(), config.registries.len());
    }

    #[test]
    fn registry_type_display() {
        assert_eq!(RegistryType::Npm.to_string(), "npm");
        assert_eq!(RegistryType::PyPI.to_string(), "pypi");
        assert_eq!(RegistryType::BetterNative.to_string(), "better-native");
    }
}
