use std::fs;
use std::path::{Path, PathBuf};

use crate::types::NpmrcConfig;

// === D.1: .npmrc parser + auth token injection ===

pub fn parse_npmrc(project_root: &Path) -> NpmrcConfig {
    let mut config = NpmrcConfig::default();
    if let Ok(reg) = std::env::var("NPM_CONFIG_REGISTRY") {
        config.default_registry = reg;
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let candidates = [
        project_root.join(".npmrc"),
        PathBuf::from(&home).join(".npmrc"),
    ];
    for path in &candidates {
        if let Ok(content) = fs::read_to_string(path) {
            parse_npmrc_content(&content, &mut config);
        }
    }
    for (key, value) in std::env::vars() {
        let lower = key.to_lowercase();
        if lower.starts_with("npm_config_") {
            let suffix = &key["npm_config_".len()..];
            if suffix.starts_with("//") && suffix.to_lowercase().ends_with(":_authtoken") {
                let host = &suffix[2..suffix.len() - ":_authtoken".len()];
                config.auth_tokens.push((host.to_string(), value));
            }
        }
    }
    config
}

fn parse_npmrc_content(content: &str, config: &mut NpmrcConfig) {
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(eq_pos) = line.find('=') {
            let key = line[..eq_pos].trim();
            let value = line[eq_pos + 1..].trim().to_string();
            if key == "registry" {
                config.default_registry = value;
            } else if key.starts_with("//") && key.ends_with(":_authToken") {
                let host = &key[2..key.len() - ":_authToken".len()];
                config.auth_tokens.push((host.to_string(), value));
            } else if key.starts_with('@') && key.ends_with(":registry") {
                let scope = &key[..key.len() - ":registry".len()];
                config.scoped_registries.push((scope.to_string(), value));
            }
        }
    }
}

pub fn registry_for_package<'a>(config: &'a NpmrcConfig, package_name: &str) -> (&'a str, Option<&'a str>) {
    if package_name.starts_with('@') {
        if let Some(slash) = package_name.find('/') {
            let scope = &package_name[..slash];
            for (s, url) in &config.scoped_registries {
                if s == scope {
                    let token = find_auth_token(config, url);
                    return (url, token);
                }
            }
        }
    }
    let token = find_auth_token(config, &config.default_registry);
    (&config.default_registry, token)
}

fn find_auth_token<'a>(config: &'a NpmrcConfig, registry_url: &str) -> Option<&'a str> {
    let host = registry_url
        .strip_prefix("https://")
        .or_else(|| registry_url.strip_prefix("http://"))
        .unwrap_or(registry_url)
        .trim_end_matches('/');
    for (token_host, token) in &config.auth_tokens {
        let th = token_host.trim_end_matches('/');
        if host == th || host.ends_with(th) {
            return Some(token);
        }
    }
    None
}

