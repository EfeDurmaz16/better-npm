use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::types::{SbomComponent, SbomReport};
use crate::{extract_json_field, resolve_from_lockfile, scan_licenses, JsonWriter};

// === D.6: SBOM export (CycloneDX + SPDX) ===

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

pub fn write_cyclonedx_json(report: &SbomReport) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("bomFormat"); w.value_string("CycloneDX");
    w.key("specVersion"); w.value_string("1.5");
    w.key("version"); w.value_i64(1);
    w.key("metadata"); w.begin_object();
    w.key("component"); w.begin_object();
    w.key("type"); w.value_string("application");
    w.key("name"); w.value_string(&report.project_name);
    w.key("version"); w.value_string(&report.project_version);
    w.end_object();
    w.end_object();
    w.key("components"); w.begin_array();
    for comp in &report.components {
        w.begin_object();
        w.key("type"); w.value_string("library");
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
        w.end_object();
    }
    w.end_array();
    w.end_object();
    w.out.push('\n');
    w.finish()
}

pub fn write_spdx_json(report: &SbomReport) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("spdxVersion"); w.value_string("SPDX-2.3");
    w.key("dataLicense"); w.value_string("CC0-1.0");
    w.key("SPDXID"); w.value_string("SPDXRef-DOCUMENT");
    w.key("name"); w.value_string(&report.project_name);
    w.key("documentNamespace"); w.value_string(
        &format!("https://spdx.org/spdxdocs/{}-{}", report.project_name, report.project_version)
    );
    w.key("packages"); w.begin_array();
    for (i, comp) in report.components.iter().enumerate() {
        w.begin_object();
        w.key("SPDXID"); w.value_string(&format!("SPDXRef-Package-{}", i));
        w.key("name"); w.value_string(&comp.name);
        w.key("versionInfo"); w.value_string(&comp.version);
        w.key("downloadLocation"); w.value_string(&comp.purl);
        w.key("licenseDeclared"); w.value_string(&comp.license);
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
    w.end_object();
    w.out.push('\n');
    w.finish()
}
