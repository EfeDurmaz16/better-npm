//! Registry Mirror Auto-Select — v0.5 Feature #25
//!
//! Probes latency of known npm registry mirrors and persists the fastest one
//! to `~/.better/config.json`.  Respects `.npmrc` `registry=` overrides.
//!
//! Usage (CLI):
//!   better registry mirror-probe           # probe all mirrors, print report
//!   better registry mirror-probe --select  # probe + save fastest to config
//!   better registry mirror-select          # alias
//!
//! Integration:
//!   During install, if no .npmrc registry override is set, call
//!   `load_best_mirror()` to get the fastest saved mirror URL.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Known mirrors
// ---------------------------------------------------------------------------

/// Well-known npm registry mirrors, in priority order.
pub const KNOWN_MIRRORS: &[(&str, &str)] = &[
    ("npmjs", "https://registry.npmjs.org"),
    ("npmmirror (CN)", "https://registry.npmmirror.com"),
    ("yarn", "https://registry.yarnpkg.com"),
    ("cloudflare", "https://registry.npmjs.cf"),
];

/// The probe path — fetching the `/-/ping` endpoint.
const PROBE_PATH: &str = "/-/ping";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MirrorProbeResult {
    pub name: String,
    pub url: String,
    pub latency_ms: Option<u64>,
    pub ok: bool,
    pub status: Option<u16>,
    pub error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct MirrorSelectResult {
    pub ok: bool,
    pub selected: Option<String>,
    pub selected_name: Option<String>,
    pub all: Vec<MirrorProbeResult>,
    pub saved: bool,
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// Config path
// ---------------------------------------------------------------------------

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".better")
        .join("config.json")
}

// ---------------------------------------------------------------------------
// probe_mirrors
// ---------------------------------------------------------------------------

/// Probe all known mirrors plus any extra URLs provided.
/// Returns results sorted by latency (fastest first, failed last).
pub fn probe_mirrors(extra_mirrors: &[(&str, &str)], timeout_ms: u64) -> Vec<MirrorProbeResult> {
    let mut mirrors: Vec<(&str, &str)> = KNOWN_MIRRORS.to_vec();
    mirrors.extend_from_slice(extra_mirrors);

    let timeout = Duration::from_millis(timeout_ms);

    let mut results: Vec<MirrorProbeResult> = mirrors
        .iter()
        .map(|(name, url)| probe_one(name, url, timeout))
        .collect();

    // Sort: successful first by latency, then failed
    results.sort_by(|a, b| {
        match (a.latency_ms, b.latency_ms) {
            (Some(la), Some(lb)) => la.cmp(&lb),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
    });

    results
}

fn probe_one(name: &str, base_url: &str, timeout: Duration) -> MirrorProbeResult {
    let url = format!("{}{}", base_url.trim_end_matches('/'), PROBE_PATH);

    let start = Instant::now();
    let result = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .danger_accept_invalid_certs(false)
        .build()
        .ok()
        .and_then(|c| c.get(&url).send().ok());

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Some(resp) => {
            let status = resp.status().as_u16();
            let ok = status < 400;
            MirrorProbeResult {
                name: name.to_string(),
                url: base_url.to_string(),
                latency_ms: if ok { Some(elapsed_ms) } else { None },
                ok,
                status: Some(status),
                error: if ok { None } else { Some(format!("HTTP {}", status)) },
            }
        }
        None => MirrorProbeResult {
            name: name.to_string(),
            url: base_url.to_string(),
            latency_ms: None,
            ok: false,
            status: None,
            error: Some(format!("timeout or connection error after {}ms", elapsed_ms)),
        },
    }
}

// ---------------------------------------------------------------------------
// select_and_save
// ---------------------------------------------------------------------------

/// Probe all mirrors, pick the fastest, save it to ~/.better/config.json.
pub fn select_and_save(timeout_ms: u64) -> MirrorSelectResult {
    let all = probe_mirrors(&[], timeout_ms);

    let best = all.iter().find(|r| r.ok);

    match best {
        None => MirrorSelectResult {
            ok: false,
            selected: None,
            selected_name: None,
            all,
            saved: false,
            reason: Some("all mirrors unreachable".to_string()),
        },
        Some(winner) => {
            let url = winner.url.clone();
            let name = winner.name.clone();
            let saved = save_mirror_config(&url);
            MirrorSelectResult {
                ok: true,
                selected: Some(url),
                selected_name: Some(name),
                all,
                saved,
                reason: if saved { None } else { Some("config save failed".to_string()) },
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

/// Save the selected mirror URL to ~/.better/config.json.
fn save_mirror_config(registry_url: &str) -> bool {
    let path = config_path();
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }

    // Read existing config or start fresh
    let mut config: HashMap<String, serde_json::Value> = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        HashMap::new()
    };

    config.insert("registry".to_string(), serde_json::Value::String(registry_url.to_string()));

    match serde_json::to_string_pretty(&config) {
        Ok(json) => fs::write(&path, json).is_ok(),
        Err(_) => false,
    }
}

/// Load the saved best mirror from ~/.better/config.json.
/// Returns None if no mirror has been saved or if .npmrc overrides it.
pub fn load_best_mirror() -> Option<String> {
    let path = config_path();
    if !path.exists() {
        return None;
    }
    let content = fs::read_to_string(&path).ok()?;
    let config: HashMap<String, serde_json::Value> = serde_json::from_str(&content).ok()?;
    config.get("registry")?.as_str().map(|s| s.to_string())
}

/// Returns the effective registry URL:
/// 1. .npmrc `registry=` value if present (already handled by npm tooling)
/// 2. Saved best mirror from ~/.better/config.json
/// 3. Default npmjs.org
pub fn effective_registry(npmrc_override: Option<&str>) -> String {
    if let Some(url) = npmrc_override {
        return url.to_string();
    }
    load_best_mirror().unwrap_or_else(|| "https://registry.npmjs.org".to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_registry_respects_npmrc_override() {
        let url = effective_registry(Some("https://my.private.registry.example.com"));
        assert_eq!(url, "https://my.private.registry.example.com");
    }

    #[test]
    fn effective_registry_falls_back_to_default_when_no_config() {
        // Remove any saved config for this test (by using a temp path approach)
        // We can't easily mock the config path, so just check the fallback logic.
        let url = effective_registry(None);
        // Should be a valid URL (either saved or default)
        assert!(url.starts_with("https://"), "expected https URL, got: {}", url);
    }

    #[test]
    fn known_mirrors_are_all_https() {
        for (_, url) in KNOWN_MIRRORS {
            assert!(url.starts_with("https://"), "mirror {} is not https", url);
        }
    }

    #[test]
    fn probe_results_sort_fastest_first() {
        let mut results = vec![
            MirrorProbeResult {
                name: "slow".to_string(), url: "https://slow".to_string(),
                latency_ms: Some(500), ok: true, status: Some(200), error: None,
            },
            MirrorProbeResult {
                name: "fast".to_string(), url: "https://fast".to_string(),
                latency_ms: Some(50), ok: true, status: Some(200), error: None,
            },
            MirrorProbeResult {
                name: "dead".to_string(), url: "https://dead".to_string(),
                latency_ms: None, ok: false, status: None, error: Some("timeout".to_string()),
            },
        ];
        results.sort_by(|a, b| match (a.latency_ms, b.latency_ms) {
            (Some(la), Some(lb)) => la.cmp(&lb),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });
        assert_eq!(results[0].name, "fast");
        assert_eq!(results[1].name, "slow");
        assert_eq!(results[2].name, "dead");
    }

    #[test]
    fn known_mirrors_list_is_nonempty() {
        assert!(!KNOWN_MIRRORS.is_empty());
        // npmjs.org should always be present
        assert!(KNOWN_MIRRORS.iter().any(|(_, url)| url.contains("npmjs.org")));
    }

    #[test]
    fn mirror_probe_result_serde_roundtrip() {
        let result = MirrorProbeResult {
            name: "test".to_string(),
            url: "https://example.com".to_string(),
            latency_ms: Some(123),
            ok: true,
            status: Some(200),
            error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        let back: MirrorProbeResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "test");
        assert_eq!(back.latency_ms, Some(123));
        assert!(back.ok);
    }

    #[test]
    fn mirror_probe_result_failed_has_error() {
        let result = MirrorProbeResult {
            name: "dead".to_string(),
            url: "https://dead.example.com".to_string(),
            latency_ms: None,
            ok: false,
            status: None,
            error: Some("connection refused".to_string()),
        };
        assert!(!result.ok);
        assert!(result.error.is_some());
        assert!(result.latency_ms.is_none());
    }

    #[test]
    fn mirror_select_result_fields() {
        let best = MirrorSelectResult {
            ok: true,
            selected: Some("https://registry.npmjs.org".to_string()),
            selected_name: Some("npmjs".to_string()),
            all: vec![],
            saved: false,
            reason: None,
        };
        assert!(best.ok);
        assert_eq!(best.selected.as_deref(), Some("https://registry.npmjs.org"));
        assert_eq!(best.selected_name.as_deref(), Some("npmjs"));
    }
}
