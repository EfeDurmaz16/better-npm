use better_core::{resolve_from_lockfile, PackageSelection};
use serde_json::{json, Value};

fn resolve(entry: Value, root: Value) -> Result<better_core::ResolveResult, String> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("package-lock.json");
    let mut package = json!({"version":"1.0.0", "resolved":"https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz", "integrity":"sha512-AAAA"});
    package.as_object_mut().unwrap().extend(entry.as_object().unwrap().clone());
    std::fs::write(&path, json!({"lockfileVersion":3,"packages":{"":root,"node_modules/pkg":package}}).to_string()).unwrap();
    resolve_from_lockfile(&path)
}

#[test]
fn preserves_npm_selection_flags_and_dependency_edges() {
    let result = resolve(json!({
        "dev":false,"optional":true,"devOptional":true,
        "os":["darwin","!win32"],"cpu":"arm64","libc":["glibc"],
        "dependencies":{"shared":"^1"},"optionalDependencies":{"addon":"^2"},
        "peerDependencies":{"peer":"*"},"peerDependenciesMeta":{"peer":{"optional":true}}
    }), json!({"dependencies":{"pkg":"1"},"devDependencies":{"tool":"2"}})).unwrap();
    let selection = &result.packages[0].selection;
    assert!(!selection.dev);
    assert!(selection.optional && selection.dev_optional);
    assert_eq!(selection.os.as_ref().unwrap(), &["darwin", "!win32"]);
    assert_eq!(selection.cpu.as_ref().unwrap(), &["arm64"]);
    assert_eq!(selection.libc.as_ref().unwrap(), &["glibc"]);
    assert_eq!(selection.dependencies["shared"], "^1");
    assert_eq!(selection.optional_dependencies["addon"], "^2");
    assert_eq!(selection.peer_dependencies["peer"], "*");
    assert!(selection.peer_dependencies_meta["peer"].optional);
    let root = result.root_selection.unwrap();
    assert_eq!(root.dependencies["pkg"], "1");
    assert_eq!(root.dev_dependencies["tool"], "2");
}

#[test]
fn absent_fields_default_without_changing_the_package_set() {
    let result = resolve(json!({}), json!({})).unwrap();
    assert_eq!(result.packages.len(), 1);
    assert_eq!(result.packages[0].selection, PackageSelection::default());
    assert_eq!(result.root_selection, Some(PackageSelection::default()));
    let empty = resolve(json!({"os":[]}), json!({})).unwrap();
    assert_eq!(empty.packages[0].selection.os, Some(vec![]));
}

#[test]
fn malformed_selection_metadata_is_not_coerced_or_discarded() {
    for entry in [json!({"dev":"true"}),json!({"optional":1}),json!({"devOptional":null}),
        json!({"os":[1]}),json!({"cpu":null}),json!({"libc":true}),
        json!({"dependencies":{"a":1}}),json!({"optionalDependencies":[]}),
        json!({"peerDependenciesMeta":{"p":{"optional":"yes"}}})] {
        let error = resolve(entry.clone(), json!({})).err().expect("invalid metadata must fail");
        assert!(error.contains("node_modules/pkg") && error.contains("selection metadata"), "{entry}: {error}");
    }
    assert!(resolve(json!({}), json!({"devDependencies":false})).is_err());
}
