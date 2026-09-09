use std::{fs, path::Path, process::{Command, Output}};
use better_core::{cas_key_from_integrity, tarball_path, unpacked_path, CasLayout};
use serde_json::{json, Value};

fn fixture(root: &Path, optional: bool) {
    let project = if optional { json!({"name":"fixture","dependencies":{"app":"1"},"optionalDependencies":{"foreign":"1"}}) }
        else { json!({"name":"fixture","dependencies":{"foreign":"1"}}) };
    fs::write(root.join("package.json"),project.to_string()).unwrap();
    fs::write(root.join("package-lock.json"),json!({"lockfileVersion":3,"packages":{
        "":project,
        "node_modules/app":{"version":"1.0.0","resolved":"https://example.test/app.tgz","integrity":"sha512-AAAA"},
        "node_modules/foreign":{"version":"1.0.0","resolved":"https://example.test/foreign.tgz","integrity":"sha512-BBBB","optional":optional,"os":["linux"]}
    }}).to_string()).unwrap();
}

fn seed_app(root: &Path) {
    let layout = CasLayout::new(&root.join("cache"));
    let (algo, hex) = cas_key_from_integrity("sha512-AAAA").unwrap();
    let unpacked = unpacked_path(&layout,&algo,&hex);
    fs::create_dir_all(unpacked.join("package")).unwrap();
    fs::write(unpacked.join("package/package.json"),json!({"name":"app","version":"1.0.0"}).to_string()).unwrap();
    fs::write(unpacked.join(".better_extracted"),"").unwrap();
    let marker = tarball_path(&layout,&algo,&hex).with_extension("tgz.verified");
    fs::create_dir_all(marker.parent().unwrap()).unwrap();
    fs::write(marker,"").unwrap();
}

fn install(root: &Path, layout: &str, os: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_better-core"))
        .args(["install","--offline","--no-scripts",layout,"--os",os,"--cpu","arm64","--project-root"])
        .arg(root).arg("--cache-root").arg(root.join("cache")).output().unwrap()
}

#[test]
fn native_skips_foreign_optional_cache_and_removes_stale_packages_in_both_layouts() {
    for layout in ["--hoist","--strict"] {
        let dir = tempfile::tempdir().unwrap(); let root = dir.path();
        fixture(root,true); seed_app(root);
        fs::create_dir_all(root.join("node_modules/foreign")).unwrap();
        fs::write(root.join("node_modules/foreign/stale"),"old target").unwrap();
        let output = install(root,layout,"darwin");
        assert!(output.status.success(),"{}{}",String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["stats"]["packagesResolved"],1);
        assert_eq!(report["target"],json!({"os":"darwin","cpu":"arm64"}));
        assert!(root.join("node_modules/app/package.json").is_file());
        assert!(!root.join("node_modules/foreign").exists());
        let lock: Value = serde_json::from_slice(&fs::read(root.join("better.lock.json")).unwrap()).unwrap();
        assert!(lock.to_string().contains("foreign"),"full lock must preserve omitted package");
    }
}

#[test]
fn required_mismatch_and_invalid_target_fail_before_cache_or_tree_mutation() {
    for os in ["darwin","not-an-os"] {
        let dir = tempfile::tempdir().unwrap(); let root = dir.path();
        fixture(root,false);
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/keep"),"existing install").unwrap();
        let output = install(root,"--hoist",os);
        assert!(!output.status.success());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains("incompatible") || error.contains("Unsupported install target"),"{error}");
        assert_eq!(fs::read_to_string(root.join("node_modules/keep")).unwrap(),"existing install");
        assert!(!root.join("cache").exists());
        assert!(!root.join("better.lock").exists());
    }
}
