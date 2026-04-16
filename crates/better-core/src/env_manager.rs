// crates/better-core/src/env_manager.rs
//
// Environment management for multi-env projects (v1.4 Task 111).
//
// Manages named environments (development/staging/production), each with
// its own env-var set and OSP service instances, stored in
// `.better/environments.json`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EnvironmentConfig {
    /// Named environments keyed by environment name
    pub environments: HashMap<String, Environment>,
    /// Currently active environment name
    pub current: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Environment {
    pub name: String,
    /// OSP service instances keyed by service alias
    pub services: HashMap<String, ServiceInstance>,
    /// Non-secret env vars for this environment (secrets come from vault)
    pub env_vars: HashMap<String, String>,
    /// Unix timestamp of creation
    pub created_at: u64,
    /// Unix timestamp of last `better env switch <name>`
    pub last_active: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceInstance {
    /// OSP service ID
    pub service_id: String,
    pub provider: String,
    pub tier: String,
    pub status: String,
    /// Vault reference for credentials
    pub credentials_ref: String,
}

#[derive(Debug)]
pub enum EnvError {
    NotFound(String),
    AlreadyExists(String),
    Io(std::io::Error),
    Serialize(String),
}

impl std::fmt::Display for EnvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(n) => write!(f, "Environment '{}' not found", n),
            Self::AlreadyExists(n) => write!(f, "Environment '{}' already exists", n),
            Self::Io(e) => write!(f, "I/O error: {}", e),
            Self::Serialize(s) => write!(f, "Serialization error: {}", s),
        }
    }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

pub struct EnvManager {
    config_path: PathBuf,
}

impl EnvManager {
    pub fn new(project_root: &Path) -> Self {
        Self {
            config_path: project_root.join(".better").join("environments.json"),
        }
    }

    /// Load the environment configuration from disk.
    pub fn load_config(&self) -> Result<EnvironmentConfig, EnvError> {
        if !self.config_path.exists() {
            return Ok(EnvironmentConfig::default());
        }
        let text = std::fs::read_to_string(&self.config_path)
            .map_err(EnvError::Io)?;
        serde_json::from_str(&text)
            .map_err(|e| EnvError::Serialize(e.to_string()))
    }

    /// Persist the environment configuration to disk.
    pub fn save_config(&self, config: &EnvironmentConfig) -> Result<(), EnvError> {
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent).map_err(EnvError::Io)?;
        }
        let text = serde_json::to_string_pretty(config)
            .map_err(|e| EnvError::Serialize(e.to_string()))?;
        std::fs::write(&self.config_path, text).map_err(EnvError::Io)
    }

    /// Switch to a different environment.
    pub fn switch(&self, env_name: &str) -> Result<Environment, EnvError> {
        let mut config = self.load_config()?;
        let env = config.environments.get(env_name)
            .ok_or_else(|| EnvError::NotFound(env_name.to_string()))?
            .clone();

        config.current = env_name.to_string();
        self.save_config(&config)?;
        Ok(env)
    }

    /// Create a new environment with default settings.
    pub fn create(&self, name: &str) -> Result<Environment, EnvError> {
        let mut config = self.load_config()?;
        if config.environments.contains_key(name) {
            return Err(EnvError::AlreadyExists(name.to_string()));
        }
        let env = Environment {
            name: name.to_string(),
            services: HashMap::new(),
            env_vars: HashMap::new(),
            created_at: unix_now(),
            last_active: unix_now(),
        };
        config.environments.insert(name.to_string(), env.clone());
        if config.current.is_empty() {
            config.current = name.to_string();
        }
        self.save_config(&config)?;
        Ok(env)
    }

    /// Delete an environment by name.
    pub fn delete(&self, name: &str) -> Result<(), EnvError> {
        let mut config = self.load_config()?;
        if !config.environments.contains_key(name) {
            return Err(EnvError::NotFound(name.to_string()));
        }
        config.environments.remove(name);
        if config.current == name {
            config.current = config.environments.keys().next().cloned().unwrap_or_default();
        }
        self.save_config(&config)
    }

    /// List all environment names.
    pub fn list(&self) -> Result<Vec<String>, EnvError> {
        let config = self.load_config()?;
        let mut names: Vec<String> = config.environments.keys().cloned().collect();
        names.sort();
        Ok(names)
    }

    /// Set an env-var in the specified environment.
    pub fn set_var(&self, env_name: &str, key: &str, value: &str) -> Result<(), EnvError> {
        let mut config = self.load_config()?;
        let env = config.environments.get_mut(env_name)
            .ok_or_else(|| EnvError::NotFound(env_name.to_string()))?;
        env.env_vars.insert(key.to_string(), value.to_string());
        self.save_config(&config)
    }

    /// Generate a `.env` file for the given environment.
    pub fn generate_env_file(&self, env: &Environment, dest: &Path) -> Result<(), EnvError> {
        let mut lines: Vec<String> = env.env_vars.iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();
        lines.sort();
        let content = lines.join("\n") + "\n";
        std::fs::write(dest, content).map_err(EnvError::Io)
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("env-mgr-test-{}", name))
    }

    #[test]
    fn create_and_list_environments() {
        let root = tmp_root("create-list");
        let mgr = EnvManager::new(&root);
        mgr.create("development").unwrap();
        mgr.create("production").unwrap();
        let list = mgr.list().unwrap();
        assert!(list.contains(&"development".to_string()));
        assert!(list.contains(&"production".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn switch_environment() {
        let root = tmp_root("switch");
        let mgr = EnvManager::new(&root);
        mgr.create("dev").unwrap();
        mgr.create("prod").unwrap();
        let env = mgr.switch("prod").unwrap();
        assert_eq!(env.name, "prod");
        let config = mgr.load_config().unwrap();
        assert_eq!(config.current, "prod");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn switch_nonexistent_errors() {
        let root = tmp_root("switch-missing");
        let mgr = EnvManager::new(&root);
        let err = mgr.switch("ghost").unwrap_err();
        assert!(matches!(err, EnvError::NotFound(_)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn duplicate_create_errors() {
        let root = tmp_root("dup-create");
        let mgr = EnvManager::new(&root);
        mgr.create("staging").unwrap();
        let err = mgr.create("staging").unwrap_err();
        assert!(matches!(err, EnvError::AlreadyExists(_)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn set_var_and_generate_env_file() {
        let root = tmp_root("env-file");
        let mgr = EnvManager::new(&root);
        mgr.create("local").unwrap();
        mgr.set_var("local", "DATABASE_URL", "postgres://localhost/mydb").unwrap();
        mgr.set_var("local", "PORT", "3000").unwrap();
        let config = mgr.load_config().unwrap();
        let env = config.environments.get("local").unwrap();
        let dest = root.join(".env");
        mgr.generate_env_file(env, &dest).unwrap();
        let content = std::fs::read_to_string(&dest).unwrap();
        assert!(content.contains("DATABASE_URL=postgres://localhost/mydb"));
        assert!(content.contains("PORT=3000"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_environment() {
        let root = tmp_root("delete");
        let mgr = EnvManager::new(&root);
        mgr.create("temp").unwrap();
        mgr.delete("temp").unwrap();
        let list = mgr.list().unwrap();
        assert!(!list.contains(&"temp".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_config_returns_default() {
        let mgr = EnvManager::new(Path::new("/nonexistent-project-xyz"));
        let config = mgr.load_config().unwrap();
        assert!(config.environments.is_empty());
    }

    #[test]
    fn env_error_display_messages() {
        let not_found = EnvError::NotFound("staging".to_string());
        assert!(not_found.to_string().contains("staging"));
        let already_exists = EnvError::AlreadyExists("prod".to_string());
        assert!(already_exists.to_string().contains("prod"));
        let serialize_err = EnvError::Serialize("bad json".to_string());
        assert!(serialize_err.to_string().contains("bad json"));
    }
}
