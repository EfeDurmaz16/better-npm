use base64::{engine::general_purpose::STANDARD, Engine};
use better_core::{
    cas_key_from_integrity, fetch_packages, tarball_path, unpacked_path, CasLayout,
    PackageSelection, ResolvedPackage,
};
use sha2::{Digest, Sha256, Sha384, Sha512};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    thread,
};

fn archive() -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);
    let body = br#"{"name":"fixture","version":"1.0.0"}"#;
    let mut header = tar::Header::new_gnu();
    header.set_size(body.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "package/package.json", &body[..])
        .unwrap();
    tar.into_inner().unwrap().finish().unwrap()
}
fn package(integrity: String, url: String) -> ResolvedPackage {
    ResolvedPackage {
        name: "fixture".into(),
        version: "1.0.0".into(),
        rel_path: "node_modules/fixture".into(),
        integrity,
        resolved_url: url,
        selection: PackageSelection::default(),
    }
}
fn serve(bytes: Vec<u8>) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/fixture.tgz", listener.local_addr().unwrap());
    let task = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        stream.read(&mut request).unwrap();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        )
        .unwrap();
        stream.write_all(&bytes).unwrap();
    });
    (url, task)
}
#[test]
fn downloads_verify_all_supported_algorithms_and_reject_wrong_sha1() {
    let bytes = archive();
    for (algorithm, digest) in [
        ("sha1", sha1::Sha1::digest(&bytes).to_vec()),
        ("sha256", Sha256::digest(&bytes).to_vec()),
        ("sha384", Sha384::digest(&bytes).to_vec()),
        ("sha512", Sha512::digest(&bytes).to_vec()),
        ("sha1", vec![0; 20]),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (url, server) = serve(bytes.clone());
        let integrity = format!("{algorithm}-{}", STANDARD.encode(&digest));
        let result = fetch_packages(&[package(integrity.clone(), url)], dir.path(), None);
        server.join().unwrap();
        let (algo, hex) = cas_key_from_integrity(&integrity).unwrap();
        let layout = CasLayout::new(dir.path());
        if digest == vec![0; 20] {
            assert!(result.err().unwrap().contains("Integrity mismatch"));
            assert!(!tarball_path(&layout, &algo, &hex).exists());
            assert!(!unpacked_path(&layout, &algo, &hex)
                .join("package/package.json")
                .exists());
        } else {
            assert_eq!(result.unwrap().packages_fetched, 1);
        }
    }
}
#[test]
fn legacy_markers_cannot_authorize_wrong_sha1_online_or_offline() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    let integrity = format!("sha1-{}", STANDARD.encode([0; 20]));
    let (algo, hex) = cas_key_from_integrity(&integrity).unwrap();
    let layout = CasLayout::new(&cache);
    let tarball = tarball_path(&layout, &algo, &hex);
    let unpacked = unpacked_path(&layout, &algo, &hex);
    fs::create_dir_all(tarball.parent().unwrap()).unwrap();
    fs::create_dir_all(unpacked.join("package")).unwrap();
    fs::write(&tarball, archive()).unwrap();
    fs::write(tarball.with_extension("tgz.verified"), "").unwrap();
    fs::write(unpacked.join(".better_extracted"), "").unwrap();
    fs::write(
        dir.path().join("package.json"),
        r#"{"name":"root","version":"1.0.0"}"#,
    )
    .unwrap();
    for value in [&integrity, "sha512-", "../escape-AQID"] {
        fs::write(dir.path().join("package-lock.json"),serde_json::json!({"lockfileVersion":3,"packages":{"":{"name":"root","version":"1.0.0"},"node_modules/fixture":{"version":"1.0.0","resolved":"http://127.0.0.1:1/x","integrity":value}}}).to_string()).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_better-core"))
            .args(["install", "--offline", "--ignore-scripts", "--cache-dir"])
            .arg(&cache)
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(!dir.path().join("node_modules").exists());
    }
    let (url, server) = serve(archive());
    assert!(fetch_packages(&[package(integrity, url)], &cache, None)
        .err()
        .unwrap()
        .contains("Integrity mismatch"));
    server.join().unwrap();
}

#[test]
fn legacy_repair_discards_stale_extracted_files() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = archive();
    let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(&bytes)));
    let (algo, hex) = cas_key_from_integrity(&integrity).unwrap();
    let layout = CasLayout::new(dir.path());
    let tarball = tarball_path(&layout, &algo, &hex);
    let unpacked = unpacked_path(&layout, &algo, &hex);
    fs::create_dir_all(tarball.parent().unwrap()).unwrap();
    fs::create_dir_all(unpacked.join("package")).unwrap();
    fs::write(&tarball, &bytes).unwrap();
    fs::write(tarball.with_extension("tgz.verified"), "").unwrap();
    fs::write(unpacked.join(".better_extracted"), "").unwrap();
    fs::write(unpacked.join("package/stale.js"), "stale legacy content").unwrap();
    let (url, server) = serve(bytes);
    assert_eq!(fetch_packages(&[package(integrity, url)], dir.path(), None).unwrap().packages_fetched, 1);
    server.join().unwrap();
    assert!(!unpacked.join("package/stale.js").exists());
    assert!(unpacked.join("package/package.json").exists());
    assert_eq!(fs::read_to_string(tarball.with_extension("tgz.verified")).unwrap(), better_core::integrity::VERIFIED_MARKER);
}
