use serde::{Deserialize, Serialize};

/// Sardis authentication session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SardisSession {
    pub access_token: String,
    pub refresh_token: String,
    pub wallet_id: String,
    pub agent_id: String,
    pub expires_at: String,
}

/// Sardis login request.
#[derive(Debug, Serialize)]
pub struct SardisLoginRequest {
    pub email: Option<String>,
    pub api_key: Option<String>,
    pub device_id: String,
}

/// Sardis login response.
#[derive(Debug, Deserialize)]
pub struct SardisLoginResponse {
    pub session: SardisSession,
    pub wallet: super::wallet::WalletInfo,
}

/// Authenticate with Sardis API.
pub fn sardis_login(req: &SardisLoginRequest) -> Result<SardisLoginResponse, SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| SardisError::Network(e.to_string()))?;

    let body = serde_json::to_string(req)
        .map_err(|e| SardisError::Network(e.to_string()))?;

    let resp = client.post("https://api.sardis.dev/v1/auth/login")
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/sardis-client")
        .body(body)
        .send()
        .map_err(|e| SardisError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    let resp_body = resp.text().map_err(|e| SardisError::Network(e.to_string()))?;

    match status {
        200 | 201 => {
            let login_resp: SardisLoginResponse = serde_json::from_str(&resp_body)
                .map_err(|e| SardisError::Network(e.to_string()))?;

            // Store session
            super::credentials::store_session(&login_resp.session)
                .map_err(|e| SardisError::Network(e.to_string()))?;

            Ok(login_resp)
        }
        401 => Err(SardisError::InvalidCredentials),
        _ => {
            let msg = serde_json::from_str::<serde_json::Value>(&resp_body)
                .ok()
                .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
                .unwrap_or_else(|| format!("HTTP {}", status));
            Err(SardisError::Api {
                code: status.to_string(),
                message: msg,
            })
        }
    }
}

/// Refresh an expired session using the refresh token.
pub fn sardis_refresh(session: &SardisSession) -> Result<SardisSession, SardisError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| SardisError::Network(e.to_string()))?;

    let body = serde_json::json!({
        "refresh_token": session.refresh_token,
    });

    let resp = client.post("https://api.sardis.dev/v1/auth/refresh")
        .header("Content-Type", "application/json")
        .header("User-Agent", "better-npm/sardis-client")
        .body(body.to_string())
        .send()
        .map_err(|e| SardisError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    if status != 200 {
        return Err(SardisError::SessionExpired);
    }

    let resp_body = resp.text().map_err(|e| SardisError::Network(e.to_string()))?;
    let new_session: SardisSession = serde_json::from_str(&resp_body)
        .map_err(|e| SardisError::Network(e.to_string()))?;

    super::credentials::store_session(&new_session)
        .map_err(|e| SardisError::Network(e.to_string()))?;

    Ok(new_session)
}

/// Check if a valid Sardis session exists.
pub fn sardis_session_exists() -> bool {
    super::credentials::credentials_path().exists()
}

/// Load the current Sardis session from encrypted storage.
pub fn sardis_load_session() -> Result<SardisSession, SardisError> {
    super::credentials::load_session()
}

/// Logout: delete session file, revoke token server-side.
pub fn sardis_logout() -> Result<(), SardisError> {
    if let Ok(session) = sardis_load_session() {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .ok();

        if let Some(client) = client {
            let _ = client.delete("https://api.sardis.dev/v1/auth/session")
                .header("Authorization", format!("Bearer {}", session.access_token))
                .header("User-Agent", "better-npm/sardis-client")
                .send();
        }
    }

    let path = super::credentials::credentials_path();
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| SardisError::Network(e.to_string()))?;
    }

    Ok(())
}

#[derive(Debug)]
pub enum SardisError {
    NotAuthenticated,
    SessionExpired,
    InvalidCredentials,
    Network(String),
    Api { code: String, message: String },
}

impl std::fmt::Display for SardisError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAuthenticated => write!(f, "Not authenticated. Run `better login --sardis` first."),
            Self::SessionExpired => write!(f, "Session expired. Refreshing..."),
            Self::InvalidCredentials => write!(f, "Invalid credentials"),
            Self::Network(e) => write!(f, "Network error: {}", e),
            Self::Api { code, message } => write!(f, "Sardis API error: {} -- {}", code, message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sardis_login_request_serialization() {
        let req = SardisLoginRequest {
            email: Some("test@example.com".to_string()),
            api_key: None,
            device_id: "test-device".to_string(),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("test@example.com"));
        assert!(json.contains("test-device"));
    }

    #[test]
    fn test_sardis_error_display() {
        let err = SardisError::NotAuthenticated;
        assert!(err.to_string().contains("better login --sardis"));
    }
}
