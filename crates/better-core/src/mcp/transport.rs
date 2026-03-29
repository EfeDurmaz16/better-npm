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
