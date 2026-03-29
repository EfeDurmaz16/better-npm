use super::{BetterError, ErrorCode};

/// Write a structured JSON error to stderr and return the semantic exit code
pub fn emit_error(code: ErrorCode, message: &str) -> i32 {
    let err = BetterError::new(code, message);
    err.write_json_stderr();
    err.semantic_exit_code()
}

/// Write a structured JSON error to stderr with ecosystem info
pub fn emit_error_with_ecosystem(code: ErrorCode, message: &str, ecosystem: &str) -> i32 {
    let mut err = BetterError::new(code, message);
    err.ecosystem = Some(ecosystem.to_string());
    err.write_json_stderr();
    err.semantic_exit_code()
}

/// Wrap any existing JSON output string with agent-mode envelope
pub fn wrap_agent_envelope(kind: &str, json_body: &str, exit_code: i32) -> String {
    format!(
        "{{\"_agent\":true,\"command\":\"{}\",\"exitCode\":{},\"data\":{}}}",
        kind, exit_code, json_body
    )
}
