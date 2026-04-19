/// Semantic exit codes for `better agent` mode.
///
/// AI agents and CI pipelines can reliably branch on these codes without
/// having to parse command output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum AgentExitCode {
    Ok = 0,
    DependencyError = 1,
    SecurityIssue = 2,
    PolicyViolation = 3,
    NetworkError = 4,
    ManifestError = 5,
    InternalError = 99,
}

impl AgentExitCode {
    pub fn as_i32(self) -> i32 {
        self as i32
    }

    /// Map from an `output::ErrorCode` to the canonical agent exit code.
    pub fn from_error_code(code: &crate::output::ErrorCode) -> Self {
        match code {
            crate::output::ErrorCode::DependencyResolution => Self::DependencyError,
            crate::output::ErrorCode::SecurityVulnerability => Self::SecurityIssue,
            crate::output::ErrorCode::PolicyViolation => Self::PolicyViolation,
            crate::output::ErrorCode::NetworkError => Self::NetworkError,
            crate::output::ErrorCode::ManifestParse => Self::ManifestError,
            _ => Self::InternalError,
        }
    }
}

/// Runtime configuration injected when `better agent` prefix is detected.
#[derive(Debug, Clone)]
pub struct AgentConfig {
    /// Force JSON output on stdout.
    pub json: bool,
    /// Suppress interactive prompts (always answer default).
    pub no_interactive: bool,
    /// Strip ANSI colour codes from output.
    pub no_color: bool,
    /// Emit NDJSON progress events on stderr.
    pub progress_ndjson: bool,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            json: true,
            no_interactive: true,
            no_color: true,
            progress_ndjson: true,
        }
    }
}

/// NDJSON progress event written to stderr during agent mode.
///
/// Agents can parse these by reading stderr line-by-line.
#[derive(Debug, serde::Serialize)]
pub struct ProgressEvent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub phase: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<u64>,
}

impl ProgressEvent {
    pub fn new(phase: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: "progress",
            phase: phase.into(),
            message: message.into(),
            percent: None,
            total: None,
            done: None,
        }
    }

    pub fn with_counts(mut self, done: u64, total: u64) -> Self {
        self.done = Some(done);
        self.total = Some(total);
        if total > 0 {
            self.percent = Some((done as f64 / total as f64) * 100.0);
        }
        self
    }

    /// Serialize and write to stderr as a single NDJSON line.
    pub fn emit(&self) {
        if let Ok(line) = serde_json::to_string(self) {
            eprintln!("{}", line);
        }
    }
}

/// Detect whether the current invocation is in agent mode.
///
/// Agent mode is active when:
/// - The first argument is `agent`, OR
/// - `BETTER_AGENT=1` is set in the environment.
pub fn is_agent_mode(args: &[String]) -> bool {
    if std::env::var("BETTER_AGENT").as_deref() == Ok("1") {
        return true;
    }
    args.first().map(|a| a == "agent").unwrap_or(false)
}

/// Strip the `agent` prefix from args if present, and return default config.
pub fn strip_agent_prefix(args: &[String]) -> (Vec<String>, AgentConfig) {
    let config = AgentConfig::default();
    let remaining = if args.first().map(|a| a == "agent").unwrap_or(false) {
        args[1..].to_vec()
    } else {
        args.to_vec()
    };
    (remaining, config)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_exit_codes_are_distinct() {
        assert_ne!(AgentExitCode::Ok.as_i32(), AgentExitCode::SecurityIssue.as_i32());
        assert_ne!(AgentExitCode::PolicyViolation.as_i32(), AgentExitCode::NetworkError.as_i32());
    }

    #[test]
    fn agent_config_default_all_true() {
        let cfg = AgentConfig::default();
        assert!(cfg.json);
        assert!(cfg.no_interactive);
        assert!(cfg.no_color);
        assert!(cfg.progress_ndjson);
    }

    #[test]
    fn is_agent_mode_detects_prefix() {
        let args = vec!["agent".to_string(), "install".to_string()];
        assert!(is_agent_mode(&args));
    }

    #[test]
    fn is_agent_mode_false_for_other_commands() {
        let args = vec!["install".to_string()];
        assert!(!is_agent_mode(&args));
    }

    #[test]
    fn strip_agent_prefix_removes_first_arg() {
        let args = vec!["agent".to_string(), "audit".to_string(), "--json".to_string()];
        let (remaining, _) = strip_agent_prefix(&args);
        assert_eq!(remaining, vec!["audit", "--json"]);
    }

    #[test]
    fn strip_agent_prefix_passthrough_when_absent() {
        let args = vec!["audit".to_string()];
        let (remaining, _) = strip_agent_prefix(&args);
        assert_eq!(remaining, vec!["audit"]);
    }

    #[test]
    fn progress_event_emit_serializes_without_panic() {
        let ev = ProgressEvent::new("fetch", "fetching lodash").with_counts(3, 10);
        assert_eq!(ev.done, Some(3));
        assert_eq!(ev.total, Some(10));
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"progress\""));
    }

    #[test]
    fn from_error_code_maps_security() {
        let code = crate::output::ErrorCode::SecurityVulnerability;
        assert_eq!(AgentExitCode::from_error_code(&code).as_i32(), AgentExitCode::SecurityIssue.as_i32());
    }
}
