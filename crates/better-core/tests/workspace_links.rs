use serde_json::{json, Value};
use std::{fs, process::Command};

#[test]
fn native_install_rejects_workspace_and_local_entries_before_writes() {
    for (packages, expected) in [
        (
            json!({"": {"workspaces": ["packages/*"]}}),
            "root workspaces",
        ),
        (
            json!({"packages/lib": {"version": "1.0.0"}}),
            "workspace/local lockfile entry 'packages/lib'",
        ),
        (
            json!({"node_modules/lib": {"resolved": "packages/lib", "link": true}}),
            "linked lockfile entry 'node_modules/lib'",
        ),
        (
            json!({"node_modules/lib": {"resolved": "file:../lib"}}),
            "local resolution for 'node_modules/lib'",
        ),
        (
            json!({"node_modules/lib": {"resolved": "workspace:*"}}),
            "local resolution for 'node_modules/lib'",
        ),
        (
            json!({"node_modules/lib": {"link": "true"}}),
            "requires a boolean 'link'",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("package-lock.json"),
            json!({"packages": packages}).to_string(),
        )
        .unwrap();
        fs::write(dir.path().join("package.json"), "{}").unwrap();
        let cache = dir.path().join("cache");
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
        assert!(
            report["reason"].as_str().unwrap().contains(expected),
            "{report}"
        );
        assert!(!cache.exists());
        assert!(!dir.path().join("node_modules").exists());
        assert!(!dir.path().join("better.lock").exists());
    }
}

#[test]
fn normal_registry_entries_and_empty_workspace_list_remain_supported() {
    let dir = tempfile::tempdir().unwrap();
    let lockfile = dir.path().join("package-lock.json");
    fs::write(&lockfile, json!({"packages": {
        "": {"workspaces": []},
        "node_modules/lib": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/lib/-/lib-1.0.0.tgz", "integrity": "sha512-AAAA", "link": false},
        "node_modules/lib/node_modules/nested": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/nested/-/nested-1.0.0.tgz", "integrity": "sha512-AAAA"}
    }}).to_string()).unwrap();
    let result = better_core::resolve_from_lockfile(&lockfile).unwrap();
    assert_eq!(result.packages.len(), 2);
}
