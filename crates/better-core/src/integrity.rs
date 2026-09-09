//! Validated npm integrity identities. SHA-1 is retained for legacy lockfiles.
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256, Sha384, Sha512};

#[derive(Clone, Debug)]
pub struct Integrity {
    algorithm: &'static str,
    digest: Vec<u8>,
}

impl Integrity {
    /// Native CAS currently supports one SRI digest per package.
    pub fn parse(value: &str) -> Result<Self, String> {
        let (algorithm, encoded) = value.split_once('-')
            .ok_or_else(|| "Invalid integrity: expected algorithm-base64 digest".to_string())?;
        let (algorithm, length) = match algorithm {
            "sha1" => ("sha1", 20),
            "sha256" => ("sha256", 32),
            "sha384" => ("sha384", 48),
            "sha512" => ("sha512", 64),
            _ => return Err("Unsupported integrity algorithm".to_string()),
        };
        let digest = STANDARD.decode(encoded)
            .map_err(|_| "Invalid integrity: expected one canonical base64 digest".to_string())?;
        if digest.len() != length {
            return Err(format!("Invalid {} integrity: expected {} digest bytes", algorithm, length));
        }
        Ok(Self { algorithm, digest })
    }

    pub fn algorithm(&self) -> &'static str { self.algorithm }

    pub fn hex_digest(&self) -> String {
        self.digest.iter().map(|byte| format!("{:02x}", byte)).collect()
    }

    pub fn verifier(&self) -> IntegrityVerifier {
        let hasher = match self.algorithm {
            "sha1" => Hasher::Sha1(sha1::Sha1::new()),
            "sha256" => Hasher::Sha256(Sha256::new()),
            "sha384" => Hasher::Sha384(Sha384::new()),
            _ => Hasher::Sha512(Sha512::new()),
        };
        IntegrityVerifier { expected: self.digest.clone(), hasher }
    }

    pub fn verify(&self, bytes: &[u8]) -> Result<(), String> {
        let mut verifier = self.verifier();
        verifier.update(bytes);
        verifier.finish()
    }

    pub fn verify_reader(&self, mut reader: impl std::io::Read) -> Result<(), String> {
        let mut verifier = self.verifier();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = reader.read(&mut buffer).map_err(|e| format!("Failed to read integrity input: {e}"))?;
            if count == 0 { break; }
            verifier.update(&buffer[..count]);
        }
        verifier.finish()
    }
}

enum Hasher {
    Sha1(sha1::Sha1),
    Sha256(Sha256),
    Sha384(Sha384),
    Sha512(Sha512),
}

pub struct IntegrityVerifier {
    expected: Vec<u8>,
    hasher: Hasher,
}

impl IntegrityVerifier {
    pub fn update(&mut self, bytes: &[u8]) {
        match &mut self.hasher {
            Hasher::Sha1(h) => h.update(bytes),
            Hasher::Sha256(h) => h.update(bytes),
            Hasher::Sha384(h) => h.update(bytes),
            Hasher::Sha512(h) => h.update(bytes),
        }
    }

    pub fn finish(self) -> Result<(), String> {
        let actual = match self.hasher {
            Hasher::Sha1(h) => h.finalize().to_vec(),
            Hasher::Sha256(h) => h.finalize().to_vec(),
            Hasher::Sha384(h) => h.finalize().to_vec(),
            Hasher::Sha512(h) => h.finalize().to_vec(),
        };
        if actual != self.expected { return Err("Integrity mismatch".to_string()); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vectors_and_incremental_verification() {
        for (algorithm, digest) in [
            ("sha1", "qZk+NkcGgWq6PiVxeFDCbJzQ2J0="),
            ("sha256", "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="),
            ("sha384", "ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn"),
            ("sha512", "3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw=="),
        ] {
            let parsed = Integrity::parse(&format!("{algorithm}-{digest}")).unwrap();
            parsed.verify(b"abc").unwrap();
            assert!(parsed.verify(b"abd").is_err());
            let mut stream = parsed.verifier();
            stream.update(b"a"); stream.update(b"bc"); stream.finish().unwrap();
        }
    }

    #[test]
    fn rejects_unsafe_or_unsupported_identities() {
        for input in ["sha512-", "sha512-AAAA", "sha1-AAAA", "../escape-AQID", "sha999-AQID", "sha512-💣", "sha512-AAAA sha1-AAAA", "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=?option"] {
            assert!(Integrity::parse(input).is_err(), "accepted {input}");
        }
    }
}
