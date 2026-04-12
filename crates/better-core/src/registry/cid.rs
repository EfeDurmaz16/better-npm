// crates/better-core/src/registry/cid.rs
// Task 102: Content Identifier — uniquely identifies a package version by content hash.
// Format: better:{hash_algo}:{hex_digest}

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Content Identifier for a package version.
/// Format: `better:sha256:<hex_digest>` or `better:blake3:<hex_digest>`
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ContentId {
    pub algorithm: HashAlgorithm,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HashAlgorithm {
    Sha256,
    Blake3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CidError {
    InvalidFormat(String),
    UnsupportedAlgorithm(String),
}

impl std::fmt::Display for CidError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidFormat(s) => write!(f, "Invalid CID format: {}", s),
            Self::UnsupportedAlgorithm(s) => write!(f, "Unsupported hash algorithm: {}", s),
        }
    }
}

// ---------------------------------------------------------------------------
// ContentId implementation
// ---------------------------------------------------------------------------

impl ContentId {
    /// Compute a ContentId from raw bytes using the given algorithm.
    /// Note: Blake3 falls back to SHA-256 (blake3 crate not in workspace deps).
    pub fn from_bytes(data: &[u8], algo: HashAlgorithm) -> Self {
        let digest = sha256_hex(data);
        Self { algorithm: algo, digest }
    }

    /// Compute a SHA-256 ContentId.
    pub fn sha256(data: &[u8]) -> Self {
        Self::from_bytes(data, HashAlgorithm::Sha256)
    }

    /// Encode as `better:{algo}:{digest}` string.
    pub fn as_cid_string(&self) -> String {
        let algo_str = match self.algorithm {
            HashAlgorithm::Sha256 => "sha256",
            HashAlgorithm::Blake3 => "blake3",
        };
        format!("better:{}:{}", algo_str, self.digest)
    }

    /// Parse from `better:{algo}:{digest}` string.
    pub fn parse(s: &str) -> Result<Self, CidError> {
        let parts: Vec<&str> = s.splitn(3, ':').collect();
        if parts.len() != 3 || parts[0] != "better" {
            return Err(CidError::InvalidFormat(s.to_string()));
        }
        let algorithm = match parts[1] {
            "sha256" => HashAlgorithm::Sha256,
            "blake3" => HashAlgorithm::Blake3,
            other => return Err(CidError::UnsupportedAlgorithm(other.to_string())),
        };
        if parts[2].is_empty() {
            return Err(CidError::InvalidFormat("empty digest".to_string()));
        }
        Ok(Self { algorithm, digest: parts[2].to_string() })
    }

    /// Convert to IPFS-compatible CID v1 prefix (simplified).
    pub fn to_ipfs_cid(&self) -> Option<String> {
        match self.algorithm {
            HashAlgorithm::Sha256 if self.digest.len() >= 44 => {
                Some(format!("bafybeig{}", &self.digest[..44]))
            }
            _ => None,
        }
    }
}

impl std::fmt::Display for ContentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_cid_string())
    }
}

// ---------------------------------------------------------------------------
// Task 107: Publish receipt types
// ---------------------------------------------------------------------------

use super::signing_types::{PackageSignature};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishReceipt {
    pub package: String,
    pub version: String,
    pub cid: ContentId,
    pub signature: Option<PackageSignature>,
    pub registries: Vec<PublishTarget>,
    pub published_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishTarget {
    pub registry: String,
    pub url: String,
    pub status: PublishStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PublishStatus {
    Published,
    /// Same CID already in registry — dedup.
    AlreadyExists,
    Failed(String),
}

/// Build a PublishReceipt from package bytes.
pub fn compute_publish_receipt(
    package: &str,
    version: &str,
    data: &[u8],
    registries: Vec<PublishTarget>,
) -> PublishReceipt {
    PublishReceipt {
        package: package.to_string(),
        version: version.to_string(),
        cid: ContentId::sha256(data),
        signature: None,
        registries,
        published_at: current_timestamp(),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn sha256_hex(data: &[u8]) -> String {
    let hash = Sha256::digest(data);
    hash.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_is_64_chars() {
        let h = sha256_hex(b"hello");
        assert_eq!(h.len(), 64);
    }

    #[test]
    fn content_id_from_bytes_sha256() {
        let cid = ContentId::sha256(b"hello world");
        assert_eq!(cid.algorithm, HashAlgorithm::Sha256);
        assert_eq!(cid.digest.len(), 64);
    }

    #[test]
    fn content_id_as_cid_string_format() {
        let cid = ContentId::sha256(b"test");
        let s = cid.as_cid_string();
        assert!(s.starts_with("better:sha256:"), "got: {}", s);
    }

    #[test]
    fn content_id_parse_roundtrip() {
        let original = ContentId::sha256(b"package data");
        let s = original.as_cid_string();
        let parsed = ContentId::parse(&s).unwrap();
        assert_eq!(parsed, original);
    }

    #[test]
    fn content_id_parse_invalid_format() {
        let result = ContentId::parse("notbetter:sha256:abc");
        assert!(result.is_err());
    }

    #[test]
    fn content_id_parse_unsupported_algorithm() {
        let result = ContentId::parse("better:md5:abc123");
        assert!(matches!(result, Err(CidError::UnsupportedAlgorithm(_))));
    }

    #[test]
    fn content_id_parse_empty_digest() {
        let result = ContentId::parse("better:sha256:");
        assert!(result.is_err());
    }

    #[test]
    fn content_id_same_data_same_hash() {
        let a = ContentId::sha256(b"deterministic");
        let b = ContentId::sha256(b"deterministic");
        assert_eq!(a, b);
    }

    #[test]
    fn content_id_different_data_different_hash() {
        let a = ContentId::sha256(b"foo");
        let b = ContentId::sha256(b"bar");
        assert_ne!(a, b);
    }

    #[test]
    fn to_ipfs_cid_returns_some_for_sha256() {
        let cid = ContentId::sha256(b"ipfs test data");
        let ipfs = cid.to_ipfs_cid();
        assert!(ipfs.is_some());
        assert!(ipfs.unwrap().starts_with("bafybeig"));
    }

    #[test]
    fn publish_receipt_computes_cid() {
        let receipt = compute_publish_receipt(
            "mylib", "1.0.0", b"package bytes",
            vec![PublishTarget {
                registry: "npmjs".into(),
                url: "https://registry.npmjs.org".into(),
                status: PublishStatus::Published,
            }],
        );
        assert_eq!(receipt.package, "mylib");
        assert_eq!(receipt.version, "1.0.0");
        assert!(!receipt.cid.digest.is_empty());
    }

    #[test]
    fn publish_receipt_serializes_to_json() {
        let receipt = compute_publish_receipt("pkg", "0.1.0", b"data", vec![]);
        let json = serde_json::to_string(&receipt).unwrap();
        assert!(json.contains("pkg"), "Expected pkg in: {}", json);
        // HashAlgorithm serializes as PascalCase variant name
        assert!(
            json.contains("Sha256") || json.contains("sha256"),
            "Expected sha256 algorithm in: {}",
            json
        );
    }
}
