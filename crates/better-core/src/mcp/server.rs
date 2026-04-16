use super::protocol::*;
use super::transport::McpTransport;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    struct MockTransport {
        requests: std::collections::VecDeque<JsonRpcRequest>,
        // Store responses as JSON strings since JsonRpcResponse isn't Clone
        response_jsons: Vec<String>,
    }

    impl MockTransport {
        fn new(requests: Vec<JsonRpcRequest>) -> Self {
            Self {
                requests: requests.into(),
                response_jsons: vec![],
            }
        }

        fn response_count(&self) -> usize {
            self.response_jsons.len()
        }

        fn response_at(&self, i: usize) -> serde_json::Value {
            serde_json::from_str(&self.response_jsons[i]).unwrap()
        }
    }

    impl McpTransport for MockTransport {
        fn read_message(&mut self) -> Result<JsonRpcRequest, String> {
            self.requests.pop_front().ok_or_else(|| "EOF".to_string())
        }

        fn write_message(&mut self, response: &JsonRpcResponse) -> Result<(), String> {
            self.response_jsons.push(serde_json::to_string(response).unwrap());
            Ok(())
        }
    }

    fn make_request(method: &str, id: i64) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(serde_json::json!(id)),
            method: method.to_string(),
            params: None,
        }
    }

    #[test]
    fn server_handles_ping() {
        let transport = MockTransport::new(vec![make_request("ping", 1)]);
        let mut server = McpServer::new(transport);
        server.run().unwrap();
        assert_eq!(server.transport.response_count(), 1);
        let resp = server.transport.response_at(0);
        assert!(resp.get("error").is_none());
        assert_eq!(resp["id"], serde_json::json!(1));
    }

    #[test]
    fn server_handles_unknown_method_returns_error() {
        let transport = MockTransport::new(vec![make_request("unknown/method", 2)]);
        let mut server = McpServer::new(transport);
        server.run().unwrap();
        assert_eq!(server.transport.response_count(), 1);
        let resp = server.transport.response_at(0);
        assert_eq!(resp["error"]["code"], serde_json::json!(-32601));
    }

    #[test]
    fn server_handles_initialize() {
        let transport = MockTransport::new(vec![make_request("initialize", 3)]);
        let mut server = McpServer::new(transport);
        server.run().unwrap();
        assert_eq!(server.transport.response_count(), 1);
        let resp = server.transport.response_at(0);
        assert!(resp.get("error").is_none());
        assert!(!resp["result"].is_null());
    }

    #[test]
    fn server_skips_response_for_notification_no_id() {
        let notify = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: "notifications/initialized".to_string(),
            params: None,
        };
        let transport = MockTransport::new(vec![notify]);
        let mut server = McpServer::new(transport);
        server.run().unwrap();
        // Notifications with no id get no response
        assert_eq!(server.transport.response_count(), 0);
    }

    #[test]
    fn server_handles_tools_list() {
        let transport = MockTransport::new(vec![make_request("tools/list", 5)]);
        let mut server = McpServer::new(transport);
        server.run().unwrap();
        assert_eq!(server.transport.response_count(), 1);
        let resp = server.transport.response_at(0);
        assert!(resp.get("error").is_none());
        assert!(resp["result"]["tools"].is_array());
    }

    #[test]
    fn server_handles_tools_call_no_params() {
        // tools/call with no params should return an error
        let transport = MockTransport::new(vec![make_request("tools/call", 6)]);
        let mut server = McpServer::new(transport);
        server.run().unwrap();
        assert_eq!(server.transport.response_count(), 1);
        let resp = server.transport.response_at(0);
        assert!(resp["error"].is_object());
        assert_eq!(resp["error"]["code"], serde_json::json!(-32602));
    }

    #[test]
    fn server_handles_multiple_requests_sequentially() {
        let transport = MockTransport::new(vec![
            make_request("ping", 10),
            make_request("ping", 11),
            make_request("ping", 12),
        ]);
        let mut server = McpServer::new(transport);
        server.run().unwrap();
        assert_eq!(server.transport.response_count(), 3);
    }

    #[test]
    fn server_initialized_flag_set_after_initialize() {
        let transport = MockTransport::new(vec![make_request("initialize", 20)]);
        let mut server = McpServer::new(transport);
        assert!(!server.initialized);
        server.run().unwrap();
        assert!(server.initialized);
    }
}
