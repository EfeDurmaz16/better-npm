use super::protocol::*;
use super::transport::*;
use super::tools;

pub struct McpServer<T: McpTransport> {
    transport: T,
    initialized: bool,
}

impl<T: McpTransport> McpServer<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            initialized: false,
        }
    }

    pub fn run(&mut self) -> Result<(), String> {
        loop {
            let request = match self.transport.read_message() {
                Ok(req) => req,
                Err(e) => {
                    if e.contains("EOF") {
                        break;
                    }
                    // Skip empty lines and invalid messages
                    if e.contains("empty line") {
                        continue;
                    }
                    eprintln!("transport error: {}", e);
                    break;
                }
            };

            let response = self.handle_request(&request);

            // Notifications (no id) don't get responses
            if request.id.is_none() {
                continue;
            }

            self.transport.write_message(&response)?;
        }
        Ok(())
    }

    fn handle_request(&mut self, request: &JsonRpcRequest) -> JsonRpcResponse {
        match request.method.as_str() {
            "initialize" => {
                self.initialized = true;
                JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: request.id.clone(),
                    result: Some(initialize_result()),
                    error: None,
                }
            }
            "notifications/initialized" | "initialized" => {
                // This is a notification, no response needed
                JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: request.id.clone(),
                    result: Some(serde_json::json!({})),
                    error: None,
                }
            }
            "tools/list" => {
                let tool_list = tools::list_tools();
                JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: request.id.clone(),
                    result: Some(serde_json::json!({ "tools": tool_list })),
                    error: None,
                }
            }
            "tools/call" => {
                let params = request.params.as_ref().and_then(|p| p.as_object());

                let (tool_name, args) = match params {
                    Some(p) => {
                        let name = p
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("");
                        let arguments = p
                            .get("arguments")
                            .cloned()
                            .unwrap_or(serde_json::json!({}));
                        (name.to_string(), arguments)
                    }
                    None => {
                        return JsonRpcResponse {
                            jsonrpc: "2.0".to_string(),
                            id: request.id.clone(),
                            result: None,
                            error: Some(JsonRpcError {
                                code: -32602,
                                message: "Invalid params: expected object with 'name' field"
                                    .to_string(),
                                data: None,
                            }),
                        };
                    }
                };

                let tool_result = tools::execute_tool(&tool_name, &args);
                JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: request.id.clone(),
                    result: Some(
                        serde_json::to_value(tool_result)
                            .unwrap_or(serde_json::json!({"error": "serialization failed"})),
                    ),
                    error: None,
                }
            }
            "ping" => JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: request.id.clone(),
                result: Some(serde_json::json!({})),
                error: None,
            },
            _ => JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id: request.id.clone(),
                result: None,
                error: Some(JsonRpcError {
                    code: -32601,
                    message: format!("Method not found: {}", request.method),
                    data: None,
                }),
            },
        }
    }
}
