use better_core::resolve_from_lockfile;
use serde_json::{json, Value};
use std::{fs, process::Command};

fn package() -> Value {
    json!({"version":"1.0.0", "resolved":"https://example.invalid/pkg.tgz", "integrity":"sha512-AAAA"})
}

fn resolve(value: &Value) -> Result<better_core::ResolveResult, String> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("package-lock.json");
    fs::write(&path, value.to_string()).unwrap();
    resolve_from_lockfile(&path)
}

#[test]
fn reports_missing_wrong_type_and_empty_fields_with_entry_path() {
    for field in ["version", "resolved", "integrity"] {
        for value in [None, Some(json!(null)), Some(json!(42)), Some(json!(""))] {
            let mut bad = package();
            match value {
                Some(v) => {
                    bad[field] = v;
                }
                None => {
                    bad.as_object_mut().unwrap().remove(field);
                }
            }
            let error = resolve(
                &json!({"packages": {"node_modules/good": package(), "node_modules/bad": bad}}),
            )
            .err()
            .expect("lockfile must be rejected");
            assert!(error.contains("node_modules/bad"), "{error}");
            assert!(error.contains(field), "{error}");
        }
    }
}

#[test]
fn rejects_non_object_packages_and_entries() {
    for packages in [json!(null), json!([]), json!("invalid")] {
        assert!(resolve(&json!({"packages": packages}))
            .err()
            .expect("lockfile must be rejected")
            .contains("'packages' must be an object"));
    }
    for entry in [json!(null), json!([]), json!(false)] {
        assert!(resolve(&json!({"packages": {"node_modules/bad": entry}}))
            .err()
            .expect("lockfile must be rejected")
            .contains("'node_modules/bad' must be an object"));
    }
}

#[test]
fn reads_direct_fields_and_decodes_json_strings() {
    let result = resolve(&json!({"packages": {
        "": {"name": "root"},
        "node_modules/@scope/pkg": package(),
        "node_modules/alias": {"name":"actual", "version":"1.0.0", "resolved":"https://example.invalid/a?x=\"quoted\"", "integrity":"sha512-AAAA"}
    }})).unwrap();
    assert_eq!(result.packages.len(), 2);
    assert!(result.packages.iter().any(|p| p.name == "@scope/pkg"));
    let alias = result
        .packages
        .iter()
        .find(|p| p.rel_path == "node_modules/alias")
        .unwrap();
    assert_eq!(alias.name, "actual");
    assert_eq!(alias.resolved_url, "https://example.invalid/a?x=\"quoted\"");
    let error = resolve(&json!({"packages": {"node_modules/bad": {"metadata": package()}}}))
        .err()
        .expect("lockfile must be rejected");
    assert!(error.contains("'version'"), "{error}");
}

#[test]
fn install_rejects_bad_lockfile_before_creating_install_or_cache_output() {
    for content in [
        "{\"packages\":{\"node_modules/bad\":{\"version\":\"1.0.0\"}}}".to_string(),
        "{\"packages\":{}} trailing".to_string(),
        "{\"packages\":{\"node_modules/bad\":{".to_string(),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let lockfile = dir.path().join("package-lock.json");
        let cache = dir.path().join("cache");
        fs::write(&lockfile, content).unwrap();
        fs::write(dir.path().join("package.json"), "{}").unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_better-core"))
            .args(["install", "--project-root"])
            .arg(dir.path())
            .arg("--cache-root")
            .arg(&cache)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["ok"], false);
        assert_eq!(report["kind"], "better.install.report");
        let reason = report["reason"].as_str().unwrap();
        assert!(
            reason.contains("node_modules/bad") || reason.contains("Invalid package-lock.json"),
            "{reason}"
        );
        assert!(!cache.exists());
        assert!(!dir.path().join("node_modules").exists());
        assert!(!dir.path().join("better.lock").exists());
    }
}
