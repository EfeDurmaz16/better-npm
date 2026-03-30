// crates/better-core/src/telemetry.rs
// Anonymous opt-in telemetry — fire-and-forget, never blocks CLI
// Data sent: command name, duration, success, OS/arch, version
// Data NOT sent: project names, package names, paths, user info, IPs

use std::time::Duration;
use std::path::PathBuf;

#[derive(Debug, Clone, serde::Serialize)]
pub struct TelemetryEvent {
    /// Random UUID per event.
    pub event_id: String,
    /// Random UUID per CLI session (regenerated each run).
    pub session_id: String,
    pub command: String,
    pub duration_ms: u64,
    pub success: bool,
    pub ecosystems: Vec<String>,
    pub package_count: Option<usize>,
    pub cas_hit_rate: Option<f64>,
    pub os: String,
    pub arch: String,
    pub better_version: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct TelemetryConfig {
    enabled: bool,
    /// Anonymous stable ID for this installation (opt-in only).
    install_id: Option<String>,
}

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".better").join("telemetry.json")
}

pub fn is_enabled() -> bool {
    let path = config_path();
    if !path.exists() {
        return false; // Opt-in: disabled by default
    }
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let val: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
    val.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let existing: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));

    let mut config = existing;
    config["enabled"] = serde_json::Value::Bool(enabled);
    if enabled && config.get("install_id").is_none() {
        // Generate a random install ID on first enable
        let id = format!("{:x}{:x}", rand_u64(), rand_u64());
        config["install_id"] = serde_json::Value::String(id);
    }
    std::fs::write(&path, serde_json::to_string_pretty(&config).unwrap_or_default())
        .map_err(|e| e.to_string())
}

fn rand_u64() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    t.subsec_nanos() as u64 ^ t.as_secs().wrapping_mul(0x9e3779b97f4a7c15)
}

pub fn new_event(command: &str, duration_ms: u64, success: bool) -> TelemetryEvent {
    TelemetryEvent {
        event_id: format!("{:x}{:x}", rand_u64(), rand_u64()),
        session_id: format!("{:x}{:x}", rand_u64(), rand_u64()),
        command: command.to_string(),
        duration_ms,
        success,
        ecosystems: vec![],
        package_count: None,
        cas_hit_rate: None,
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        better_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// Send a telemetry event fire-and-forget in a background thread.
/// Never blocks, never panics on failure.
pub fn send(event: TelemetryEvent) {
    if !is_enabled() {
        return;
    }
    let payload = match serde_json::to_vec(&event) {
        Ok(v) => v,
        Err(_) => return,
    };
    // Background thread: try to POST, timeout 2s, completely ignore result
    std::thread::spawn(move || {
        use std::io::Write;
        use std::net::TcpStream;
        // Minimal HTTP POST without reqwest (no extra deps)
        if let Ok(mut stream) = TcpStream::connect("telemetry.better.sh:80") {
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let body = String::from_utf8_lossy(&payload);
            let req = format!(
                "POST /v1/events HTTP/1.0\r\nHost: telemetry.better.sh\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                payload.len(), body
            );
            let _ = stream.write_all(req.as_bytes());
        }
    });
}
