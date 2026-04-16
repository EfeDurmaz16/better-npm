use std::fs;
use std::path::PathBuf;

use crate::{extract_json_field, extract_json_number, JsonWriter};

// === Multi-registry resolution with scoped routing ===

#[derive(Debug, Clone)]
pub struct RegistryEntry {
    pub url: String,
    pub scope: Option<String>,
    pub token_env: Option<String>,
    pub priority: u64,
}

#[derive(Debug, Clone)]
pub struct RegistryConfig {
    pub registries: Vec<RegistryEntry>,
}

impl Default for RegistryConfig {
    fn default() -> Self {
        Self {
            registries: vec![RegistryEntry {
                url: "https://registry.npmjs.org".to_string(),
                scope: None,
                token_env: None,
                priority: 10,
            }],
        }
    }
}

fn registries_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".better").join("registries.json")
}

/// Load registry config from ~/.better/registries.json
pub fn load_registry_config() -> RegistryConfig {
    let path = registries_path();
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return RegistryConfig::default(),
    };
    parse_registries_json(&content)
}

fn parse_registries_json(json: &str) -> RegistryConfig {
    // Find "registries" array
    let needle = "\"registries\"";
    let start = match json.find(needle) {
        Some(pos) => pos,
        None => return RegistryConfig::default(),
    };
    let after = &json[start + needle.len()..];
    let arr_start = match after.find('[') {
        Some(pos) => pos,
        None => return RegistryConfig::default(),
    };
    let section = &after[arr_start..];

    let mut registries = Vec::new();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut entry_buf = String::new();
    let mut collecting = false;

    for ch in section.chars() {
        if esc {
            if collecting { entry_buf.push(ch); }
            esc = false;
            continue;
        }
        if ch == '\\' && in_str {
            esc = true;
            if collecting { entry_buf.push(ch); }
            continue;
        }
        if ch == '"' {
            in_str = !in_str;
            if collecting { entry_buf.push(ch); }
            continue;
        }
        if in_str {
            if collecting { entry_buf.push(ch); }
            continue;
        }
        match ch {
            '[' => {
                depth += 1;
            }
            ']' => {
                depth -= 1;
                if depth == 0 { break; }
            }
            '{' if depth == 1 => {
                collecting = true;
                entry_buf.clear();
            }
            '}' if depth == 1 && collecting => {
                collecting = false;
                if let Some(entry) = parse_registry_entry(&entry_buf) {
                    registries.push(entry);
                }
                entry_buf.clear();
            }
            _ => {
                if collecting { entry_buf.push(ch); }
            }
        }
    }

    if registries.is_empty() {
        return RegistryConfig::default();
    }

    // Sort by priority (lower = higher priority)
    registries.sort_by_key(|r| r.priority);

    RegistryConfig { registries }
}

fn parse_registry_entry(entry_json: &str) -> Option<RegistryEntry> {
    let url = extract_json_field(entry_json, "url")?;
    let scope = extract_json_field(entry_json, "scope");
    let token_env = extract_json_field(entry_json, "token_env");
    let priority = extract_json_number(entry_json, "priority").unwrap_or(10);
    Some(RegistryEntry {
        url,
        scope,
        token_env,
        priority,
    })
}

/// Resolve which registry to use for a given package name.
/// Returns (registry_url, optional_auth_token).
pub fn resolve_registry(config: &RegistryConfig, package_name: &str) -> (String, Option<String>) {
    // For scoped packages, check scope-matched registries first (sorted by priority)
    if package_name.starts_with('@') {
        if let Some(slash) = package_name.find('/') {
            let scope = &package_name[..slash];
            for entry in &config.registries {
                if let Some(ref entry_scope) = entry.scope {
                    if entry_scope == scope {
                        let token = entry.token_env.as_ref().and_then(|env_var| std::env::var(env_var).ok());
                        return (entry.url.clone(), token);
                    }
                }
            }
        }
    }

    // Fall back to the default (no-scope) registry with lowest priority number
    for entry in &config.registries {
        if entry.scope.is_none() {
            let token = entry.token_env.as_ref().and_then(|env_var| std::env::var(env_var).ok());
            return (entry.url.clone(), token);
        }
    }

    // Ultimate fallback
    ("https://registry.npmjs.org".to_string(), None)
}

/// Add a registry entry to ~/.better/registries.json
pub fn registry_add(url: &str, scope: Option<&str>, token_env: Option<&str>, priority: Option<u64>) -> Result<String, String> {
    let mut config = load_registry_config();

    let new_priority = priority.unwrap_or(5);

    // Remove existing entry with same URL + scope combo
    config.registries.retain(|r| !(r.url == url && r.scope.as_deref() == scope));

    config.registries.push(RegistryEntry {
        url: url.to_string(),
        scope: scope.map(|s| s.to_string()),
        token_env: token_env.map(|t| t.to_string()),
        priority: new_priority,
    });

    // Sort by priority
    config.registries.sort_by_key(|r| r.priority);

    write_registry_config(&config)?;
    Ok(registries_path().to_string_lossy().to_string())
}

/// List all configured registries
pub fn registry_list() -> Result<RegistryConfig, String> {
    Ok(load_registry_config())
}

/// Remove a registry by URL
pub fn registry_remove(url: &str) -> Result<u64, String> {
    let mut config = load_registry_config();
    let before = config.registries.len();
    config.registries.retain(|r| r.url != url);
    let removed = (before - config.registries.len()) as u64;

    if removed == 0 {
        return Err(format!("No registry found with URL: {}", url));
    }

    // Don't allow removing all registries — keep default
    if config.registries.is_empty() {
        config.registries.push(RegistryEntry {
            url: "https://registry.npmjs.org".to_string(),
            scope: None,
            token_env: None,
            priority: 10,
        });
    }

    write_registry_config(&config)?;
    Ok(removed)
}

/// Rotate (invalidate) token for a scoped registry.
/// This clears the token_env so the user must re-authenticate.
pub fn registry_rotate(scope: Option<&str>) -> Result<String, String> {
    let mut config = load_registry_config();
    let mut rotated = false;

    for entry in &mut config.registries {
        let matches = match (scope, &entry.scope) {
            (Some(s), Some(es)) => es == s,
            (None, None) => true,
            _ => false,
        };
        if matches && entry.token_env.is_some() {
            // Clear the token_env reference — user must set a new env var
            let old_env = entry.token_env.take();
            rotated = true;
            if let Some(env_name) = old_env {
                // Return the env var name that was cleared for informational purposes
                write_registry_config(&config)?;
                return Ok(format!("Rotated: cleared token_env '{}'. Set a new token and run `better registry add` to re-configure.", env_name));
            }
        }
    }

    if !rotated {
        return Err("No matching registry with token_env found to rotate".to_string());
    }

    write_registry_config(&config)?;
    Ok("Token reference cleared. Re-authenticate with `better registry add`.".to_string())
}

// === Registry failover chain ===

/// A chain of registries with failover support.
pub struct RegistryChain {
    /// Ordered list of registry URLs to try
    registries: Vec<String>,
    /// Current healthy registry index
    current: std::sync::atomic::AtomicUsize,
}

impl RegistryChain {
    pub fn new(primary: &str) -> Self {
        let mirrors = get_mirrors_for(primary);
        let mut registries = vec![primary.to_string()];
        registries.extend(mirrors);
        Self {
            registries,
            current: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    pub fn from_config(urls: Vec<String>) -> Self {
        Self {
            registries: urls,
            current: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Get the currently active registry URL.
    pub fn active(&self) -> &str {
        let idx = self.current.load(std::sync::atomic::Ordering::Relaxed);
        &self.registries[idx.min(self.registries.len() - 1)]
    }

    /// Mark the current registry as failed and try the next one.
    pub fn failover(&self) -> Option<&str> {
        let idx = self.current.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let next = idx + 1;
        if next < self.registries.len() {
            Some(&self.registries[next])
        } else {
            None
        }
    }

    /// Reset to primary registry.
    pub fn reset(&self) {
        self.current.store(0, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Get known mirrors for a registry.
fn get_mirrors_for(registry: &str) -> Vec<String> {
    if registry.contains("registry.npmjs.org") {
        vec![
            "https://registry.npmmirror.com".to_string(),
            "https://npm.pkg.github.com".to_string(),
        ]
    } else {
        vec![]
    }
}

fn write_registry_config(config: &RegistryConfig) -> Result<(), String> {
    let path = registries_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create ~/.better directory: {}", e))?;
    }

    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("registries");
    w.begin_array();
    for entry in &config.registries {
        w.begin_object();
        w.key("url");
        w.value_string(&entry.url);
        if let Some(ref scope) = entry.scope {
            w.key("scope");
            w.value_string(scope);
        } else {
            w.key("scope");
            w.value_null();
        }
        if let Some(ref token_env) = entry.token_env {
            w.key("token_env");
            w.value_string(token_env);
        }
        w.key("priority");
        w.value_u64(entry.priority);
        w.end_object();
    }
    w.end_array();
    w.end_object();
    w.out.push('\n');

    fs::write(&path, w.finish())
        .map_err(|e| format!("Failed to write registries.json: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config(entries: &[(&str, Option<&str>)]) -> RegistryConfig {
        RegistryConfig {
            registries: entries.iter().enumerate().map(|(i, (url, scope))| RegistryEntry {
                url: url.to_string(),
                scope: scope.map(|s| s.to_string()),
                token_env: None,
                priority: (i as u64 + 1) * 10,
            }).collect(),
        }
    }

    #[test]
    fn resolve_registry_public_package_uses_default() {
        let config = make_config(&[
            ("https://registry.npmjs.org", None),
        ]);
        let (url, _) = resolve_registry(&config, "lodash");
        assert_eq!(url, "https://registry.npmjs.org");
    }

    #[test]
    fn resolve_registry_scoped_package_uses_scope_registry() {
        let config = make_config(&[
            ("https://registry.mycompany.com", Some("@mycompany")),
            ("https://registry.npmjs.org", None),
        ]);
        let (url, _) = resolve_registry(&config, "@mycompany/utils");
        assert_eq!(url, "https://registry.mycompany.com");
    }

    #[test]
    fn resolve_registry_unknown_scope_falls_back_to_default() {
        let config = make_config(&[
            ("https://registry.mycompany.com", Some("@mycompany")),
            ("https://registry.npmjs.org", None),
        ]);
        let (url, _) = resolve_registry(&config, "@other/pkg");
        assert_eq!(url, "https://registry.npmjs.org");
    }

    #[test]
    fn registry_chain_active_returns_primary() {
        let chain = RegistryChain::new("https://registry.npmjs.org");
        assert_eq!(chain.active(), "https://registry.npmjs.org");
    }

    #[test]
    fn registry_chain_failover_advances_to_mirror() {
        let chain = RegistryChain::new("https://registry.npmjs.org");
        let next = chain.failover();
        assert!(next.is_some());
        assert_ne!(chain.active(), "https://registry.npmjs.org");
    }

    #[test]
    fn registry_chain_reset_returns_to_primary() {
        let chain = RegistryChain::new("https://registry.npmjs.org");
        chain.failover();
        chain.reset();
        assert_eq!(chain.active(), "https://registry.npmjs.org");
    }

    #[test]
    fn registry_entry_with_no_scope_matches_any_package() {
        let config = make_config(&[("https://registry.npmjs.org", None)]);
        // Both scoped and non-scoped packages fall through to default
        let (url1, _) = resolve_registry(&config, "lodash");
        let (url2, _) = resolve_registry(&config, "@scope/pkg");
        assert_eq!(url1, url2);
    }

    #[test]
    fn registry_config_multiple_scopes_resolved_correctly() {
        let config = make_config(&[
            ("https://registry.a.com", Some("@aa")),
            ("https://registry.b.com", Some("@bb")),
            ("https://registry.npmjs.org", None),
        ]);
        let (url_a, _) = resolve_registry(&config, "@aa/pkg");
        let (url_b, _) = resolve_registry(&config, "@bb/pkg");
        assert_eq!(url_a, "https://registry.a.com");
        assert_eq!(url_b, "https://registry.b.com");
    }
}
