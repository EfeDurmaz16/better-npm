use better_core::{
    copy_file_with_retry, ingest_to_file_cas, materialize_from_file_cas, materialize_tree,
    validate_package_paths, LinkStrategy, MaterializeProfile, ResolvedPackage,
};
use std::{fs, path::Path};
const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
fn package(path: &Path) {
    fs::create_dir_all(path.join("lib")).unwrap();
    fs::write(
        path.join("package.json"),
        r#"{"name":"example","version":"1.0.0"}"#,
    )
    .unwrap();
    fs::write(path.join("lib/index.js"), "original").unwrap();
}
#[test]
fn auto_tree_and_cas_isolate_two_worktrees_and_store() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("source");
    package(&src);
    let store = tmp.path().join("store");
    ingest_to_file_cas(&store, "sha256", KEY, &src).unwrap();
    for cas in [false, true] {
        let a = tmp.path().join(format!("a-{cas}"));
        let b = tmp.path().join(format!("b-{cas}"));
        for dst in [&a, &b] {
            if cas {
                assert!(
                    materialize_from_file_cas(&store, "sha256", KEY, dst, LinkStrategy::Auto)
                        .unwrap()
                        .ok
                );
            } else {
                materialize_tree(&src, dst, LinkStrategy::Auto, 2, MaterializeProfile::Auto)
                    .unwrap();
            }
        }
        fs::write(a.join("lib/index.js"), "agent edit").unwrap();
        assert_eq!(
            fs::read_to_string(src.join("lib/index.js")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(b.join("lib/index.js")).unwrap(),
            "original"
        );
        let c = tmp.path().join(format!("c-{cas}"));
        materialize_from_file_cas(&store, "sha256", KEY, &c, LinkStrategy::Auto).unwrap();
        assert_eq!(
            fs::read_to_string(c.join("lib/index.js")).unwrap(),
            "original"
        );
    }
}
#[test]
fn failed_copy_preserves_destination_and_legacy_hardlink_is_replaced() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    let dst = tmp.path().join("dst");
    fs::write(&src, "original").unwrap();
    fs::hard_link(&src, &dst).unwrap();
    assert!(copy_file_with_retry(&tmp.path().join("missing"), &dst).is_err());
    assert_eq!(fs::read_to_string(&dst).unwrap(), "original");
    copy_file_with_retry(&src, &dst).unwrap();
    fs::write(&dst, "edit").unwrap();
    assert_eq!(fs::read_to_string(&src).unwrap(), "original");
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 2);
}
#[test]
fn cas_missing_object_and_malformed_manifest_fail() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    package(&src);
    let store = tmp.path().join("store");
    ingest_to_file_cas(&store, "sha256", KEY, &src).unwrap();
    fs::remove_dir_all(store.join("files")).unwrap();
    assert!(materialize_from_file_cas(
        &store,
        "sha256",
        KEY,
        &tmp.path().join("dst"),
        LinkStrategy::Auto
    )
    .is_err());
    let manifest = store
        .join("packages/sha256/01/23")
        .join(KEY)
        .join("manifest.json");
    for malformed in [
        "{",
        r#"{"files":{"../../escape":{"type":"file","hash":"a"}}}"#,
        r#"{"files":{"index.js":{"type":"file","hash":"a"}}}"#,
    ] {
        fs::write(&manifest, malformed).unwrap();
        assert!(materialize_from_file_cas(
            &store,
            "sha256",
            KEY,
            &tmp.path().join("dst"),
            LinkStrategy::Auto
        )
        .is_err());
    }
}
#[cfg(unix)]
#[test]
fn destination_symlink_does_not_mutate_external_file_and_directory_escape_fails() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    package(&src);
    let external = tmp.path().join("external");
    fs::write(&external, "safe").unwrap();
    let dst = tmp.path().join("dst");
    fs::create_dir_all(&dst).unwrap();
    symlink(&external, dst.join("package.json")).unwrap();
    materialize_tree(&src, &dst, LinkStrategy::Auto, 2, MaterializeProfile::Auto).unwrap();
    assert_eq!(fs::read_to_string(&external).unwrap(), "safe");
    fs::remove_dir_all(dst.join("lib")).unwrap();
    symlink(tmp.path(), dst.join("lib")).unwrap();
    assert!(materialize_tree(&src, &dst, LinkStrategy::Auto, 2, MaterializeProfile::Auto).is_err());
    fs::remove_file(dst.join("lib")).unwrap();
    symlink(&external, src.join("escape")).unwrap();
    assert!(materialize_tree(&src, &dst, LinkStrategy::Auto, 2, MaterializeProfile::Auto).is_err());
}
#[test]
fn traversal_package_paths_are_rejected_but_nested_scoped_paths_pass() {
    let mut pkg = ResolvedPackage {
        selection: Default::default(),
        name: "@scope/pkg".into(),
        version: "1.0.0".into(),
        rel_path: "node_modules/parent/node_modules/@scope/pkg".into(),
        resolved_url: String::new(),
        integrity: String::new(),
    };
    assert!(validate_package_paths(&[pkg.clone()]).is_ok());
    for path in [
        "node_modules/../../outside",
        "/outside",
        "node_modules/..\\outside",
    ] {
        pkg.rel_path = path.into();
        assert!(validate_package_paths(&[pkg.clone()]).is_err());
    }
}
#[test]
fn strict_plan_replaces_legacy_links_and_propagates_missing_sources() {
    use better_core::materialize::strict::{materialise_strict_plan, StrictLayoutPlan};
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("source");
    let dst = tmp.path().join("dest");
    fs::write(&src, "original").unwrap();
    fs::hard_link(&src, &dst).unwrap();
    let plan = StrictLayoutPlan {
        hard_links: vec![(src.clone(), dst.clone())],
        ..Default::default()
    };
    materialise_strict_plan(&plan).unwrap();
    fs::write(&dst, "agent edit").unwrap();
    assert_eq!(fs::read_to_string(&src).unwrap(), "original");
    fs::remove_file(&src).unwrap();
    assert!(materialise_strict_plan(&plan).is_err());
}
#[test]
fn native_strict_rematerialization_breaks_legacy_links() {
    use base64::Engine;
    use better_core::{materialize_strict, unpacked_path, CasLayout};
    let tmp = tempfile::tempdir().unwrap();
    let layout = CasLayout::new(&tmp.path().join("cache"));
    let hash = "01".repeat(64);
    let src = unpacked_path(&layout, "sha512", &hash).join("package");
    package(&src);
    let pkg = ResolvedPackage {
        selection: Default::default(),
        name: "example".into(),
        version: "1.0.0".into(),
        rel_path: "node_modules/example".into(),
        resolved_url: String::new(),
        integrity: format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode([1u8; 64])
        ),
    };
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let real = project.join("node_modules/.better/example@1.0.0/node_modules/example");
    fs::create_dir_all(real.join("lib")).unwrap();
    fs::hard_link(src.join("package.json"), real.join("package.json")).unwrap();
    fs::hard_link(src.join("lib/index.js"), real.join("lib/index.js")).unwrap();
    materialize_strict(
        &[pkg],
        &project,
        &layout,
        &tmp.path().join("file-store"),
        LinkStrategy::Auto,
    )
    .unwrap();
    fs::write(real.join("lib/index.js"), "agent edit").unwrap();
    assert_eq!(
        fs::read_to_string(src.join("lib/index.js")).unwrap(),
        "original"
    );
}
#[cfg(unix)]
#[test]
fn clone_fastpath_refuses_external_symlinks() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("source");
    package(&src);
    std::os::unix::fs::symlink("../../external", src.join("lib/link")).unwrap();
    assert!(better_core::validate_clone_source(&src).is_err());
    assert!(!better_core::try_clonefile_dir(
        &src,
        &tmp.path().join("dest")
    ));
}
#[cfg(unix)]
#[test]
fn file_cas_restores_per_manifest_mode_without_changing_other_package() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    fs::create_dir_all(&src).unwrap();
    let file = src.join("index.js");
    fs::write(&file, "identical content").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    let store = tmp.path().join("store");
    ingest_to_file_cas(&store, "sha256", KEY, &src).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
    let second = "ab".repeat(32);
    ingest_to_file_cas(&store, "sha256", &second, &src).unwrap();
    for strategy in [
        LinkStrategy::Auto,
        LinkStrategy::Copy,
        LinkStrategy::Hardlink,
    ] {
        let dst = tmp.path().join(strategy.as_str());
        let result = materialize_from_file_cas(&store, "sha256", &second, &dst, strategy).unwrap();
        assert_eq!(
            fs::metadata(dst.join("index.js"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert_eq!(
            result.linked, 0,
            "different-mode hardlink must fall back to independent file"
        );
    }
    let original = tmp.path().join("original");
    materialize_from_file_cas(&store, "sha256", KEY, &original, LinkStrategy::Auto).unwrap();
    assert_eq!(
        fs::metadata(original.join("index.js"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
}
#[test]
fn concurrent_identical_cas_ingestion_publishes_complete_files() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("src");
    fs::create_dir_all(&source).unwrap();
    for i in 0..64 {
        fs::write(source.join(format!("file-{i}")), vec![42u8; 32768]).unwrap();
    }
    let store = tmp.path().join("store");
    std::thread::scope(|scope| {
        let mut threads = Vec::new();
        for _ in 0..8 {
            let source = &source;
            let store = &store;
            threads.push(scope.spawn(move || ingest_to_file_cas(store, "sha256", KEY, source)));
        }
        let new_files: u64 = threads
            .into_iter()
            .map(|thread| thread.join().unwrap().unwrap().new_files)
            .sum();
        assert_eq!(
            new_files, 1,
            "one publication winner for identical contents"
        );
    });
    let dst = tmp.path().join("dest");
    materialize_from_file_cas(&store, "sha256", KEY, &dst, LinkStrategy::Auto).unwrap();
    for i in 0..64 {
        assert_eq!(
            fs::read(dst.join(format!("file-{i}"))).unwrap(),
            vec![42u8; 32768]
        );
    }
}

#[test]
fn conflicting_directory_is_preserved_with_actionable_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    fs::write(&src, "replacement").unwrap();
    let dst = tmp.path().join("dst");
    fs::create_dir(&dst).unwrap();
    fs::write(dst.join("user-file"), "preserve").unwrap();
    assert!(copy_file_with_retry(&src, &dst).is_err());
    assert_eq!(
        fs::read_to_string(dst.join("user-file")).unwrap(),
        "preserve"
    );
}
