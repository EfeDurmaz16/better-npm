pub mod json;
pub mod schema;
pub mod results;

/// Output mode for all commands
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OutputMode {
    Human, // Default: colored, formatted, tables
    Json,  // --json: machine-parseable, one JSON object per command
}

/// Every command result must implement this
pub trait CommandOutput: serde::Serialize {
    fn command_name(&self) -> &'static str;
    fn schema_url(&self) -> &'static str;
    fn exit_code(&self) -> i32 {
        0
    }
}

/// Structured error — always serializable
#[derive(Debug, serde::Serialize)]
pub struct BetterError {
    pub error: bool,
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ecosystem: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    DependencyResolution,
    SecurityVulnerability,
    PolicyViolation,
    NetworkError,
    ManifestParse,
    LockfileMismatch,
    EngineNotFound,
    CommandNotFound,
    Internal,
}

impl BetterError {
    /// Create a new error with the given code and message
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            error: true,
            code,
            message: message.into(),
            ecosystem: None,
            details: None,
            suggestion: None,
        }
    }

    /// Write error as JSON to stderr
    pub fn write_json_stderr(&self) {
        let json = serde_json::to_string(self).unwrap_or_default();
        eprintln!("{}", json);
    }

    /// Map error code to semantic exit code for agent mode
    pub fn semantic_exit_code(&self) -> i32 {
        match self.code {
            ErrorCode::DependencyResolution => 1,
            ErrorCode::SecurityVulnerability => 2,
            ErrorCode::PolicyViolation => 3,
            ErrorCode::NetworkError => 4,
            ErrorCode::ManifestParse => 1,
            ErrorCode::LockfileMismatch => 1,
            ErrorCode::EngineNotFound => 1,
            ErrorCode::CommandNotFound => 1,
            ErrorCode::Internal => 1,
        }
    }
}

/// Emit output based on mode
pub fn emit<T: CommandOutput>(output: &T, mode: OutputMode) {
    match mode {
        OutputMode::Human => {
            // In human mode, delegate to existing TUI/formatted output
            // For now, fall through to JSON since all commands already emit JSON
            let json = serde_json::to_string_pretty(output).unwrap_or_default();
            println!("{}", json);
        }
        OutputMode::Json => {
            let json = serde_json::to_string_pretty(output).unwrap_or_default();
            println!("{}", json);
        }
    }
}

/// Global flags parsed before command dispatch
#[derive(Debug, Clone)]
pub struct GlobalFlags {
    pub json: bool,
    pub no_color: bool,
    pub no_interactive: bool,
    pub verbose: bool,
    pub agent_mode: bool,
}

impl GlobalFlags {
    pub fn output_mode(&self) -> OutputMode {
        if self.json || self.agent_mode {
            OutputMode::Json
        } else {
            OutputMode::Human
        }
    }
}

impl Default for GlobalFlags {
    fn default() -> Self {
        Self {
            json: false,
            no_color: false,
            no_interactive: false,
            verbose: false,
            agent_mode: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn better_error_new_sets_error_flag() {
        let err = BetterError::new(ErrorCode::NetworkError, "connection refused");
        assert!(err.error);
        assert_eq!(err.message, "connection refused");
    }

    #[test]
    fn semantic_exit_code_security_vulnerability() {
        let err = BetterError::new(ErrorCode::SecurityVulnerability, "");
        assert_eq!(err.semantic_exit_code(), 2);
    }

    #[test]
    fn semantic_exit_code_policy_violation() {
        let err = BetterError::new(ErrorCode::PolicyViolation, "");
        assert_eq!(err.semantic_exit_code(), 3);
    }

    #[test]
    fn error_code_serde() {
        let json = serde_json::to_string(&ErrorCode::NetworkError).unwrap();
        assert_eq!(json, "\"network_error\"");
    }
}
