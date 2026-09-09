use base64::{engine::general_purpose::STANDARD, Engine};
use better_core::{cas_key_from_integrity, tarball_path, unpacked_path, CasLayout};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn fixture(root: &Path) {
    let mut packages = serde_json::Map::new();
    packages.insert(
        "".into(),
        json!({"name":"fixture","version":"1.0.0",
        "dependencies":{"prod":"1.0.0","shared":"1.0.0","both":"1.0.0"},
        "devDependencies":{"dev":"1.0.0"}}),
    );
    for (i, name) in ["prod", "transitive", "shared", "both", "dev"]
        .iter()
        .enumerate()
    {
        let integrity = format!("sha512-{}", STANDARD.encode([i as u8 + 1; 64]));
        let mut entry = json!({"version":"1.0.0", "resolved":format!("https://registry.npmjs.org/{name}/-/{name}-1.0.0.tgz"),"integrity":integrity});
        if *name == "dev" {
            entry["dev"] = json!(true);
        }
        if *name == "both" {
            entry["devOptional"] = json!(true);
        }
        if *name == "prod" {
            entry["dependencies"] = json!({"transitive":"1.0.0","shared":"1.0.0"});
        }
        packages.insert(format!("node_modules/{name}"), entry);
        let layout = CasLayout::new(&root.join("cache"));
        let (algo, hex) = cas_key_from_integrity(&integrity).unwrap();
        let unpacked = unpacked_path(&layout, &algo, &hex);
        fs::create_dir_all(unpacked.join("package")).unwrap();
        fs::write(
            unpacked.join("package/package.json"),
            json!({"name":name,"version":"1.0.0","bin":{format!("{name}-cmd"):"cli.js"}})
                .to_string(),
        )
        .unwrap();
        fs::write(unpacked.join("package/cli.js"), "#!/usr/bin/env node\n").unwrap();
        fs::write(unpacked.join(".better_extracted"), "").unwrap();
        let marker = tarball_path(&layout, &algo, &hex).with_extension("tgz.verified");
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(marker, "").unwrap();
    }
    fs::write(root.join("package.json"), packages[""].to_string()).unwrap();
    fs::write(
        root.join("package-lock.json"),
        json!({"lockfileVersion":3,"packages":packages}).to_string(),
    )
    .unwrap();
}

fn install(root: &Path, layout: &str, production: bool, frozen: bool) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_better-core"));
    command
        .args([
            "install",
            "--offline",
            "--no-scripts",
            layout,
            "--project-root",
        ])
        .arg(root)
        .arg("--cache-root")
        .arg(root.join("cache"));
    if production {
        command.arg("--production");
    }
    if frozen {
        command.arg("--frozen");
    }
    command.output().unwrap()
}
fn report(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn production_refreshes_both_layouts_and_preserves_full_lock() {
    for layout in ["--hoist", "--strict"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fixture(root);
        assert_eq!(
            report(install(root, layout, false, false))["stats"]["packagesResolved"],
            5
        );
        assert!(root.join("node_modules/dev/package.json").exists());
        assert!(root.join("node_modules/.bin/dev-cmd").exists());
        let lock = fs::read(root.join("better.lock")).unwrap();
        // Dev cache is unnecessary in production, including frozen installs.
        let integrity = format!("sha512-{}", STANDARD.encode([5u8; 64]));
        let (algo, hex) = cas_key_from_integrity(&integrity).unwrap();
        fs::remove_dir_all(unpacked_path(
            &CasLayout::new(&root.join("cache")),
            &algo,
            &hex,
        ))
        .unwrap();
        assert_eq!(
            report(install(root, layout, true, true))["stats"]["packagesResolved"],
            4
        );
        for name in ["prod", "transitive", "shared", "both"] {
            // Strict exposes direct dependencies at root; transitive packages are isolated.
            let path = if layout == "--strict" && name == "transitive" {
                root.join(
                    "node_modules/.better/transitive@1.0.0/node_modules/transitive/package.json",
                )
            } else {
                root.join(format!("node_modules/{name}/package.json"))
            };
            assert!(path.exists(), "{}", path.display());
        }
        assert!(!root.join("node_modules/dev").exists());
        assert!(!root.join("node_modules/.bin/dev-cmd").exists());
        assert!(!root.join("node_modules/.better/dev@1.0.0").exists());
        assert_eq!(fs::read(root.join("better.lock")).unwrap(), lock);
        report(install(root, layout, true, false));
        assert_eq!(fs::read(root.join("better.lock")).unwrap(), lock);
    }
}

#[test]
fn required_cache_miss_preserves_existing_install() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    report(install(root, "--hoist", false, false));
    let integrity = format!("sha512-{}", STANDARD.encode([1u8; 64]));
    let (algo, hex) = cas_key_from_integrity(&integrity).unwrap();
    fs::remove_dir_all(unpacked_path(
        &CasLayout::new(&root.join("cache")),
        &algo,
        &hex,
    ))
    .unwrap();
    let output = install(root, "--hoist", true, false);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("package not in cache"));
    assert!(root.join("node_modules/dev/package.json").exists());
    assert!(root.join("node_modules/.bin/dev-cmd").exists());
}

#[test]
fn javascript_cli_forwards_production_to_current_native_binary() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    report(install(root, "--hoist", false, false));
    let cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin/better.js");
    let output = Command::new("node")
        .arg(cli)
        .args([
            "install",
            "--engine",
            "better",
            "--experimental",
            "--offline",
            "--production",
            "--scripts",
            "off",
            "--measure",
            "off",
            "--json",
            "--project-root",
        ])
        .arg(root)
        .arg("--cache-root")
        .arg(root.join("cache"))
        .env("BETTER_CORE_PATH", env!("CARGO_BIN_EXE_better-core"))
        .output()
        .unwrap();
    let result = report(output);
    assert_eq!(result["betterEngine"]["stats"]["packagesResolved"], 4);
    assert!(!root.join("node_modules/dev/package.json").exists());
    assert!(root.join("node_modules/prod/package.json").exists());
}

#[cfg(unix)]
#[test]
fn production_lifecycle_sets_child_environment_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    let integrity = format!("sha512-{}", STANDARD.encode([1u8; 64]));
    let (algo, hex) = cas_key_from_integrity(&integrity).unwrap();
    let pkg = unpacked_path(&CasLayout::new(&root.join("cache")), &algo, &hex).join("package");
    fs::write(
        pkg.join("package.json"),
        json!({"name":"prod","version":"1.0.0","scripts":{"install":"node-gyp rebuild"}})
            .to_string(),
    )
    .unwrap();
    fs::create_dir(root.join("tools")).unwrap();
    let npm = root.join("tools/npm");
    fs::write(
        &npm,
        "#!/bin/sh\nprintf '%s' \"$NODE_ENV\" > lifecycle-env\n",
    )
    .unwrap();
    fs::set_permissions(&npm, fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_better-core"))
        .args(["install", "--production", "--offline", "--project-root"])
        .arg(root)
        .arg("--cache-root")
        .arg(root.join("cache"))
        .env(
            "PATH",
            format!(
                "{}:{}",
                root.join("tools").display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .env("NODE_ENV", "development")
        .output()
        .unwrap();
    report(output);
    assert_eq!(
        fs::read_to_string(root.join("lifecycle-env")).unwrap(),
        "production"
    );
}

#[test]
fn production_does_not_delete_a_custom_cache_inside_node_modules() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    report(install(root, "--hoist", false, false));
    let cache = root.join("node_modules/cache");
    fs::rename(root.join("cache"), &cache).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_better-core"))
        .args([
            "install",
            "--production",
            "--offline",
            "--no-scripts",
            "--project-root",
        ])
        .arg(root)
        .arg("--cache-root")
        .arg(&cache)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("outside node_modules"));
    assert!(cache.exists());
    assert!(root.join("node_modules/dev/package.json").exists());
}

#[test]
fn corrupt_cache_markers_do_not_authorize_production_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fixture(root);
    report(install(root, "--hoist", false, false));
    let integrity = format!("sha512-{}", STANDARD.encode([1u8; 64]));
    let (algo, hex) = cas_key_from_integrity(&integrity).unwrap();
    let unpacked = unpacked_path(&CasLayout::new(&root.join("cache")), &algo, &hex);
    fs::remove_dir_all(unpacked.join("package")).unwrap();
    assert!(unpacked.join(".better_extracted").exists());
    let output = install(root, "--hoist", true, false);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("complete cached package"));
    assert!(root.join("node_modules/prod/package.json").exists());
    assert!(root.join("node_modules/dev/package.json").exists());
}
