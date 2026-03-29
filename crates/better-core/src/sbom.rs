use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::types::{SbomComponent, SbomReport, AuditVulnerability};
use crate::{extract_json_field, resolve_from_lockfile, scan_licenses, run_audit, JsonWriter, VERSION};

// ============================================================
// Core SBOM generation (upgraded from v1)
// ============================================================

pub fn generate_sbom(project_root: &Path, lockfile: &Path, format: &str) -> Result<SbomReport, String> {
    let resolve_result = resolve_from_lockfile(lockfile)?;
    let nm = project_root.join("node_modules");
    let license_report = scan_licenses(&nm, &[], &[])?;
    let license_map: HashMap<String, String> = license_report.packages.iter()
        .map(|p| (p.name.clone(), p.license.clone())).collect();
    let mut components = Vec::new();
    for pkg in &resolve_result.packages {
        let license = license_map.get(&pkg.name).cloned().unwrap_or_else(|| "NOASSERTION".into());
        let purl = format!("pkg:npm/{}@{}", pkg.name, pkg.version);
        components.push(SbomComponent {
            name: pkg.name.clone(), version: pkg.version.clone(),
            license, purl, integrity: pkg.integrity.clone(),
        });
    }
    let pj = project_root.join("package.json");
    let c = fs::read_to_string(&pj).unwrap_or_default();
    let project_name = extract_json_field(&c, "name").unwrap_or_else(|| "unknown".into());
    let project_version = extract_json_field(&c, "version").unwrap_or_else(|| "0.0.0".into());
    Ok(SbomReport { format: format.into(), components, project_name, project_version })
}

// ============================================================
// Build Environment Metadata
// ============================================================

pub struct BuildEnvironment {
    pub os: String,
    pub arch: String,
    pub node_version: String,
    pub better_version: String,
    pub git_sha: String,
    pub git_branch: String,
    pub timestamp: String,
    pub ci_provider: String,
}

impl BuildEnvironment {
    pub fn capture() -> Self {
        Self {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            node_version: get_command_output("node", &["--version"]),
            better_version: VERSION.to_string(),
            git_sha: get_command_output("git", &["rev-parse", "HEAD"]),
            git_branch: get_command_output("git", &["rev-parse", "--abbrev-ref", "HEAD"]),
            timestamp: crate::chrono_now(),
            ci_provider: detect_ci_provider(),
        }
    }
}

fn get_command_output(cmd: &str, args: &[&str]) -> String {
    std::process::Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .and_then(|o| if o.status.success() {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        } else { None })
        .unwrap_or_default()
}

fn detect_ci_provider() -> String {
    if std::env::var("GITHUB_ACTIONS").is_ok() { return "github-actions".into(); }
    if std::env::var("GITLAB_CI").is_ok() { return "gitlab-ci".into(); }
    if std::env::var("JENKINS_URL").is_ok() { return "jenkins".into(); }
    if std::env::var("CIRCLECI").is_ok() { return "circleci".into(); }
    if std::env::var("TRAVIS").is_ok() { return "travis-ci".into(); }
    if std::env::var("BUILDKITE").is_ok() { return "buildkite".into(); }
    String::new()
}

// ============================================================
// CycloneDX 1.6 JSON writer
// ============================================================

pub fn write_cyclonedx_json(report: &SbomReport) -> String {
    write_cyclonedx_v16(report, &[], None)
}

pub fn write_cyclonedx_v16(
    report: &SbomReport,
    vulns: &[AuditVulnerability],
    build_env: Option<&BuildEnvironment>,
) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("bomFormat"); w.value_string("CycloneDX");
    w.key("specVersion"); w.value_string("1.6");
    w.key("serialNumber"); w.value_string(&format!("urn:uuid:{}", simple_uuid()));
    w.key("version"); w.value_i64(1);

    // metadata
    w.key("metadata"); w.begin_object();
    w.key("timestamp"); w.value_string(&crate::chrono_now());

    // metadata.tools
    w.key("tools"); w.begin_array();
    w.begin_object();
    w.key("vendor"); w.value_string("better");
    w.key("name"); w.value_string("better");
    w.key("version"); w.value_string(VERSION);
    w.end_object();
    w.end_array();

    // metadata.component (root project)
    w.key("component"); w.begin_object();
    w.key("type"); w.value_string("application");
    w.key("bom-ref"); w.value_string("root");
    w.key("name"); w.value_string(&report.project_name);
    w.key("version"); w.value_string(&report.project_version);
    w.end_object();

    // metadata.properties (build env)
    if let Some(env) = build_env {
        w.key("properties"); w.begin_array();
        write_cdx_property(&mut w, "better:os", &env.os);
        write_cdx_property(&mut w, "better:arch", &env.arch);
        write_cdx_property(&mut w, "better:nodeVersion", &env.node_version);
        write_cdx_property(&mut w, "better:betterVersion", &env.better_version);
        if !env.git_sha.is_empty() {
            write_cdx_property(&mut w, "better:gitSha", &env.git_sha);
        }
        if !env.git_branch.is_empty() {
            write_cdx_property(&mut w, "better:gitBranch", &env.git_branch);
        }
        write_cdx_property(&mut w, "better:timestamp", &env.timestamp);
        if !env.ci_provider.is_empty() {
            write_cdx_property(&mut w, "better:ciProvider", &env.ci_provider);
        }
        w.end_array();
    }

    w.end_object(); // end metadata

    // components
    w.key("components"); w.begin_array();
    for comp in &report.components {
        let bom_ref = format!("{}@{}", comp.name, comp.version);
        w.begin_object();
        w.key("type"); w.value_string("library");
        w.key("bom-ref"); w.value_string(&bom_ref);
        w.key("name"); w.value_string(&comp.name);
        w.key("version"); w.value_string(&comp.version);
        w.key("purl"); w.value_string(&comp.purl);
        w.key("licenses"); w.begin_array();
        w.begin_object();
        w.key("license"); w.begin_object();
        w.key("id"); w.value_string(&comp.license);
        w.end_object();
        w.end_object();
        w.end_array();
        // hashes (integrity from lockfile)
        if !comp.integrity.is_empty() {
            w.key("hashes"); w.begin_array();
            w.begin_object();
            let (alg, hash) = parse_integrity(&comp.integrity);
            w.key("alg"); w.value_string(alg);
            w.key("content"); w.value_string(hash);
            w.end_object();
            w.end_array();
        }
        // evidence section (CycloneDX 1.6)
        w.key("evidence"); w.begin_object();
        w.key("identity"); w.begin_object();
        w.key("field"); w.value_string("purl");
        w.key("confidence"); w.value_f64(1.0);
        w.key("methods"); w.begin_array();
        w.begin_object();
        w.key("technique"); w.value_string("manifest-analysis");
        w.key("confidence"); w.value_f64(1.0);
        w.end_object();
        w.end_array();
        w.end_object();
        w.end_object();
        w.end_object();
    }
    w.end_array();

    // dependencies
    w.key("dependencies"); w.begin_array();
    // Root depends on all direct dependencies
    w.begin_object();
    w.key("ref"); w.value_string("root");
    w.key("dependsOn"); w.begin_array();
    for comp in &report.components {
        w.value_string(&format!("{}@{}", comp.name, comp.version));
    }
    w.end_array();
    w.end_object();
    w.end_array();

    // vulnerabilities section (CycloneDX 1.6)
    if !vulns.is_empty() {
        w.key("vulnerabilities"); w.begin_array();
        for vuln in vulns {
            w.begin_object();
            w.key("id"); w.value_string(&vuln.id);
            w.key("source"); w.begin_object();
            w.key("name"); w.value_string("OSV");
            w.key("url"); w.value_string(&format!("https://osv.dev/vulnerability/{}", vuln.id));
            w.end_object();
            w.key("ratings"); w.begin_array();
            w.begin_object();
            w.key("severity"); w.value_string(&vuln.severity);
            w.key("method"); w.value_string("other");
            w.end_object();
            w.end_array();
            w.key("description"); w.value_string(&vuln.summary);
            if !vuln.fixed.is_empty() {
                w.key("recommendation"); w.value_string(&format!("Upgrade to {}", vuln.fixed));
            }
            w.key("affects"); w.begin_array();
            w.begin_object();
            w.key("ref"); w.value_string(&format!("{}@{}", vuln.package, vuln.version));
            w.end_object();
            w.end_array();
            w.end_object();
        }
        w.end_array();
    }

    w.end_object();
    w.out.push('\n');
    w.finish()
}

fn write_cdx_property(w: &mut JsonWriter, name: &str, value: &str) {
    w.begin_object();
    w.key("name"); w.value_string(name);
    w.key("value"); w.value_string(value);
    w.end_object();
}

// ============================================================
// SPDX 2.3 JSON writer with relationship types
// ============================================================

pub fn write_spdx_json(report: &SbomReport) -> String {
    write_spdx_v23(report, None)
}

pub fn write_spdx_v23(
    report: &SbomReport,
    build_env: Option<&BuildEnvironment>,
) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("spdxVersion"); w.value_string("SPDX-2.3");
    w.key("dataLicense"); w.value_string("CC0-1.0");
    w.key("SPDXID"); w.value_string("SPDXRef-DOCUMENT");
    w.key("name"); w.value_string(&format!("{}-sbom", report.project_name));
    w.key("documentNamespace"); w.value_string(
        &format!("https://better.sh/spdx/{}/{}", report.project_name, simple_uuid())
    );

    // creationInfo
    w.key("creationInfo"); w.begin_object();
    w.key("created"); w.value_string(&crate::chrono_now());
    w.key("creators"); w.begin_array();
    w.value_string(&format!("Tool: better-{}", VERSION));
    w.end_array();
    w.key("licenseListVersion"); w.value_string("3.22");
    w.end_object();

    // packages
    w.key("packages"); w.begin_array();

    // Root package
    w.begin_object();
    w.key("SPDXID"); w.value_string("SPDXRef-RootPackage");
    w.key("name"); w.value_string(&report.project_name);
    w.key("versionInfo"); w.value_string(&report.project_version);
    w.key("downloadLocation"); w.value_string("NOASSERTION");
    w.key("filesAnalyzed"); w.value_bool(false);
    w.key("licenseConcluded"); w.value_string("NOASSERTION");
    w.key("copyrightText"); w.value_string("NOASSERTION");
    w.end_object();

    for comp in &report.components {
        let spdx_id = format!("SPDXRef-Package-{}", sanitize_spdx_id(&format!("{}-{}", comp.name, comp.version)));
        w.begin_object();
        w.key("SPDXID"); w.value_string(&spdx_id);
        w.key("name"); w.value_string(&comp.name);
        w.key("versionInfo"); w.value_string(&comp.version);
        w.key("downloadLocation"); w.value_string(&comp.purl);
        w.key("filesAnalyzed"); w.value_bool(false);
        w.key("licenseConcluded"); w.value_string(&comp.license);
        w.key("licenseDeclared"); w.value_string(&comp.license);
        w.key("copyrightText"); w.value_string("NOASSERTION");
        // checksums
        if !comp.integrity.is_empty() {
            w.key("checksums"); w.begin_array();
            w.begin_object();
            let (alg, hash) = parse_integrity(&comp.integrity);
            w.key("algorithm"); w.value_string(alg);
            w.key("checksumValue"); w.value_string(hash);
            w.end_object();
            w.end_array();
        }
        // externalRefs
        w.key("externalRefs"); w.begin_array();
        w.begin_object();
        w.key("referenceCategory"); w.value_string("PACKAGE-MANAGER");
        w.key("referenceType"); w.value_string("purl");
        w.key("referenceLocator"); w.value_string(&comp.purl);
        w.end_object();
        w.end_array();
        w.end_object();
    }
    w.end_array();

    // relationships (SPDX 2.3 relationship types)
    w.key("relationships"); w.begin_array();

    // DOCUMENT DESCRIBES root
    w.begin_object();
    w.key("spdxElementId"); w.value_string("SPDXRef-DOCUMENT");
    w.key("relationshipType"); w.value_string("DESCRIBES");
    w.key("relatedSpdxElement"); w.value_string("SPDXRef-RootPackage");
    w.end_object();

    // Root DEPENDS_ON all components
    for comp in &report.components {
        let spdx_id = format!("SPDXRef-Package-{}", sanitize_spdx_id(&format!("{}-{}", comp.name, comp.version)));
        w.begin_object();
        w.key("spdxElementId"); w.value_string("SPDXRef-RootPackage");
        w.key("relationshipType"); w.value_string("DEPENDS_ON");
        w.key("relatedSpdxElement"); w.value_string(&spdx_id);
        w.end_object();
    }

    // Build tool relationship
    w.begin_object();
    w.key("spdxElementId"); w.value_string("SPDXRef-DOCUMENT");
    w.key("relationshipType"); w.value_string("BUILD_TOOL_OF");
    w.key("relatedSpdxElement"); w.value_string("SPDXRef-RootPackage");
    w.end_object();

    w.end_array();

    // annotations (build env metadata)
    if let Some(env) = build_env {
        w.key("annotations"); w.begin_array();
        w.begin_object();
        w.key("annotationDate"); w.value_string(&env.timestamp);
        w.key("annotationType"); w.value_string("OTHER");
        w.key("annotator"); w.value_string(&format!("Tool: better-{}", env.better_version));
        w.key("comment"); w.value_string(&format!(
            "Build env: os={}, arch={}, node={}, git={}, ci={}",
            env.os, env.arch, env.node_version, env.git_sha, env.ci_provider
        ));
        w.end_object();
        w.end_array();
    }

    w.end_object();
    w.out.push('\n');
    w.finish()
}

fn sanitize_spdx_id(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '.' { c } else { '-' })
        .collect()
}

// ============================================================
// VEX (Vulnerability Exploitability eXchange) generation
// ============================================================

pub fn write_vex_json(
    _report: &SbomReport,
    vulns: &[AuditVulnerability],
) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("@context"); w.value_string("https://openvex.dev/ns/v0.2.0");
    w.key("@id"); w.value_string(&format!("https://better.sh/vex/{}", simple_uuid()));
    w.key("author"); w.value_string("better");
    w.key("role"); w.value_string("tool");
    w.key("timestamp"); w.value_string(&crate::chrono_now());
    w.key("version"); w.value_i64(1);
    w.key("tooling"); w.value_string(&format!("better/{}", VERSION));

    w.key("statements"); w.begin_array();
    for vuln in vulns {
        w.begin_object();
        w.key("vulnerability"); w.begin_object();
        w.key("name"); w.value_string(&vuln.id);
        w.end_object();

        w.key("products"); w.begin_array();
        w.begin_object();
        w.key("@id"); w.value_string(&format!("pkg:npm/{}@{}", vuln.package, vuln.version));
        w.end_object();
        w.end_array();

        // Determine VEX status based on available info
        if !vuln.fixed.is_empty() {
            w.key("status"); w.value_string("affected");
            w.key("action_statement"); w.value_string(&format!("Upgrade {} to {}", vuln.package, vuln.fixed));
        } else {
            w.key("status"); w.value_string("under_investigation");
        }

        w.end_object();
    }
    w.end_array();

    w.end_object();
    w.out.push('\n');
    w.finish()
}

// ============================================================
// v2 unified entry point
// ============================================================

/// Generate SBOM v2 output — CycloneDX 1.6 or SPDX 2.3 with optional VEX.
pub fn generate_sbom_v2(
    project_root: &Path,
    lockfile: &Path,
    format: &str,
    include_vex: bool,
) -> Result<String, String> {
    let report = generate_sbom(project_root, lockfile, format)?;
    let build_env = BuildEnvironment::capture();

    // Try to get vulnerabilities for the SBOM
    let vulns = run_audit(project_root, lockfile, "low")
        .map(|r| r.vulnerabilities)
        .unwrap_or_default();

    let sbom_output = match format {
        "spdx" => write_spdx_v23(&report, Some(&build_env)),
        _ => write_cyclonedx_v16(&report, &vulns, Some(&build_env)),
    };

    if include_vex && !vulns.is_empty() {
        // Combine SBOM + VEX in a JSON wrapper
        let vex_output = write_vex_json(&report, &vulns);
        let mut w = JsonWriter::new();
        w.begin_object();
        w.key("sbom"); w.out.push_str(sbom_output.trim());
        w.key("vex"); w.out.push_str(vex_output.trim());
        w.end_object();
        w.out.push('\n');
        Ok(w.finish())
    } else {
        Ok(sbom_output)
    }
}

// ============================================================
// Helpers
// ============================================================

fn parse_integrity(integrity: &str) -> (&str, &str) {
    if let Some(rest) = integrity.strip_prefix("sha512-") {
        ("SHA-512", rest)
    } else if let Some(rest) = integrity.strip_prefix("sha256-") {
        ("SHA-256", rest)
    } else if let Some(rest) = integrity.strip_prefix("sha1-") {
        ("SHA-1", rest)
    } else if integrity.is_empty() {
        ("SHA-512", "")
    } else {
        ("SHA-512", integrity)
    }
}

/// Simple UUID v4-like generator without dependencies.
fn simple_uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let seed = nanos ^ (pid << 32);
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (seed & 0xFFFF_FFFF) as u32,
        ((seed >> 32) & 0xFFFF) as u16,
        ((seed >> 48) & 0x0FFF) as u16,
        (0x8000 | ((seed >> 60) & 0x3FFF)) as u16,
        ((seed >> 74).wrapping_mul(0xDEAD_BEEF) & 0xFFFF_FFFF_FFFF) as u64,
    )
}
