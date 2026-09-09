use better_core::{resolve_from_lockfile, select_platform_packages};
use serde_json::{json, Value};

fn select(root: Value, entries: Vec<(&str, Value)>, production: bool) -> Result<Vec<String>, String> {
    let dir = tempfile::tempdir().unwrap();
    let mut packages = serde_json::Map::new();
    packages.insert("".into(), root);
    for (path, metadata) in entries {
        let mut entry = json!({"version":"1.0.0","resolved":"https://example.test/package.tgz","integrity":"sha512-AAAA"});
        entry.as_object_mut().unwrap().extend(metadata.as_object().unwrap().clone());
        packages.insert(path.into(), entry);
    }
    let lock = dir.path().join("package-lock.json");
    std::fs::write(&lock, json!({"lockfileVersion":3,"packages":packages}).to_string()).unwrap();
    let resolved = resolve_from_lockfile(&lock)?;
    select_platform_packages(&resolved, production, "darwin", "arm64").map(|packages| packages.into_iter().map(|p|p.rel_path).collect())
}

#[test]
fn platform_lists_follow_npm_allow_and_deny_rules() {
    for (restrictions, accepted) in [
        (json!({"os":["darwin"]}),true),(json!({"os":["linux"]}),false),
        (json!({"os":["darwin","!darwin"]}),false),(json!({"os":["!win32"]}),true),
        (json!({"os":[]}),true),(json!({"os":"any"}),true),
        (json!({"cpu":["arm64"]}),true),(json!({"cpu":["!arm64"]}),false),
        (json!({"os":["darwin"],"cpu":["x64"]}),false),
    ] {
        let result = select(json!({"dependencies":{"pkg":"1"}}), vec![("node_modules/pkg",restrictions.clone())], false);
        assert_eq!(result.is_ok(), accepted, "{restrictions}: {result:?}");
        if let Err(error) = result { assert!(error.contains("Required package") && error.contains("darwin/arm64")); }
    }
}

#[test]
fn incompatible_optional_parent_and_orphan_are_removed_but_shared_child_survives() {
    let packages = select(json!({"dependencies":{"app":"1"},"optionalDependencies":{"addon":"1"}}), vec![
        ("node_modules/app",json!({"dependencies":{"shared":"1"}})),
        ("node_modules/addon",json!({"optional":true,"dependencies":{"binary":"1","orphan":"1","shared":"1"}})),
        ("node_modules/binary",json!({"optional":true,"os":["linux"]})),
        ("node_modules/orphan",json!({"optional":true})),
        ("node_modules/shared",json!({})),
    ], false).unwrap();
    assert_eq!(packages, ["node_modules/app", "node_modules/shared"]);
}

#[test]
fn nested_scoped_and_peer_edges_use_locked_locations() {
    let packages = select(json!({"dependencies":{"app":"1"},"optionalDependencies":{"foreign":"1"}}), vec![
        ("node_modules/app",json!({"dependencies":{"@scope/dep":"1"}})),
        ("node_modules/app/node_modules/@scope/dep",json!({"peerDependencies":{"peer":"1","absent":"1"},"peerDependenciesMeta":{"absent":{"optional":true}}})),
        ("node_modules/app/node_modules/peer",json!({})),
        ("node_modules/@scope/dep",json!({"optional":true})),
        ("node_modules/foreign",json!({"optional":true,"cpu":["x64"]})),
    ], false).unwrap();
    assert_eq!(packages, ["node_modules/app", "node_modules/app/node_modules/@scope/dep", "node_modules/app/node_modules/peer"]);
}

#[test]
fn required_paths_cannot_be_hidden_by_optional_flags() {
    let error = select(json!({"dependencies":{"pkg":"1"}}),vec![("node_modules/pkg",json!({"optional":true,"os":["linux"]}))],false).unwrap_err();
    assert!(error.contains("Required root"));
    let error = select(json!({"dependencies":{"pkg":"1"}}),vec![("node_modules/pkg",json!({"devOptional":true,"os":["linux"]}))],true).unwrap_err();
    assert!(error.contains("Required package"));
}

#[test]
fn production_skips_dev_restrictions_and_retains_dev_optional() {
    let packages = select(json!({"devDependencies":{"tool":"1"},"optionalDependencies":{"shared":"1"}}), vec![
        ("node_modules/tool",json!({"dev":true,"os":["linux"]})),
        ("node_modules/shared",json!({"devOptional":true})),
    ], true).unwrap();
    assert_eq!(packages, ["node_modules/shared"]);
}

#[test]
fn libc_is_rejected_only_after_os_and_cpu_selection() {
    let error = select(json!({}),vec![("node_modules/pkg",json!({"libc":["glibc"]}))],false).unwrap_err();
    assert!(error.contains("does not support libc"));
    assert!(select(json!({"optionalDependencies":{"pkg":"1"}}),vec![("node_modules/pkg",json!({"optional":true,"os":["linux"],"libc":["glibc"]}))],false).unwrap().is_empty());
}

#[test]
fn orphaned_libc_constraints_do_not_block_other_platforms() {
    assert!(select(json!({"optionalDependencies":{"addon":"1"}}),vec![
        ("node_modules/addon",json!({"optional":true,"os":["linux"],"dependencies":{"child":"1"}})),
        ("node_modules/child",json!({"optional":true,"libc":["glibc"]})),
    ],false).unwrap().is_empty());
}

#[test]
fn root_restrictions_are_enforced_even_for_an_empty_install() {
    assert!(select(json!({"os":["linux"]}),vec![],false).unwrap_err().contains("Root package"));
    assert!(select(json!({"libc":["glibc"]}),vec![],false).unwrap_err().contains("root libc"));
}

#[test]
fn invalid_cpu_and_missing_root_metadata_fail_explicitly() {
    assert!(better_core::validate_install_target("darwin", "made-up").unwrap_err().contains("CPU"));
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("package-lock.json");
    std::fs::write(&lock, json!({"lockfileVersion":3,"packages":{
        "node_modules/pkg":{"version":"1","resolved":"https://example.test/p.tgz","integrity":"sha512-AAAA","optional":true,"os":["linux"]}
    }}).to_string()).unwrap();
    let resolved = resolve_from_lockfile(&lock).unwrap();
    assert!(select_platform_packages(&resolved,false,"darwin","arm64").err().unwrap().contains("root package metadata"));
}
