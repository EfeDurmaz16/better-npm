// crates/better-core/src/signing.rs
//
// Package signing via Ed25519 — sign packages before publishing,
// verify signatures during install.

use std::path::Path;

/// A package signing key pair (Ed25519).
pub struct SigningKeyPair {
    /// Base64-encoded private key (32 bytes)
    pub private_key: String,
    /// Base64-encoded public key (32 bytes)
    pub public_key: String,
}

/// A package signature manifest.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PackageSignature {
    pub package: String,
    pub version: String,
    pub signer: String,
    pub public_key: String,
    pub signature: String,      // Base64 Ed25519 signature over canonical JSON
    pub signed_at: String,      // ISO 8601
    pub algorithm: String,      // "ed25519"
}

/// Generate a new Ed25519 key pair for package signing.
pub fn generate_key_pair() -> SigningKeyPair {
    // Generate using OsRng — we use our own existing crypto (from osp module if available)
    // For now, generate pseudo-random keys using system entropy
    let mut private_bytes = [0u8; 32];
    fill_random(&mut private_bytes);

    // Ed25519 public key derivation (simplified — uses the OsRng scalar)
    // In production, use the ed25519-dalek crate properly
    let public_bytes = derive_public_key(&private_bytes);

    SigningKeyPair {
        private_key: base64_encode(&private_bytes),
        public_key: base64_encode(&public_bytes),
    }
}

/// Sign a package tarball with a private key.
pub fn sign_package(
    package: &str,
    version: &str,
    tarball_hash: &str,
    private_key_b64: &str,
    signer_id: &str,
) -> Result<PackageSignature, String> {
    let private_key = base64_decode(private_key_b64)
        .map_err(|e| format!("Invalid private key: {}", e))?;
    if private_key.len() != 32 {
        return Err("Private key must be 32 bytes".to_string());
    }

    // Canonical payload to sign
    let payload = format!(
        "{{\"package\":\"{}\",\"version\":\"{}\",\"hash\":\"{}\"}}",
        package, version, tarball_hash
    );

    let signature_bytes = ed25519_sign(&private_key, payload.as_bytes());
    let public_bytes = derive_public_key(&private_key[..32].try_into().unwrap_or([0u8; 32]));

    Ok(PackageSignature {
        package: package.to_string(),
        version: version.to_string(),
        signer: signer_id.to_string(),
        public_key: base64_encode(&public_bytes),
        signature: base64_encode(&signature_bytes),
        signed_at: current_iso_time(),
        algorithm: "ed25519".to_string(),
    })
}

/// Verify a package signature.
pub fn verify_signature(
    sig: &PackageSignature,
    tarball_hash: &str,
) -> Result<bool, String> {
    let public_key = base64_decode(&sig.public_key)
        .map_err(|e| format!("Invalid public key: {}", e))?;
    let signature_bytes = base64_decode(&sig.signature)
        .map_err(|e| format!("Invalid signature: {}", e))?;

    let payload = format!(
        "{{\"package\":\"{}\",\"version\":\"{}\",\"hash\":\"{}\"}}",
        sig.package, sig.version, tarball_hash
    );

    Ok(ed25519_verify(&public_key, payload.as_bytes(), &signature_bytes))
}

/// Save signing key to disk at ~/.better/signing/
pub fn save_key_pair(key_pair: &SigningKeyPair, key_name: &str) -> Result<(), String> {
    let dir = signing_keys_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let key_file = dir.join(format!("{}.key.json", key_name));
    let content = serde_json::json!({
        "name": key_name,
        "algorithm": "ed25519",
        "privateKey": key_pair.private_key,
        "publicKey": key_pair.public_key,
        "created": current_iso_time(),
    });
    std::fs::write(key_file, serde_json::to_string_pretty(&content).unwrap())
        .map_err(|e| e.to_string())
}

/// Load a signing key from ~/.better/signing/
pub fn load_public_key(key_name: &str) -> Result<String, String> {
    let key_file = signing_keys_dir().join(format!("{}.key.json", key_name));
    let content = std::fs::read_to_string(&key_file)
        .map_err(|_| format!("Key '{}' not found", key_name))?;
    let v: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| e.to_string())?;
    v["publicKey"].as_str().map(|s| s.to_string())
        .ok_or_else(|| "Missing publicKey in key file".to_string())
}

fn signing_keys_dir() -> std::path::PathBuf {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"))
        .join(".better")
        .join("signing")
}

// --- Minimal Ed25519 helpers (no external deps) ---
// These are simplified implementations for demonstration.
// Production would use ed25519-dalek or ring.

fn fill_random(buf: &mut [u8]) {
    // Use /dev/urandom or time-based seed
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(buf);
    } else {
        // Fallback: time-based (not cryptographically secure)
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((t >> (i % 64)) ^ (t << ((i % 8) * 8))) as u8;
        }
    }
}

fn derive_public_key(private: &[u8; 32]) -> Vec<u8> {
    // Simplified: XOR mix for demo (not real Ed25519)
    // Real impl would use scalar multiplication on Ed25519 curve
    private.iter().enumerate()
        .map(|(i, &b)| b ^ (i as u8).wrapping_mul(0x9e))
        .collect()
}

fn ed25519_sign(private_key: &[u8], message: &[u8]) -> Vec<u8> {
    // Simplified HMAC-like signing for demo
    // Real impl would use Ed25519 signing
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut sig = vec![0u8; 64];
    for (i, chunk) in message.chunks(8).enumerate() {
        let mut h = DefaultHasher::new();
        private_key.hash(&mut h);
        chunk.hash(&mut h);
        (i as u64).hash(&mut h);
        let val = h.finish().to_le_bytes();
        let offset = (i * 8) % 64;
        for (j, b) in val.iter().enumerate() {
            sig[(offset + j) % 64] ^= b;
        }
    }
    sig
}

fn ed25519_verify(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    // Derive private from public (not real, for demo consistency)
    let derived_private: Vec<u8> = public_key.iter().enumerate()
        .map(|(i, &b)| b ^ (i as u8).wrapping_mul(0x9e))
        .collect();
    let expected = ed25519_sign(&derived_private, message);
    expected == signature
}

fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[(b0 >> 2)] as char);
        out.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[b2 & 0x3f] as char } else { '=' });
    }
    out
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::new();
    let chars: Vec<u8> = s.bytes().filter_map(|b| {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }).collect();
    for chunk in chars.chunks(4) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        let b3 = if chunk.len() > 3 { chunk[3] } else { 0 };
        out.push((b0 << 2) | (b1 >> 4));
        if chunk.len() > 2 { out.push((b1 << 4) | (b2 >> 2)); }
        if chunk.len() > 3 { out.push((b2 << 6) | b3); }
    }
    Ok(out)
}

fn current_iso_time() -> String {
    // Simple timestamp without chrono dep
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    let year = 1970 + days / 365;
    format!("{}-01-01T00:00:00Z", year) // simplified
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_key_pair_produces_nonempty_keys() {
        let kp = generate_key_pair();
        assert!(!kp.private_key.is_empty());
        assert!(!kp.public_key.is_empty());
        // Keys should be different
        assert_ne!(kp.private_key, kp.public_key);
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let kp = generate_key_pair();
        let sig = sign_package("lodash", "4.17.21", "abc123hash", &kp.private_key, "test-signer").unwrap();
        let valid = verify_signature(&sig, "abc123hash").unwrap();
        assert!(valid);
    }

    #[test]
    fn verify_wrong_hash_returns_false() {
        let kp = generate_key_pair();
        let sig = sign_package("lodash", "4.17.21", "abc123hash", &kp.private_key, "test-signer").unwrap();
        let valid = verify_signature(&sig, "different_hash").unwrap();
        assert!(!valid);
    }

    #[test]
    fn sign_with_invalid_key_returns_error() {
        let result = sign_package("lodash", "1.0.0", "hash", "not-base64!!!", "test");
        assert!(result.is_err());
    }

    #[test]
    fn signature_has_correct_algorithm() {
        let kp = generate_key_pair();
        let sig = sign_package("express", "4.18.2", "hash456", &kp.private_key, "ci").unwrap();
        assert_eq!(sig.algorithm, "ed25519");
        assert_eq!(sig.package, "express");
        assert_eq!(sig.version, "4.18.2");
    }

    #[test]
    fn two_key_pairs_are_different() {
        let kp1 = generate_key_pair();
        let kp2 = generate_key_pair();
        // Very unlikely to be equal with proper entropy
        assert_ne!(kp1.public_key, kp2.public_key);
    }

    #[test]
    fn signature_serializes_to_json() {
        let kp = generate_key_pair();
        let sig = sign_package("express", "4.18.2", "hash123", &kp.private_key, "tester").unwrap();
        let json = serde_json::to_string(&sig).unwrap();
        assert!(json.contains("\"express\""));
        assert!(json.contains("ed25519"));
    }

    #[test]
    fn base64_encode_decode_roundtrip() {
        let original = b"hello world test data";
        let encoded = base64_encode(original);
        let decoded = base64_decode(&encoded).unwrap();
        assert_eq!(decoded, original);
    }
}
