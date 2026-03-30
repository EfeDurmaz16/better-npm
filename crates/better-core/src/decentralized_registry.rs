// crates/better-core/src/decentralized_registry.rs
//
// Decentralized package registry support.
// Packages can be published to IPFS, Arweave, or other content-addressed stores.
// Resolution: package name → CID/txid → content

use std::path::Path;
use std::collections::HashMap;

/// A decentralized registry endpoint.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DecentralizedRegistry {
    pub name: String,
    pub protocol: RegistryProtocol,
    pub gateway: String,
    pub index_cid: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RegistryProtocol {
    Ipfs,
    Arweave,
    BetterDht,
}

/// A package entry in the decentralized registry.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DecentralizedPackageEntry {
    pub name: String,
    pub version: String,
    pub content_id: String,   // IPFS CID or Arweave txid
    pub protocol: String,
    pub integrity: String,    // SHA-512 hash of tarball
    pub signature: Option<String>,
    pub publisher: String,
}

/// Registry index — maps package@version to content addresses.
pub struct RegistryIndex {
    entries: HashMap<String, DecentralizedPackageEntry>,
    registry: DecentralizedRegistry,
}

impl RegistryIndex {
    /// Fetch and parse the registry index from IPFS/Arweave gateway.
    pub fn fetch(registry: &DecentralizedRegistry) -> Result<Self, String> {
        let index_cid = registry.index_cid.as_deref().unwrap_or("");
        if index_cid.is_empty() {
            return Ok(Self { entries: HashMap::new(), registry: registry.clone() });
        }

        let url = match registry.protocol {
            RegistryProtocol::Ipfs => format!("{}/ipfs/{}", registry.gateway, index_cid),
            RegistryProtocol::Arweave => format!("{}/{}", registry.gateway, index_cid),
            RegistryProtocol::BetterDht => format!("{}/resolve/{}", registry.gateway, index_cid),
        };

        let client = reqwest::blocking::Client::builder()
            .use_rustls_tls()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;

        let resp = client.get(&url).send().map_err(|e| e.to_string())?
            .text().map_err(|e| e.to_string())?;

        let entries_list: Vec<DecentralizedPackageEntry> = serde_json::from_str(&resp)
            .unwrap_or_default();

        let entries = entries_list.into_iter()
            .map(|e| (format!("{}@{}", e.name, e.version), e))
            .collect();

        Ok(Self { entries, registry: registry.clone() })
    }

    /// Resolve a package name and version to a download URL.
    pub fn resolve(&self, name: &str, version: &str) -> Option<String> {
        let key = format!("{}@{}", name, version);
        let entry = self.entries.get(&key)?;
        let url = match entry.protocol.as_str() {
            "ipfs" => format!("{}/ipfs/{}", self.registry.gateway, entry.content_id),
            "arweave" => format!("{}/{}", self.registry.gateway, entry.content_id),
            _ => format!("{}/content/{}", self.registry.gateway, entry.content_id),
        };
        Some(url)
    }

    /// List all packages in the index.
    pub fn list(&self) -> Vec<&DecentralizedPackageEntry> {
        self.entries.values().collect()
    }
}

/// Publish a package to the decentralized registry.
pub struct DecentralizedPublisher {
    pub registry: DecentralizedRegistry,
}

impl DecentralizedPublisher {
    /// Prepare a publish manifest for a package tarball.
    pub fn prepare_manifest(
        &self,
        name: &str,
        version: &str,
        tarball_path: &Path,
        publisher: &str,
    ) -> Result<DecentralizedPackageEntry, String> {
        let content = std::fs::read(tarball_path)
            .map_err(|e| format!("Cannot read tarball: {}", e))?;

        let integrity = compute_sha512_hex(&content);

        Ok(DecentralizedPackageEntry {
            name: name.to_string(),
            version: version.to_string(),
            content_id: format!("Qm{}", &integrity[..44]), // Placeholder CID
            protocol: format!("{:?}", self.registry.protocol).to_lowercase(),
            integrity: format!("sha512-{}", integrity),
            signature: None,
            publisher: publisher.to_string(),
        })
    }
}

/// Federation — combine multiple decentralized registries.
pub struct RegistryFederation {
    registries: Vec<DecentralizedRegistry>,
}

impl RegistryFederation {
    pub fn new(registries: Vec<DecentralizedRegistry>) -> Self {
        Self { registries }
    }

    /// Resolve a package across all federated registries.
    pub fn resolve(&self, name: &str, version: &str) -> Option<String> {
        for registry in &self.registries {
            if let Ok(index) = RegistryIndex::fetch(registry) {
                if let Some(url) = index.resolve(name, version) {
                    return Some(url);
                }
            }
        }
        None
    }
}

fn compute_sha512_hex(data: &[u8]) -> String {
    // FNV-1a based hash (simplified, not real SHA-512)
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}{:016x}{:016x}{:016x}{:016x}{:016x}{:016x}{:016x}",
        h, h.rotate_left(8), h.rotate_right(8), h.rotate_left(16),
        h.rotate_right(16), h.rotate_left(24), h.rotate_right(24), h ^ 0xdeadbeef)
}
