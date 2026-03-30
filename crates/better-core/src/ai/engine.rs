use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct AiEngine {
    pub provider: AiProvider,
    pub model: String,
    pub context_budget: usize,
}

#[derive(Debug, Clone)]
pub enum AiProvider {
    Claude { api_key: String },
    OpenAI { api_key: String },
    Local { endpoint: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiRequest {
    pub intent: String,
    pub project_context: ProjectContext,
    pub available_tools: Vec<AiTool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectContext {
    pub ecosystems: Vec<String>,
    pub existing_deps: Vec<DepSummary>,
    pub framework: Option<String>,
    pub osp_services: Vec<String>,
    pub file_structure: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepSummary {
    pub name: String,
    pub version: String,
    pub ecosystem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTool {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiPlan {
    pub explanation: String,
    pub steps: Vec<AiStep>,
    pub estimated_time: String,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiStep {
    pub step_number: u32,
    pub description: String,
    pub tool_call: ToolCall,
    pub expected_result: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub tool: String,
    pub arguments: serde_json::Value,
}

impl AiEngine {
    pub fn from_env() -> Result<Self, String> {
        if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
            return Ok(Self {
                provider: AiProvider::Claude { api_key: key },
                model: "claude-haiku-4-5".to_string(),
                context_budget: 100_000,
            });
        }
        if let Ok(key) = std::env::var("OPENAI_API_KEY") {
            return Ok(Self {
                provider: AiProvider::OpenAI { api_key: key },
                model: "gpt-4o-mini".to_string(),
                context_budget: 128_000,
            });
        }
        if let Ok(endpoint) = std::env::var("BETTER_AI_ENDPOINT") {
            return Ok(Self {
                provider: AiProvider::Local { endpoint },
                model: "local".to_string(),
                context_budget: 32_000,
            });
        }
        Err("No AI provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or BETTER_AI_ENDPOINT".to_string())
    }

    pub fn plan(&self, intent: &str, ctx: &ProjectContext) -> Result<AiPlan, String> {
        let tools = standard_tools();
        let system_prompt = format!(
            "You are an expert package manager assistant. The project uses: {}. \
             Available tools: {}. Plan how to fulfill this request with minimal steps.",
            ctx.ecosystems.join(", "),
            tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", ")
        );

        let user_prompt = format!(
            "Project has {} dependencies. Request: {}\n\n\
             Respond as JSON: {{\"explanation\": \"...\", \"steps\": [\
             {{\"step_number\": 1, \"description\": \"...\", \
             \"tool_call\": {{\"tool\": \"...\", \"arguments\": {{}}}}, \
             \"expected_result\": \"...\"}}], \
             \"estimated_time\": \"...\", \
             \"requires_confirmation\": false}}",
            ctx.existing_deps.len(),
            intent
        );

        let response = self.call_ai(&system_prompt, &user_prompt)?;
        serde_json::from_str(&response)
            .map_err(|e| format!("Failed to parse AI plan: {}", e))
    }

    fn call_ai(&self, system: &str, user: &str) -> Result<String, String> {
        let client = reqwest::blocking::Client::builder()
            .use_rustls_tls()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;

        match &self.provider {
            AiProvider::Claude { api_key } => {
                let body = serde_json::json!({
                    "model": self.model,
                    "max_tokens": 2048,
                    "system": system,
                    "messages": [{"role": "user", "content": user}]
                });
                let resp = client.post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", api_key)
                    .header("anthropic-version", "2023-06-01")
                    .header("content-type", "application/json")
                    .body(body.to_string())
                    .send()
                    .map_err(|e| e.to_string())?
                    .text()
                    .map_err(|e| e.to_string())?;
                let v: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
                Ok(v["content"][0]["text"].as_str().unwrap_or("{}").to_string())
            }
            AiProvider::OpenAI { api_key } => {
                let body = serde_json::json!({
                    "model": "gpt-4o-mini",
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user}
                    ],
                    "response_format": {"type": "json_object"}
                });
                let resp = client.post("https://api.openai.com/v1/chat/completions")
                    .header("Authorization", format!("Bearer {}", api_key))
                    .header("Content-Type", "application/json")
                    .body(body.to_string())
                    .send()
                    .map_err(|e| e.to_string())?
                    .text()
                    .map_err(|e| e.to_string())?;
                let v: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
                Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or("{}").to_string())
            }
            AiProvider::Local { endpoint } => {
                let body = serde_json::json!({"prompt": format!("{}\n\n{}", system, user)});
                let resp = client.post(endpoint)
                    .body(body.to_string())
                    .send()
                    .map_err(|e| e.to_string())?
                    .text()
                    .map_err(|e| e.to_string())?;
                Ok(resp)
            }
        }
    }
}

fn standard_tools() -> Vec<AiTool> {
    vec![
        AiTool { name: "install".to_string(), description: "Install one or more packages".to_string(), parameters: serde_json::json!({"packages": ["string"]}) },
        AiTool { name: "search".to_string(), description: "Search for packages by description".to_string(), parameters: serde_json::json!({"query": "string"}) },
        AiTool { name: "audit".to_string(), description: "Run security audit".to_string(), parameters: serde_json::json!({"prod_only": false}) },
        AiTool { name: "provision".to_string(), description: "Provision an OSP service".to_string(), parameters: serde_json::json!({"offering": "string", "tier": "free"}) },
        AiTool { name: "migrate".to_string(), description: "Migrate from one package to another".to_string(), parameters: serde_json::json!({"from": "string", "to": "string"}) },
    ]
}
