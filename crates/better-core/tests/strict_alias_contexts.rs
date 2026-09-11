#![cfg(unix)]

use std::fs;
use base64::Engine;
use better_core::{materialize_strict, unpacked_path, CasLayout, LinkStrategy, ResolvedPackage};

#[test]
fn strict_aliases_resolve_actual_names_and_keep_nested_contexts_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    let layout = CasLayout::new(&temp.path().join("cache"));
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("package.json"), r#"{"dependencies":{"root-alias":"npm:actual@1","left":"1","right":"1"}}"#).unwrap();
    let specs = [
        ("actual", "node_modules/root-alias", 1u8),
        ("left", "node_modules/left", 2),
        ("right", "node_modules/right", 3),
        ("actual", "node_modules/left/node_modules/nested-alias", 1),
        ("actual", "node_modules/right/node_modules/nested-alias", 1),
    ];
    let mut packages = Vec::new();
    for (name, location, byte) in specs {
        let digest = [byte; 64];
        let hex = format!("{byte:02x}").repeat(64);
        let source = unpacked_path(&layout, "sha512", &hex).join("package");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("package.json"), format!(r#"{{"name":"{name}","version":"1"}}"#)).unwrap();
        fs::write(source.join("index.js"), format!("module.exports = '{name}';")).unwrap();
        let mut selection = better_core::PackageSelection::default();
        if name == "left" || name == "right" {
            selection.dependencies.insert("nested-alias".into(), "npm:actual@1".into());
        }
        packages.push(ResolvedPackage {
            name: name.into(), version: "1".into(), rel_path: location.into(),
            resolved_url: String::new(),
            integrity: format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(digest)),
            selection,
        });
    }
    materialize_strict(&packages, &project, &layout, &temp.path().join("files"), LinkStrategy::Copy).unwrap();
    let nm = project.join("node_modules");
    let root_actual = fs::canonicalize(nm.join("root-alias")).unwrap();
    let left = fs::canonicalize(nm.join("left")).unwrap();
    let right = fs::canonicalize(nm.join("right")).unwrap();
    let left_actual = fs::canonicalize(left.parent().unwrap().join("nested-alias")).unwrap();
    let right_actual = fs::canonicalize(right.parent().unwrap().join("nested-alias")).unwrap();
    assert!(root_actual.ends_with("node_modules/actual"));
    assert!(left_actual.ends_with("node_modules/actual"));
    assert!(right_actual.ends_with("node_modules/actual"));
    assert_ne!(root_actual, left_actual);
    assert_ne!(left_actual, right_actual);
    fs::write(left_actual.join("index.js"), "local edit").unwrap();
    assert_eq!(fs::read_to_string(right_actual.join("index.js")).unwrap(), "module.exports = 'actual';");
    assert_eq!(fs::read_to_string(root_actual.join("index.js")).unwrap(), "module.exports = 'actual';");
}
