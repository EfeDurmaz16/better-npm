// crates/better-core/src/registry/signing_types.rs
// Shared signing types re-used across registry submodules.

use serde::{Deserialize, Serialize};

/// Signature of a package artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageSignature {
    pub key_id: String,
    /// Base64-encoded Ed25519 signature.
    pub signature: String,
    pub signed_at: u64,
    /// SHA-256 of the signed content.
    pub payload_hash: String,
}
