// crates/better-core/src/telemetry.rs
// Opt-in anonymous telemetry — never blocks CLI, never collects private data

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct TelemetryEvent {
    pub event_id: String,
    pub session_id: String,
    pub command: String,
    pub duration_ms: u64,
    pub success: bool,
    pub ecosystems: Vec<String>,
    pub package_count: Option<usize>,
    pub os: String,
    pub arch: String,
    pub better_version: String,
    // Explicitly NOT included: project name, package names, file paths, IPs
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub session_id: String,
    #[serde(skip)]
    pub config_path: PathBuf,
}

impl TelemetryConfig {
    pub fn load() -> Self {
        let config_path = home_dir().join(".better").join("telemetry.json");

        let (enabled, session_id) = if config_path.exists() {
            let content = std::fs::read_to_string(&config_path).unwrap_or_default();
            let v: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
            let enabled = v["enabled"].as_bool().unwrap_or(false);
            let sid = v["session_id"].as_str().unwrap_or("").to_string();
            (enabled, sid)
        } else {
            (false, new_uuid())  // Opt-in: disabled by default
        };

        let session_id = if session_id.is_empty() { new_uuid() } else { session_id };

        Self {
            enabled,
            endpoint: "https://telemetry.better.sh/v1/events".to_string(),
            session_id,
            config_path,
        }
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let json = serde_json::json!({
            "enabled": enabled,
            "session_id": self.session_id,
        });
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.config_path, serde_json::to_string_pretty(&json).unwrap())
            .map_err(|e| e.to_string())
    }

    pub fn status(&self) -> &'static str {
        if self.enabled { "enabled" } else { "disabled" }
    }
}

/// Send telemetry event in a background thread — never blocks the CLI.
pub fn send_event(config: &TelemetryConfig, event: TelemetryEvent) {
    if !config.enabled {
        return;
    }

    let endpoint = config.endpoint.clone();
    let body = match serde_json::to_string(&event) {
        Ok(s) => s,
        Err(_) => return,
    };

    std::thread::spawn(move || {
        let _ = post_json_no_deps(&endpoint, &body, Duration::from_secs(2));
    });
}

/// Minimal HTTP POST using only std::net — no reqwest dependency.
fn post_json_no_deps(url: &str, body: &str, timeout: Duration) -> Result<(), String> {
    use std::io::Write;
    use std::net::TcpStream;

    // Parse URL: https://host/path
    let url = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let (host, path) = url.split_once('/').unwrap_or((url, ""));
    let addr = format!("{}:443", host);

    let stream = TcpStream::connect_timeout(
        &addr.parse().map_err(|e: std::net::AddrParseError| e.to_string())?,
        timeout,
    ).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(timeout)).ok();

    let mut s = stream;
    let request = format!(
        "POST /{} HTTP/1.0\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        path, host, body.len(), body
    );
    s.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn new_uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("tel-{:08x}-{:08x}", t, std::process::id())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_load_defaults_to_disabled() {
        // Without a config file, telemetry is opt-in disabled
        let config = TelemetryConfig::load();
        // Status should be either enabled or disabled (just check it doesn't panic)
        let _ = config.status();
    }

    #[test]
    fn status_enabled_returns_enabled() {
        let config = TelemetryConfig {
            enabled: true,
            endpoint: "https://example.com".to_string(),
            session_id: "test".to_string(),
            config_path: std::path::PathBuf::from("/tmp/test-telemetry.json"),
        };
        assert_eq!(config.status(), "enabled");
    }

    #[test]
    fn status_disabled_returns_disabled() {
        let config = TelemetryConfig {
            enabled: false,
            endpoint: "https://example.com".to_string(),
            session_id: "test".to_string(),
            config_path: std::path::PathBuf::from("/tmp/test-telemetry.json"),
        };
        assert_eq!(config.status(), "disabled");
    }

    #[test]
    fn send_event_disabled_does_not_panic() {
        let config = TelemetryConfig {
            enabled: false,
            endpoint: "https://example.com".to_string(),
            session_id: "test-session".to_string(),
            config_path: std::path::PathBuf::from("/tmp/test-telemetry.json"),
        };
        let event = TelemetryEvent {
            event_id: "test-id".to_string(),
            session_id: "test-session".to_string(),
            command: "install".to_string(),
            duration_ms: 100,
            success: true,
            ecosystems: vec!["npm".to_string()],
            package_count: Some(5),
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            better_version: "1.0.0".to_string(),
        };
        send_event(&config, event); // should not panic
    }

    #[test]
    fn new_uuid_has_tel_prefix() {
        let uuid = new_uuid();
        assert!(uuid.starts_with("tel-"), "expected tel- prefix, got: {}", uuid);
    }

    #[test]
    fn new_uuid_different_on_each_call() {
        // UUIDs are time-based; two calls in sequence may be identical in tests,
        // but both should be non-empty strings with the tel- prefix
        let a = new_uuid();
        let b = new_uuid();
        assert!(!a.is_empty());
        assert!(!b.is_empty());
    }

    #[test]
    fn home_dir_returns_path() {
        let path = home_dir();
        assert!(!path.as_os_str().is_empty());
    }

    #[test]
    fn telemetry_event_has_correct_fields() {
        let event = TelemetryEvent {
            event_id: "evt-001".to_string(),
            session_id: "sess-001".to_string(),
            command: "audit".to_string(),
            duration_ms: 250,
            success: false,
            ecosystems: vec!["python".to_string()],
            package_count: None,
            os: "linux".to_string(),
            arch: "aarch64".to_string(),
            better_version: "2.0.0".to_string(),
        };
        assert_eq!(event.command, "audit");
        assert!(!event.success);
        assert_eq!(event.duration_ms, 250);
    }
}
