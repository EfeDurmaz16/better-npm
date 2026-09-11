use std::collections::HashSet;

use crate::types::ResolvedPackage;
use crate::{extract_json_field, extract_json_object_raw, JsonWriter};

// === Provenance verification (Sigstore attestation checking) ===

#[derive(Debug, Clone)]
pub struct ProvenanceAttestation {
    pub package: String,
    pub version: String,
    pub has_attestation: bool,
    pub signature_valid: bool,
    pub transparency_log: bool,
    pub source_repo: Option<String>,
    pub build_trigger: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug)]
pub struct ProvenanceReport {
    pub total_checked: u64,
    pub with_provenance: u64,
    pub without_provenance: u64,
    pub verification_errors: u64,
    pub attestations: Vec<ProvenanceAttestation>,
}

/// Fetch attestation bundle from npm registry for a given package@version.
/// Returns the raw JSON response or an error.
fn fetch_attestation(
    name: &str,
    version: &str,
    config: &crate::types::NpmrcConfig,
) -> Result<String, String> {
    if version.is_empty() || !version.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+' | b'_')) {
        return Err("invalid version for provenance registry request".into());
    }
    let (base, _) = crate::npmrc::registry_for_package(config, name);
    let identity = format!("{name}@{version}");
    let url =
        crate::audit::evidence::registry_url(base, &["-", "npm", "v1", "attestations", &identity])?;
    let token = crate::audit::evidence::registry_token(config, base, &url, name);
    match crate::audit::evidence::registry_get(&url, token)? {
        crate::audit::evidence::RegistryEvidence::Present(body) => Ok(body),
        crate::audit::evidence::RegistryEvidence::Missing => Err("no attestation found".into()),
    }
}

/// Parse a DSSE envelope from the attestation bundle JSON.
/// Checks for valid signature structure and extracts metadata.
fn verify_attestation_structure(json: &str) -> ProvenanceVerification {
    // Look for attestations array
    let has_attestations = json.contains("\"attestations\"") && json.contains("\"predicateType\"");
    if !has_attestations {
        return ProvenanceVerification {
            signature_valid: false,
            transparency_log: false,
            source_repo: None,
            build_trigger: None,
            error: Some("no attestations found in response".into()),
        };
    }

    // Check for DSSE signature envelope structure
    let has_dsse_sig = json.contains("\"sig\"") || json.contains("\"signatures\"");
    let has_payload = json.contains("\"payload\"") || json.contains("\"dsseEnvelope\"");

    // Check for Sigstore-specific fields
    let has_sigstore = json.contains("sigstore") || json.contains("fulcio") || json.contains("rekor");
    let has_transparency = json.contains("rekor") || json.contains("transparency") || json.contains("logIndex");

    // Check for SLSA provenance predicate
    let has_slsa = json.contains("slsa") || json.contains("https://slsa.dev");

    // Extract source repository if present
    let source_repo = extract_json_field(json, "sourceRepositoryUri")
        .or_else(|| extract_json_field(json, "source_repo"))
        .or_else(|| {
            // Try to find repository in the invocation config
            if let Some(invocation) = extract_json_object_raw(json, "invocationConfig") {
                extract_json_field(&invocation, "sourceRepositoryUri")
            } else {
                None
            }
        });

    // Extract build trigger
    let build_trigger = extract_json_field(json, "buildTrigger")
        .or_else(|| extract_json_field(json, "event_name"));

    // Structural validation: presence of sig + payload fields in a DSSE envelope.
    // Full cryptographic verification (Fulcio cert chain, Rekor log inclusion proof,
    // OIDC claim checks) requires a native Sigstore client library and is not
    // performed here. Use `npm audit signatures` for full cryptographic validation.
    let signature_valid = has_dsse_sig && has_payload;

    if !signature_valid {
        return ProvenanceVerification {
            signature_valid: false,
            transparency_log: has_transparency,
            source_repo,
            build_trigger,
            error: Some("attestation envelope missing signature or payload".into()),
        };
    }

    ProvenanceVerification {
        signature_valid: true,
        transparency_log: has_transparency || has_sigstore,
        source_repo,
        build_trigger,
        error: if !has_slsa {
            Some("attestation present but no SLSA provenance predicate found".into())
        } else {
            None
        },
    }
}

struct ProvenanceVerification {
    signature_valid: bool,
    transparency_log: bool,
    source_repo: Option<String>,
    build_trigger: Option<String>,
    error: Option<String>,
}

/// Check provenance for a single package.
fn check_package_provenance(
    name: &str,
    version: &str,
    config: &crate::types::NpmrcConfig,
) -> ProvenanceAttestation {
    match fetch_attestation(name, version, config) {
        Ok(json) => {
            let verification = verify_attestation_structure(&json);
            ProvenanceAttestation {
                package: name.to_string(),
                version: version.to_string(),
                has_attestation: true,
                signature_valid: verification.signature_valid,
                transparency_log: verification.transparency_log,
                source_repo: verification.source_repo,
                build_trigger: verification.build_trigger,
                error: verification.error,
            }
        }
        Err(e) => ProvenanceAttestation {
            package: name.to_string(),
            version: version.to_string(),
            has_attestation: false,
            signature_valid: false,
            transparency_log: false,
            source_repo: None,
            build_trigger: None,
            error: Some(e),
        },
    }
}

/// Verify provenance for all resolved packages.
/// `mode` controls behavior:
///   - "verify" = warn on missing provenance
///   - "require" = fail if any package lacks provenance
pub fn verify_provenance(
    packages: &[ResolvedPackage],
    mode: &str,
) -> Result<ProvenanceReport, String> {
    let root = std::env::current_dir().map_err(|e| format!("provenance working directory: {e}"))?;
    let config = crate::npmrc::parse_npmrc(&root);
    verify_provenance_with_config(packages, mode, &config)
}

/// Project-aware entry point using the install registry configuration.
pub fn verify_provenance_with_config(
    packages: &[ResolvedPackage],
    mode: &str,
    config: &crate::types::NpmrcConfig,
) -> Result<ProvenanceReport, String> {
    let mut attestations = Vec::new();
    let mut with_provenance = 0u64;
    let mut without_provenance = 0u64;
    let mut verification_errors = 0u64;

    // Deduplicate by name@version (lockfile can have multiple entries for same package)
    let mut seen = HashSet::new();
    let mut unique_packages: Vec<(&str, &str)> = Vec::new();
    for pkg in packages {
        let key = (pkg.name.as_str(), pkg.version.as_str());
        if !seen.insert(key) {
            continue;
        }
        unique_packages.push((&pkg.name, &pkg.version));
    }

    let checked = crate::audit::evidence::map_bounded(&unique_packages, |(name, version)| {
        check_package_provenance(name, version, config)
    });
    for attestation in checked {
        if attestation.has_attestation && attestation.signature_valid {
            with_provenance += 1;
        } else if attestation.has_attestation && !attestation.signature_valid {
            verification_errors += 1;
        } else if attestation.error.as_deref() == Some("no attestation found") {
            without_provenance += 1;
        } else {
            verification_errors += 1;
        }
        attestations.push(attestation);
    }

    let report = ProvenanceReport {
        total_checked: unique_packages.len() as u64,
        with_provenance,
        without_provenance,
        verification_errors,
        attestations,
    };

    if mode == "require" && (without_provenance > 0 || verification_errors > 0) {
        let missing: Vec<String> = report
            .attestations
            .iter()
            .filter(|a| !a.has_attestation || !a.signature_valid)
            .map(|a| format!("{}@{}", a.package, a.version))
            .collect();
        return Err(format!(
            "--require-provenance: {} package(s) lack provenance attestation or could not be verified: {}",
            without_provenance + verification_errors,
            missing.join(", ")
        ));
    }

    Ok(report)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pkg(name: &str, version: &str) -> ResolvedPackage {
        ResolvedPackage {
            selection: Default::default(),
            name: name.to_string(),
            version: version.to_string(),
            rel_path: format!("node_modules/{}", name),
            resolved_url: String::new(),
            integrity: String::new(),
        }
    }

    #[test]
    fn empty_packages_returns_zero_counts() {
        let report = verify_provenance(&[], "verify").unwrap();
        assert_eq!(report.total_checked, 0);
        assert_eq!(report.with_provenance, 0);
        assert_eq!(report.without_provenance, 0);
    }

    fn missing_registry() -> (crate::types::NpmrcConfig, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let config = crate::types::NpmrcConfig {
            default_registry: format!("http://{}/", listener.local_addr().unwrap()),
            ..Default::default()
        };
        let server = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(std::time::Instant::now() < deadline, "registry fixture timed out");
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Err(error) => panic!("registry fixture: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0; 1];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() <= 16 * 1024, "fixture headers too large");
            }
            stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
        });
        (config, server)
    }

    #[test]
    fn require_mode_fails_when_packages_lack_provenance() {
        let (config, server) = missing_registry();
        let pkgs = vec![make_pkg("some-package", "1.0.0")];
        let result = verify_provenance_with_config(&pkgs, "require", &config);
        server.join().unwrap();
        assert!(result.unwrap_err().contains("lack provenance attestation"));
    }

    #[test]
    fn deduplication_skips_same_version() {
        let (config, server) = missing_registry();
        let pkgs = vec![make_pkg("lodash", "4.17.21"), make_pkg("lodash", "4.17.21")];
        let report = verify_provenance_with_config(&pkgs, "verify", &config).unwrap();
        server.join().unwrap();
        assert_eq!(report.total_checked, 1);
        assert_eq!(report.without_provenance, 1);
    }

    #[test]
    fn verify_attestation_no_attestations_field() {
        let json = r#"{"message": "not found"}"#;
        let result = verify_attestation_structure(json);
        assert!(!result.signature_valid);
        assert!(result.error.is_some());
    }

    #[test]
    fn write_provenance_json_contains_kind() {
        let report = ProvenanceReport {
            total_checked: 2,
            with_provenance: 1,
            without_provenance: 1,
            verification_errors: 0,
            attestations: vec![],
        };
        let json = write_provenance_json(&report);
        assert!(json.contains("better.provenance.report"));
        assert!(json.contains("\"totalChecked\""));
    }

    #[test]
    fn verify_attestation_with_slsa_and_sig_is_valid() {
        let json = r#"{"attestations":[{"predicateType":"https://slsa.dev/provenance/v1","dsseEnvelope":{"payload":"abc","sig":"xyz"},"signatures":[{"sig":"xyz"}]}],"rekor":"yes"}"#;
        let result = verify_attestation_structure(json);
        assert!(result.signature_valid);
        assert!(result.transparency_log);
        assert!(result.error.is_none());
    }

    #[test]
    fn verify_attestation_has_attestations_but_no_sig() {
        let json = r#"{"attestations":[{"predicateType":"test"}]}"#;
        let result = verify_attestation_structure(json);
        assert!(!result.signature_valid);
        assert!(result.error.is_some());
    }

    #[test]
    fn write_provenance_json_includes_attestation_package() {
        let report = ProvenanceReport {
            total_checked: 1,
            with_provenance: 1,
            without_provenance: 0,
            verification_errors: 0,
            attestations: vec![ProvenanceAttestation {
                package: "express".to_string(),
                version: "4.18.2".to_string(),
                has_attestation: true,
                signature_valid: true,
                transparency_log: true,
                source_repo: Some("https://github.com/expressjs/express".into()),
                build_trigger: None,
                error: None,
            }],
        };
        let json = write_provenance_json(&report);
        assert!(json.contains("express"));
        assert!(json.contains("4.18.2"));
        assert!(json.contains("sourceRepo"));
    }

    #[test]
    fn verify_attestation_extracts_source_repo() {
        let json = r#"{"attestations":[{"predicateType":"test","dsseEnvelope":{"payload":"a","sig":"b","signatures":[]}}],"sourceRepositoryUri":"https://github.com/owner/repo"}"#;
        let result = verify_attestation_structure(json);
        assert_eq!(result.source_repo.as_deref(), Some("https://github.com/owner/repo"));
    }
}

/// Write provenance report as JSON.
pub fn write_provenance_json(report: &ProvenanceReport) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("kind");
    w.value_string("better.provenance.report");
    w.key("totalChecked");
    w.value_u64(report.total_checked);
    w.key("withProvenance");
    w.value_u64(report.with_provenance);
    w.key("withoutProvenance");
    w.value_u64(report.without_provenance);
    w.key("verificationErrors");
    w.value_u64(report.verification_errors);
    w.key("attestations");
    w.begin_array();
    for att in &report.attestations {
        w.begin_object();
        w.key("package");
        w.value_string(&att.package);
        w.key("version");
        w.value_string(&att.version);
        w.key("hasAttestation");
        w.value_bool(att.has_attestation);
        w.key("signatureValid");
        w.value_bool(att.signature_valid);
        w.key("transparencyLog");
        w.value_bool(att.transparency_log);
        if let Some(ref repo) = att.source_repo {
            w.key("sourceRepo");
            w.value_string(repo);
        }
        if let Some(ref trigger) = att.build_trigger {
            w.key("buildTrigger");
            w.value_string(trigger);
        }
        if let Some(ref err) = att.error {
            w.key("error");
            w.value_string(err);
        }
        w.end_object();
    }
    w.end_array();
    w.end_object();
    w.finish()
}
