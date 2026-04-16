use super::discovery::OspError;

// ──────────────────────────────────────────────
// Base64url helpers
// ──────────────────────────────────────────────

pub fn base64_url_decode(input: &str) -> Result<Vec<u8>, OspError> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|e| OspError::Base64Error(e.to_string()))
}

pub fn base64_url_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// ──────────────────────────────────────────────
// Ed25519 signature verification
// ──────────────────────────────────────────────

pub fn verify_ed25519(
    public_key_b64: &str,
    message: &[u8],
    signature_b64: &str,
) -> Result<bool, OspError> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let pubkey_bytes = base64_url_decode(public_key_b64)?;
    let verifying_key = VerifyingKey::from_bytes(
        &pubkey_bytes
            .try_into()
            .map_err(|_| OspError::InvalidPublicKey)?,
    )
    .map_err(|_| OspError::InvalidPublicKey)?;

    let sig_bytes = base64_url_decode(signature_b64)?;
    let signature = Signature::from_bytes(
        &sig_bytes
            .try_into()
            .map_err(|_| OspError::InvalidSignature)?,
    );

    verifying_key
        .verify(message, &signature)
        .map_err(|_| OspError::SignatureVerificationFailed)?;

    Ok(true)
}

// ──────────────────────────────────────────────
// X25519 key agreement
// ──────────────────────────────────────────────

pub fn x25519_public_from_secret(secret: &[u8; 32]) -> [u8; 32] {
    use x25519_dalek::{PublicKey, StaticSecret};
    let s = StaticSecret::from(*secret);
    let p: PublicKey = (&s).into();
    *p.as_bytes()
}

pub fn x25519_diffie_hellman(
    our_secret: &[u8; 32],
    their_public_b64: &str,
) -> Result<[u8; 32], OspError> {
    use x25519_dalek::{PublicKey, StaticSecret};

    let their_bytes = base64_url_decode(their_public_b64)?;
    let their_public = PublicKey::from(
        <[u8; 32]>::try_from(their_bytes.as_slice())
            .map_err(|_| OspError::DecryptionFailed)?,
    );

    let our_secret = StaticSecret::from(*our_secret);
    let shared = our_secret.diffie_hellman(&their_public);
    Ok(*shared.as_bytes())
}

// ──────────────────────────────────────────────
// AES-256-GCM
// ──────────────────────────────────────────────

pub fn aes_256_gcm_encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, OspError> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
    use rand::RngCore;

    let key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key);
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| OspError::VaultError("Encryption failed".into()))?;

    // Prepend nonce to ciphertext
    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

pub fn aes_256_gcm_decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, OspError> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};

    if data.len() < 12 {
        return Err(OspError::VaultError("Data too short".into()));
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| OspError::DecryptionFailed)
}

pub fn aes_256_gcm_decrypt_with_key_and_nonce(
    key: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, OspError> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};

    let key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| OspError::DecryptionFailed)
}

// ──────────────────────────────────────────────
// Nonce generation
// ──────────────────────────────────────────────

pub fn generate_nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64_url_encode(&bytes)
}

pub fn generate_idempotency_key(offering_id: &str, tier_id: &str, project_name: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(offering_id.as_bytes());
    hasher.update(tier_id.as_bytes());
    hasher.update(project_name.as_bytes());
    // Include timestamp for uniqueness
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();
    hasher.update(ts.as_bytes());
    base64_url_encode(&hasher.finalize())
}

// ──────────────────────────────────────────────
// Machine-local key derivation (for vault encryption)
// ──────────────────────────────────────────────

pub fn derive_machine_key() -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let hostname = gethostname::gethostname();
    let username = whoami::username();
    let mut hasher = Sha256::new();
    hasher.update(b"better-vault-v1:");
    hasher.update(hostname.as_encoded_bytes());
    hasher.update(b":");
    hasher.update(username.as_bytes());
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base64_url_roundtrip() {
        let data = b"hello OSP world";
        let encoded = base64_url_encode(data);
        let decoded = base64_url_decode(&encoded).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_base64_url_decode_known() {
        let result = base64_url_decode("dGVzdA").unwrap();
        assert_eq!(result, b"test");
    }

    #[test]
    fn test_x25519_keypair_deterministic() {
        let secret = [42u8; 32];
        let pub1 = x25519_public_from_secret(&secret);
        let pub2 = x25519_public_from_secret(&secret);
        assert_eq!(pub1, pub2);
        assert_ne!(pub1, secret);
    }

    #[test]
    fn test_aes_roundtrip() {
        let key = [1u8; 32];
        let plaintext = b"hello world credentials";
        let encrypted = aes_256_gcm_encrypt(&key, plaintext).unwrap();
        let decrypted = aes_256_gcm_decrypt(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_aes_wrong_key_fails() {
        let key1 = [1u8; 32];
        let key2 = [2u8; 32];
        let encrypted = aes_256_gcm_encrypt(&key1, b"secret").unwrap();
        let result = aes_256_gcm_decrypt(&key2, &encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn test_nonce_uniqueness() {
        let n1 = generate_nonce();
        let n2 = generate_nonce();
        assert_ne!(n1, n2);
        assert!(n1.len() >= 32);
    }

    #[test]
    fn test_machine_key_deterministic() {
        let k1 = derive_machine_key();
        let k2 = derive_machine_key();
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_aes_ciphertext_differs_from_plaintext() {
        let key = [7u8; 32];
        let plaintext = b"sensitive credentials data";
        let ciphertext = aes_256_gcm_encrypt(&key, plaintext).unwrap();
        // Ciphertext should differ from plaintext
        assert_ne!(ciphertext.as_slice(), plaintext.as_slice());
        // Ciphertext should be longer (includes nonce + tag)
        assert!(ciphertext.len() > plaintext.len());
    }
}
