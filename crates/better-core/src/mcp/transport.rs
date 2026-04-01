use super::protocol::*;
use std::io::{BufRead, Write};

pub trait McpTransport {
    fn read_message(&mut self) -> Result<JsonRpcRequest, String>;
    fn write_message(&mut self, response: &JsonRpcResponse) -> Result<(), String>;
}

/// stdio transport (default) -- uses newline-delimited JSON (JSONL)
/// Each message is a single JSON object followed by a newline.
pub struct StdioTransport {
    reader: std::io::BufReader<std::io::Stdin>,
}

impl StdioTransport {
    pub fn new() -> Self {
        Self {
            reader: std::io::BufReader::new(std::io::stdin()),
        }
    }
}

impl McpTransport for StdioTransport {
    fn read_message(&mut self) -> Result<JsonRpcRequest, String> {
        let mut line = String::new();
        let bytes_read = self
            .reader
            .read_line(&mut line)
            .map_err(|e| format!("failed to read from stdin: {}", e))?;

        if bytes_read == 0 {
            return Err("EOF on stdin".to_string());
        }

        let line = line.trim();
        if line.is_empty() {
            return Err("empty line".to_string());
        }

        serde_json::from_str(line).map_err(|e| format!("invalid JSON-RPC: {}", e))
    }

    fn write_message(&mut self, response: &JsonRpcResponse) -> Result<(), String> {
        let body = serde_json::to_string(response)
            .map_err(|e| format!("failed to serialize response: {}", e))?;

        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "{}", body)
            .map_err(|e| format!("failed to write response: {}", e))?;
        stdout
            .flush()
            .map_err(|e| format!("failed to flush stdout: {}", e))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdio_transport_new_does_not_panic() {
        let _t = StdioTransport::new();
    }

    #[test]
    fn json_rpc_response_serializes_result() {
        let resp = JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: Some(serde_json::json!(42)),
            result: Some(serde_json::json!({"status": "ok"})),
            error: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"jsonrpc\":\"2.0\""));
        assert!(json.contains("\"status\":\"ok\""));
        // error field is skipped when None
        assert!(!json.contains("\"error\""));
    }

    #[test]
    fn json_rpc_response_serializes_error() {
        let resp = JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: Some(serde_json::json!(1)),
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: "Method not found".to_string(),
                data: None,
            }),
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("-32601"));
        assert!(json.contains("Method not found"));
        assert!(!json.contains("\"result\""));
    }
}
