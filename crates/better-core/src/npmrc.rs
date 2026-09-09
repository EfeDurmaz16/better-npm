use std::fs;
use std::path::{Path, PathBuf};

use crate::types::NpmrcConfig;

// === D.1: .npmrc parser + auth token injection ===

pub fn parse_npmrc(project_root: &Path) -> NpmrcConfig {
    let mut config = NpmrcConfig::default();
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let candidates = [
        PathBuf::from(&home).join(".npmrc"),
        project_root.join(".npmrc"),
    ];
    for path in &candidates {
        if let Ok(content) = fs::read_to_string(path) {
            parse_npmrc_content(&content, &mut config);
        }
    }
    if let Ok(reg) = std::env::var("NPM_CONFIG_REGISTRY") {
        config.default_registry = reg;
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

pub fn registry_for_package<'a>(
    config: &'a NpmrcConfig,
    package_name: &str,
) -> (&'a str, Option<&'a str>) {
    if package_name.starts_with('@') {
        if let Some(slash) = package_name.find('/') {
            let scope = &package_name[..slash];
            for (s, url) in config.scoped_registries.iter().rev() {
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

/// Select credentials for the actual request destination, including path scope.
/// Longest matching path wins; later configuration wins ties.
pub(crate) fn find_auth_token<'a>(config: &'a NpmrcConfig, destination: &str) -> Option<&'a str> {
    let url = reqwest::Url::parse(destination).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    // An HTTPS registry token must not be downgraded by an initial lockfile URL.
    // Plain HTTP auth requires an explicitly configured HTTP registry covering
    // this destination; a scheme-less auth scope alone is not that permission.
    if url.scheme() == "http"
        && !std::iter::once(&config.default_registry)
            .chain(
                config
                    .scoped_registries
                    .iter()
                    .map(|(_, registry)| registry),
            )
            .filter_map(|registry| reqwest::Url::parse(registry).ok())
            .any(|registry| {
                let prefix = registry.path().trim_end_matches('/');
                registry.scheme() == "http"
                    && registry.host_str() == url.host_str()
                    && registry.port_or_known_default() == url.port_or_known_default()
                    && (url.path() == prefix
                        || url
                            .path()
                            .strip_prefix(prefix)
                            .is_some_and(|suffix| suffix.starts_with('/')))
            })
    {
        return None;
    }
    // Do not authenticate ambiguous encoded path separators/dot segments: servers
    // can normalize these differently from the URL parser.
    let path = url.path().to_ascii_lowercase();
    if ["%2f", "%5c", "%2e"].iter().any(|part| path.contains(part)) {
        return None;
    }
    let mut best: Option<(usize, &str)> = None;
    for (scope, token) in &config.auth_tokens {
        let Ok(scope) = reqwest::Url::parse(&format!("{}://{}", url.scheme(), scope)) else {
            continue;
        };
        if scope.host_str() != url.host_str()
            || scope.port_or_known_default() != url.port_or_known_default()
            || !scope.username().is_empty()
            || scope.password().is_some()
            || scope.query().is_some()
            || scope.fragment().is_some()
        {
            continue;
        }
        let prefix = scope.path().trim_end_matches('/');
        if url.path() == prefix
            || url
                .path()
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with('/'))
        {
            if best.is_none_or(|(length, _)| prefix.len() >= length) {
                best = Some((prefix.len(), token.as_str()));
            }
        }
    }
    best.map(|(_, token)| token)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::NpmrcConfig;
    use std::io::Write;

    fn config_from(npmrc: &str) -> NpmrcConfig {
        let mut c = NpmrcConfig::default();
        parse_npmrc_content(npmrc, &mut c);
        c
    }

    #[test]
    fn parse_registry_line() {
        let c = config_from("registry=https://my.registry.com/\n");
        assert_eq!(c.default_registry, "https://my.registry.com/");
    }

    #[test]
    fn parse_scoped_registry() {
        let c = config_from("@myco:registry=https://registry.myco.com/\n");
        assert_eq!(c.scoped_registries.len(), 1);
        assert_eq!(c.scoped_registries[0].0, "@myco");
        assert_eq!(c.scoped_registries[0].1, "https://registry.myco.com/");
    }

    #[test]
    fn parse_auth_token() {
        let c = config_from("//registry.npmjs.org/:_authToken=abc123\n");
        assert_eq!(c.auth_tokens.len(), 1);
        assert_eq!(c.auth_tokens[0].1, "abc123");
    }

    #[test]
    fn registry_for_scoped_pkg_returns_scoped() {
        let mut c = NpmrcConfig::default();
        c.scoped_registries.push((
            "@myco".to_string(),
            "https://registry.myco.com/".to_string(),
        ));
        let (url, _) = registry_for_package(&c, "@myco/utils");
        assert_eq!(url, "https://registry.myco.com/");
    }

    #[test]
    fn registry_for_unscoped_returns_default() {
        let c = NpmrcConfig::default();
        let (url, _) = registry_for_package(&c, "lodash");
        assert!(url.contains("npmjs.org"));
    }

    #[test]
    fn parse_ignores_comments() {
        let c = config_from(
            "# this is a comment\n; also a comment\nregistry=https://my.example.com/\n",
        );
        assert_eq!(c.default_registry, "https://my.example.com/");
    }
}

#[cfg(test)]
mod auth_scope_tests {
    use super::*;
    #[test]
    fn exact_host_port_and_directory_scope() {
        let mut config = NpmrcConfig::default();
        parse_npmrc_content("//registry.example/private/:_authToken=old\n//registry.example/:_authToken=root\n//registry.example/private/:_authToken=new", &mut config);
        assert_eq!(
            find_auth_token(&config, "https://registry.example/private/pkg.tgz"),
            Some("new")
        );
        assert_eq!(
            find_auth_token(&config, "https://registry.example/private-other/pkg"),
            Some("root")
        );
        for url in [
            "https://evilregistry.example/private/pkg",
            "https://registry.example.evil/private/pkg",
            "https://registry.example:444/private/pkg",
            "https://registry.example/private%2f..%2foutside",
            "https://registry.example/private/%2e%2e/outside",
            "https://user@registry.example/private/pkg",
        ] {
            assert_ne!(find_auth_token(&config, url), Some("new"), "{url}");
        }
    }
    #[test]
    fn http_requires_explicit_registry_configuration() {
        let mut config = NpmrcConfig::default();
        parse_npmrc_content("registry=https://registry.example/private/\n//registry.example/private/:_authToken=FAKE", &mut config);
        assert_eq!(
            find_auth_token(&config, "http://registry.example/private/pkg"),
            None
        );
        config.default_registry = "http://registry.example/private/".into();
        assert_eq!(
            find_auth_token(&config, "http://registry.example/private/pkg"),
            Some("FAKE")
        );
    }
    #[test]
    fn later_scope_configuration_wins() {
        let mut config = NpmrcConfig::default();
        parse_npmrc_content("@org:registry=https://home.example/", &mut config);
        parse_npmrc_content("@org:registry=https://project.example/", &mut config);
        assert_eq!(
            registry_for_package(&config, "@org/pkg").0,
            "https://project.example/"
        );
    }
}
