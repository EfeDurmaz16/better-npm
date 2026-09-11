use base64::{engine::general_purpose::STANDARD, Engine};
use better_core::{
    artifact_cache::ArtifactCache,
    cas_key_from_integrity,
    coordinator::{options_from_json, submit},
    install::run_install,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use std::{fs, path::Path};

fn package(cache: &Path, name: &str, invalid_bin: bool) -> Value {
    let mut manifest = json!({"name":name,"version":"1.0.0"});
    if invalid_bin {
        manifest["bin"] = json!({"missing-parent/command":"index.js"});
    }
    let manifest = manifest.to_string();
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);
    let files = vec![
        ("package/package.json", manifest.as_bytes()),
        ("package/index.js", b"module.exports = 42;".as_slice()),
    ];
    for (path, data) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, path, data).unwrap();
    }
    let bytes = tar.into_inner().unwrap().finish().unwrap();
    let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(&bytes)));
    let (algo, hex) = cas_key_from_integrity(&integrity).unwrap();
    let artifact = ArtifactCache::new(cache, &algo, &hex);
    fs::create_dir_all(artifact.tarball.parent().unwrap()).unwrap();
    fs::write(artifact.tarball, bytes).unwrap();
    json!({"version":"1.0.0","resolved":"http://127.0.0.1:1/never-requested","integrity":integrity})
}

fn fixture(root: &Path, invalid_bin: bool) {
    let parent = package(&root.join("cache"), "parent", invalid_bin);
    let mut packages = serde_json::Map::new();
    let manifest = json!({"name":"fixture","version":"1.0.0","dependencies":{"parent":"1.0.0"}});
    packages.insert("".into(), manifest.clone());
    packages.insert("node_modules/parent".into(), parent);
    fs::write(root.join("package.json"), manifest.to_string()).unwrap();
    fs::write(
        root.join("package-lock.json"),
        json!({"lockfileVersion":3,"packages":packages}).to_string(),
    )
    .unwrap();
    fs::write(root.join(".better-firewall.json"), r#"{"enabled":false}"#).unwrap();
}
fn options(root: &Path) -> better_core::install::InstallOptions {
    options_from_json(
        &json!({"projectRoot":root,"cacheRoot":root.join("cache"),"offline":true,"scripts":false})
            .to_string(),
    )
    .unwrap()
}
fn no_stages(root: &Path) -> bool {
    fs::read_dir(root).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".better-install-stage-")
    })
}

#[test]
fn canonical_and_resident_are_ready_with_the_same_contents() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path(), false);
    let first: Value = serde_json::from_str(&run_install(options(temp.path())).unwrap()).unwrap();
    assert_eq!(first["preparedTree"], true);
    let expected = fs::read(temp.path().join("node_modules/parent/index.js")).unwrap();
    fs::write(temp.path().join("node_modules/keep.txt"), "keep").unwrap();
    let second: Value =
        serde_json::from_str(&submit(options(temp.path())).unwrap().wait().unwrap()).unwrap();
    assert_eq!(second["ok"], true);
    assert_eq!(second["preparedTree"], false);
    assert_eq!(
        first["stats"]["packagesResolved"],
        second["stats"]["packagesResolved"]
    );
    assert_eq!(
        fs::read(temp.path().join("node_modules/parent/index.js")).unwrap(),
        expected
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("node_modules/keep.txt")).unwrap(),
        "keep"
    );
    assert!(
        second["resident"]["readyMicros"].as_u64().unwrap()
            >= second["resident"]["queueWaitMicros"].as_u64().unwrap()
    );
    assert!(no_stages(temp.path()));
}

#[test]
fn failed_fresh_bin_preparation_never_publishes_partial_tree() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path(), true);
    let error = run_install(options(temp.path())).unwrap_err();
    assert!(error.report.contains("bin link"), "{}", error.report);
    assert!(!temp.path().join("node_modules").exists());
    assert!(no_stages(temp.path()));
}

#[test]
fn busy_project_fails_without_mutation_and_worker_survives_failure() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path(), false);
    fs::create_dir(temp.path().join(".better")).unwrap();
    let lease = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(temp.path().join(".better/install.lock"))
        .unwrap();
    lease.lock().unwrap();
    let error = submit(options(temp.path())).unwrap().wait().unwrap_err();
    assert!(error.report.contains("busy"));
    assert!(!temp.path().join("node_modules").exists());
    drop(lease);
    assert!(submit(options(temp.path())).unwrap().wait().is_ok());
}

#[cfg(unix)]
#[test]
fn production_fresh_tree_preserves_normal_directory_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path(), false);
    let control = temp.path().join("ordinary-directory");
    fs::create_dir(&control).unwrap();
    let expected_mode = fs::metadata(control).unwrap().permissions().mode() & 0o777;
    let mut opts = options(temp.path());
    opts.production = true;
    let report: Value = serde_json::from_str(&run_install(opts).unwrap()).unwrap();
    assert_eq!(report["preparedTree"], true);
    assert_eq!(
        fs::metadata(temp.path().join("node_modules"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        expected_mode
    );
    assert!(no_stages(temp.path()));
}

#[test]
fn mcp_install_uses_canonical_resident_result_and_rejects_ignored_flags() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path(), false);
    let args = json!({"project_root":temp.path(),"cache_root":temp.path().join("cache"),"offline":true,"scripts":false});
    let result = better_core::mcp::tools::execute_tool("install", &args);
    assert!(!result.is_error);
    let encoded = serde_json::to_value(result).unwrap();
    let report: Value =
        serde_json::from_str(encoded["content"][0]["text"].as_str().unwrap()).unwrap();
    assert!(report["resident"]["readyMicros"].is_u64());
    let mut invalid = args;
    invalid["sandbox"] = json!(true);
    assert!(better_core::mcp::tools::execute_tool("install", &invalid).is_error);
}

#[test]
fn strict_warm_report_counts_reused_package_files() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path(), false);
    let mut opts = options(temp.path());
    opts.node_layout = better_core::NodeLayout::Strict;
    run_install(opts).unwrap();
    let mut opts = options(temp.path());
    opts.node_layout = better_core::NodeLayout::Strict;
    let report: Value = serde_json::from_str(&run_install(opts).unwrap()).unwrap();
    #[cfg(unix)]
    {
        assert_eq!(report["strict"]["filesReused"], 2);
        assert_eq!(report["stats"]["filesReused"], 2);
        assert_eq!(report["stats"]["files"], 2);
    }
    #[cfg(not(unix))]
    assert!(report["ok"].as_bool().unwrap());
}

#[test]
fn non_dedup_cold_warm_and_noop_never_populate_file_cas() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path(), false);
    let store = temp.path().join("unused-file-store");
    let install = || {
        let mut opts = options(temp.path());
        opts.store_root = Some(store.clone());
        assert!(!opts.dedup);
        let report: Value = serde_json::from_str(&run_install(opts).unwrap()).unwrap();
        assert!(!store.exists(), "Non-dedup install created file CAS");
        assert!(!temp.path().join("cache/file-store").exists());
        assert_eq!(report["stats"]["casLinked"], 0);
        assert_eq!(report["stats"]["casCopied"], 0);
        report
    };
    assert_eq!(install()["preparedTree"], true);
    fs::remove_dir_all(temp.path().join("node_modules")).unwrap();
    assert_eq!(install()["preparedTree"], true);
    let noop = install();
    assert_eq!(noop["preparedTree"], false);
    assert_eq!(noop["stats"]["files"], 2);
    #[cfg(unix)]
    assert_eq!(noop["stats"]["filesReused"], 2);

    let packages =
        better_core::resolve_from_lockfile(&temp.path().join("package-lock.json")).unwrap();
    let (algo, hex) = cas_key_from_integrity(&packages.packages[0].integrity).unwrap();
    let source = better_core::unpacked_path(
        &better_core::CasLayout::new(&temp.path().join("cache")),
        &algo,
        &hex,
    )
    .join("package/index.js");
    let expected = fs::read(&source).unwrap();
    let destination = temp.path().join("node_modules/parent/index.js");
    fs::write(&destination, "module.exports = 41;").unwrap();
    assert_eq!(
        fs::read(&source).unwrap(),
        expected,
        "Worktree mutation changed cached source"
    );
    let repaired = install();
    assert_eq!(fs::read(destination).unwrap(), expected);
    assert_eq!(repaired["stats"]["files"], 2);
    #[cfg(unix)]
    assert_eq!(repaired["stats"]["filesReused"], 1);
}

#[test]
fn blocked_artifact_in_one_project_does_not_block_an_independent_project() {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    if std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        < 2
    {
        return;
    }
    let project_a = tempfile::tempdir().unwrap();
    fixture(project_a.path(), false);
    let resolved =
        better_core::resolve_from_lockfile(&project_a.path().join("package-lock.json")).unwrap();
    let (algo, hex) = cas_key_from_integrity(&resolved.packages[0].integrity).unwrap();
    let artifact = ArtifactCache::new(&project_a.path().join("cache"), &algo, &hex);
    let producer = artifact.lock().unwrap();
    let a = submit(options(project_a.path())).unwrap();
    let (a_tx, a_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = a_tx.send(a.wait());
    });

    // Observe the project writer lease to establish that A has started before B
    // is submitted. A must remain blocked behind the held artifact producer.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut a_started = false;
    while Instant::now() < deadline {
        if let Ok(file) = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(project_a.path().join(".better/install.lock"))
        {
            if matches!(file.try_lock(), Err(fs::TryLockError::WouldBlock)) {
                a_started = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let project_b = tempfile::tempdir().unwrap();
    fs::write(
        project_b.path().join("package.json"),
        r#"{"name":"empty","version":"1.0.0"}"#,
    )
    .unwrap();
    fs::write(
        project_b.path().join("package-lock.json"),
        json!({"lockfileVersion":3,"packages":{"":{"name":"empty","version":"1.0.0"}}}).to_string(),
    )
    .unwrap();
    fs::write(
        project_b.path().join(".better-firewall.json"),
        r#"{"enabled":false}"#,
    )
    .unwrap();
    let b = submit(options(project_b.path())).unwrap();
    let (b_tx, b_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = b_tx.send(b.wait());
    });
    let b_result = b_rx.recv_timeout(Duration::from_secs(5));
    let a_still_blocked = matches!(a_rx.try_recv(), Err(mpsc::TryRecvError::Empty));
    // Release before any assertion, including the timeout branch, so a failed
    // regression test cannot strand a coordinator worker behind its own guard.
    drop(producer);
    let a_result = a_rx.recv_timeout(Duration::from_secs(5));
    assert!(a_started);
    assert!(a_still_blocked);
    let report: Value =
        serde_json::from_str(&b_result.expect("Independent project B timed out").unwrap()).unwrap();
    assert!(report["resident"]["coordinatorWorkers"].as_u64().unwrap() >= 2);
    assert!(a_result
        .expect("Project A did not resume after producer release")
        .is_ok());
}

#[test]
fn nonempty_offline_resident_install_obeys_effective_worker_caps() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path(), false);
    let mut opts = options(root.path());
    // Direct Rust callers must also be capped at admission.
    opts.jobs = 256;
    opts.extraction_jobs = Some(256);
    let report: Value = serde_json::from_str(&submit(opts).unwrap().wait().unwrap()).unwrap();
    let metrics = &report["stats"]["fetchMetrics"];
    assert_eq!(report["stats"]["packagesCached"], 1);
    assert_eq!(metrics["networkJobs"], 4);
    assert_eq!(metrics["extractJobs"], 1);
    assert!(metrics["peakPreparing"].as_u64().unwrap() > 0);
    assert!(metrics["peakPreparing"].as_u64().unwrap() <= 4);
    assert_eq!(metrics["peakExtracting"], 0);
    let mut opts = options(root.path());
    opts.jobs = 2;
    opts.extraction_jobs = Some(1);
    let report: Value = serde_json::from_str(&submit(opts).unwrap().wait().unwrap()).unwrap();
    assert_eq!(report["stats"]["fetchMetrics"]["networkJobs"], 1);
}
