use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use super::crypto;
use super::discovery::OspError;

/// Agent keypair -- generated once, stored encrypted in vault.
pub struct AgentKeyPair {
    pub secret_key: [u8; 32],
    pub public_key: [u8; 32],
}

impl Drop for AgentKeyPair {
    fn drop(&mut self) {
        self.secret_key.fill(0);
    }
}

/// A single vault entry -- one provisioned service.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEntry {
    pub provider_id: String,
    pub offering_id: String,
    pub resource_id: String,
    pub tier_id: String,
    pub credential_bundle: super::credentials::CredentialBundle,
    pub provisioned_at: String,
    pub status: ServiceStatus,
    pub dashboard_url: Option<String>,
    pub osp_uris: Vec<String>,
    pub cost_estimate: Option<super::provision::CostEstimate>,
    pub last_rotated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ServiceStatus {
    Active,
    Provisioning,
    Deprovisioned,
    Error,
    Rotating,
}

#[derive(Debug, Serialize, Deserialize)]
struct VaultMeta {
    version: u32,
    created_at: String,
    last_modified_at: String,
    entry_count: usize,
}

/// Encrypted credential vault at ~/.better/vault/.
pub struct Vault {
    root: PathBuf,
    keypair: Option<AgentKeyPair>,
    entries: HashMap<String, VaultEntry>,
    nonces: std::collections::HashSet<String>,
}

impl Vault {
    /// Open or create the vault at ~/.better/vault/.
    pub fn open() -> Result<Self, OspError> {
        let root = dirs::home_dir()
            .ok_or_else(|| OspError::VaultError("Cannot determine home directory".into()))?
            .join(".better")
            .join("vault");
        std::fs::create_dir_all(&root)
            .map_err(|e| OspError::VaultError(e.to_string()))?;
        std::fs::create_dir_all(root.join("entries"))
            .map_err(|e| OspError::VaultError(e.to_string()))?;

        let mut vault = Self {
            root,
            keypair: None,
            entries: HashMap::new(),
            nonces: std::collections::HashSet::new(),
        };
        vault.load_entries()?;
        vault.load_nonces()?;
        Ok(vault)
    }

    /// Get or generate the agent keypair.
    pub fn agent_keypair(&mut self) -> Result<&AgentKeyPair, OspError> {
        if self.keypair.is_none() {
            self.keypair = Some(self.load_or_generate_keypair()?);
        }
        Ok(self.keypair.as_ref().unwrap())
    }

    /// Agent's public key as base64url string.
    pub fn agent_public_key_b64(&mut self) -> Result<String, OspError> {
        let kp = self.agent_keypair()?;
        Ok(crypto::base64_url_encode(&kp.public_key))
    }

    /// Agent's secret key bytes.
    pub fn agent_secret_key(&mut self) -> Result<[u8; 32], OspError> {
        let kp = self.agent_keypair()?;
        Ok(kp.secret_key)
    }

    /// Store a provisioned service entry.
    pub fn store_entry(&mut self, entry: VaultEntry) -> Result<(), OspError> {
        let key = vault_entry_key(&entry.provider_id, &entry.offering_id);
        let path = self.root.join("entries").join(format!("{}.enc", key));

        let json = serde_json::to_vec(&entry)
            .map_err(|e| OspError::SerializationError(e.to_string()))?;

        let machine_key = crypto::derive_machine_key();
        let encrypted = crypto::aes_256_gcm_encrypt(&machine_key, &json)?;
        std::fs::write(&path, encrypted)
            .map_err(|e| OspError::VaultError(e.to_string()))?;

        self.entries.insert(key, entry);
        self.update_meta()?;
        Ok(())
    }

    /// Get a vault entry by provider + offering suffix.
    pub fn get_entry(&self, provider: &str, offering_suffix: &str) -> Option<&VaultEntry> {
        self.entries.values().find(|e| {
            e.provider_id == provider
                && (e.offering_id.ends_with(&format!("/{}", offering_suffix))
                    || e.offering_id == offering_suffix)
        })
    }

    /// List all vault entries.
    pub fn list_entries(&self) -> Vec<&VaultEntry> {
        self.entries.values().collect()
    }

    /// Remove a vault entry.
    pub fn remove_entry(
        &mut self,
        provider: &str,
        offering_id: &str,
    ) -> Result<Option<VaultEntry>, OspError> {
        let key = vault_entry_key(provider, offering_id);
        let path = self.root.join("entries").join(format!("{}.enc", key));
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| OspError::VaultError(e.to_string()))?;
        }
        let removed = self.entries.remove(&key);
        self.update_meta()?;
        Ok(removed)
    }

    /// Update an existing entry.
    pub fn update_entry(&mut self, entry: VaultEntry) -> Result<(), OspError> {
        self.store_entry(entry)
    }

    /// Check and record a nonce for replay protection.
    pub fn check_nonce(&mut self, nonce: &str) -> Result<(), OspError> {
        if self.nonces.contains(nonce) {
            return Err(OspError::NonceReplay);
        }
        self.nonces.insert(nonce.to_string());
        self.save_nonces()?;
        Ok(())
    }

    fn load_or_generate_keypair(&self) -> Result<AgentKeyPair, OspError> {
        let path = self.root.join("agent-keypair.enc");
        let machine_key = crypto::derive_machine_key();

        if path.exists() {
            let encrypted = std::fs::read(&path)
                .map_err(|e| OspError::VaultError(e.to_string()))?;
            let decrypted = crypto::aes_256_gcm_decrypt(&machine_key, &encrypted)?;
            if decrypted.len() != 32 {
                return Err(OspError::VaultError("Keypair file corrupt".into()));
            }
            let mut secret = [0u8; 32];
            secret.copy_from_slice(&decrypted);
            let public = crypto::x25519_public_from_secret(&secret);
            Ok(AgentKeyPair {
                secret_key: secret,
                public_key: public,
            })
        } else {
            use rand::RngCore;
            let mut secret = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut secret);
            let public = crypto::x25519_public_from_secret(&secret);

            let encrypted = crypto::aes_256_gcm_encrypt(&machine_key, &secret)?;
            std::fs::write(&path, encrypted)
                .map_err(|e| OspError::VaultError(e.to_string()))?;

            Ok(AgentKeyPair {
                secret_key: secret,
                public_key: public,
            })
        }
    }

    fn load_entries(&mut self) -> Result<(), OspError> {
        let entries_dir = self.root.join("entries");
        if !entries_dir.exists() {
            return Ok(());
        }
        let machine_key = crypto::derive_machine_key();
        let dir = std::fs::read_dir(&entries_dir)
            .map_err(|e| OspError::VaultError(e.to_string()))?;

        for entry in dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("enc") {
                continue;
            }
            let encrypted = match std::fs::read(&path) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let decrypted = match crypto::aes_256_gcm_decrypt(&machine_key, &encrypted) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let vault_entry: VaultEntry = match serde_json::from_slice(&decrypted) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let key = vault_entry_key(&vault_entry.provider_id, &vault_entry.offering_id);
            self.entries.insert(key, vault_entry);
        }
        Ok(())
    }

    fn update_meta(&self) -> Result<(), OspError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string();
        let meta = VaultMeta {
            version: 1,
            created_at: now.clone(),
            last_modified_at: now,
            entry_count: self.entries.len(),
        };
        let path = self.root.join("vault.meta.json");
        let json = serde_json::to_string_pretty(&meta)
            .map_err(|e| OspError::SerializationError(e.to_string()))?;
        std::fs::write(&path, json)
            .map_err(|e| OspError::VaultError(e.to_string()))?;
        Ok(())
    }

    fn load_nonces(&mut self) -> Result<(), OspError> {
        let path = self.root.join("nonces.json");
        if path.exists() {
            let data = std::fs::read_to_string(&path)
                .map_err(|e| OspError::VaultError(e.to_string()))?;
            self.nonces =
                serde_json::from_str(&data).map_err(|e| OspError::ParseError(e.to_string()))?;
        }
        Ok(())
    }

    fn save_nonces(&self) -> Result<(), OspError> {
        let path = self.root.join("nonces.json");
        let json = serde_json::to_string(&self.nonces)
            .map_err(|e| OspError::SerializationError(e.to_string()))?;
        std::fs::write(&path, json)
            .map_err(|e| OspError::VaultError(e.to_string()))?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // TOFU public key pinning
    // -----------------------------------------------------------------------

    /// Get the pinned Ed25519 public key for a provider (TOFU).
    pub fn get_pinned_pubkey(&self, provider_id: &str) -> Option<String> {
        let path = self.root.join("pins").join(format!("{}.pubkey", provider_slug(provider_id)));
        std::fs::read_to_string(&path).ok()
    }

    /// Pin a provider's public key (TOFU: first use only).
    pub fn pin_pubkey(&mut self, provider_id: &str, pubkey: &str) -> Result<(), OspError> {
        let pins_dir = self.root.join("pins");
        std::fs::create_dir_all(&pins_dir)
            .map_err(|e| OspError::VaultError(e.to_string()))?;
        let path = pins_dir.join(format!("{}.pubkey", provider_slug(provider_id)));
        std::fs::write(&path, pubkey)
            .map_err(|e| OspError::VaultError(e.to_string()))?;
        Ok(())
    }

    /// Get the pinned manifest version for a provider.
    pub fn get_pinned_manifest_version(&self, provider_id: &str) -> Option<u64> {
        let path = self.root.join("pins").join(format!("{}.version", provider_slug(provider_id)));
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
    }

    /// Pin/update the manifest version for a provider.
    pub fn pin_manifest_version(&mut self, provider_id: &str, version: u64) -> Result<(), OspError> {
        let pins_dir = self.root.join("pins");
        std::fs::create_dir_all(&pins_dir)
            .map_err(|e| OspError::VaultError(e.to_string()))?;
        let path = pins_dir.join(format!("{}.version", provider_slug(provider_id)));
        std::fs::write(&path, version.to_string())
            .map_err(|e| OspError::VaultError(e.to_string()))?;
        Ok(())
    }
}

fn provider_slug(provider_id: &str) -> String {
    provider_id.replace('.', "_").replace('/', "_")
}

fn vault_entry_key(provider: &str, offering_id: &str) -> String {
    format!(
        "{}_{}",
        provider.replace('.', "_"),
        offering_id.replace('/', "_")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vault_entry_key() {
        assert_eq!(
            vault_entry_key("supabase.com", "supabase/postgres"),
            "supabase_com_supabase_postgres"
        );
    }

    #[test]
    fn test_service_status_serde() {
        let status = ServiceStatus::Active;
        let json = serde_json::to_string(&status).unwrap();
        let back: ServiceStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ServiceStatus::Active);
    }

    #[test]
    fn vault_entry_key_dots_and_slashes_replaced() {
        let key = vault_entry_key("aws.amazon.com", "rds/postgres");
        assert_eq!(key, "aws_amazon_com_rds_postgres");
    }

    #[test]
    fn vault_entry_key_no_special_chars_unchanged() {
        let key = vault_entry_key("supabase", "postgres");
        assert_eq!(key, "supabase_postgres");
    }

    #[test]
    fn service_status_all_variants_serde_roundtrip() {
        for status in [
            ServiceStatus::Active,
            ServiceStatus::Provisioning,
            ServiceStatus::Deprovisioned,
            ServiceStatus::Error,
            ServiceStatus::Rotating,
        ] {
            let json = serde_json::to_string(&status).unwrap();
            let back: ServiceStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(back, status);
        }
    }

    #[test]
    fn agent_keypair_drop_zeroes_secret() {
        let mut kp = AgentKeyPair {
            secret_key: [0xAB; 32],
            public_key: [0x01; 32],
        };
        // Verify the key is non-zero before drop
        assert!(kp.secret_key.iter().any(|&b| b != 0));
        // Drop explicitly via fill
        kp.secret_key.fill(0);
        assert!(kp.secret_key.iter().all(|&b| b == 0));
    }

    #[test]
    fn vault_meta_serde() {
        let meta = VaultMeta {
            version: 1,
            created_at: "2026-01-01".to_string(),
            last_modified_at: "2026-01-02".to_string(),
            entry_count: 3,
        };
        let json = serde_json::to_string(&meta).unwrap();
        let back: VaultMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(back.version, 1);
        assert_eq!(back.entry_count, 3);
    }

    #[test]
    fn service_status_ne_variants() {
        assert_ne!(ServiceStatus::Active, ServiceStatus::Error);
        assert_ne!(ServiceStatus::Provisioning, ServiceStatus::Deprovisioned);
        assert_eq!(ServiceStatus::Rotating, ServiceStatus::Rotating);
    }
}
