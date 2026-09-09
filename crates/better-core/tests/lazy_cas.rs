use std::io::{Read, Write};
use base64::{engine::general_purpose::STANDARD, Engine};
use better_core::{fetch_packages, types::ResolvedPackage};
use better_core::lazy::{write_lazy_manifest, read_lazy_manifest, materialise_lazy_package};
use sha2::{Digest, Sha512};

#[test]
fn fetched_package_is_reachable_and_materialized_from_lazy_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let cache = temp.path().join("cache");
    let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()));
    for (path, content) in [("package/package.json", r#"{"name":"fixture","version":"1.0.0"}"#), ("package/index.js", "module.exports = 42;\n")] {
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append_data(&mut header, path, content.as_bytes()).unwrap();
    }
    let bytes = archive.into_inner().unwrap().finish().unwrap();
    let digest = Sha512::digest(&bytes);
    let integrity = format!("sha512-{}", STANDARD.encode(digest));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/fixture.tgz", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 4096];
        stream.read(&mut request).unwrap();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).unwrap();
        stream.write_all(&bytes).unwrap();
    });
    let package = ResolvedPackage {
        selection: Default::default(), name: "fixture".into(), version: "1.0.0".into(),
        rel_path: "node_modules/fixture".into(), resolved_url: url, integrity,
    };
    let fetched = fetch_packages(&[package.clone()], &cache, None).unwrap();
    server.join().unwrap();
    assert_eq!(fetched.packages_fetched, 1);
    write_lazy_manifest(temp.path(), &[package], &cache).unwrap();
    let manifest = read_lazy_manifest(temp.path()).unwrap();
    let entry = &manifest.packages[0];
    let hex = format!("{:x}", digest);
    assert_eq!(std::path::Path::new(&entry.cas_path), cache.join("store/unpacked/sha512").join(&hex[..2]).join(&hex[2..4]).join(&hex).join("package"));
    assert!(std::path::Path::new(&entry.cas_path).join("package.json").is_file());
    materialise_lazy_package(entry, temp.path()).unwrap();
    assert_eq!(std::fs::read_to_string(temp.path().join("node_modules/fixture/index.js")).unwrap(), "module.exports = 42;\n");
    assert!(!temp.path().join("node_modules/fixture/package").exists());
}

#[test]
fn invalid_integrity_does_not_replace_existing_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let manifest = temp.path().join(".better-lazy.json");
    std::fs::write(&manifest, "preserved").unwrap();
    let package = ResolvedPackage {
        selection: Default::default(), name: "fixture".into(), version: "1".into(),
        rel_path: "node_modules/fixture".into(), resolved_url: "https://example.test/p.tgz".into(), integrity: "sha512-AAAA".into(),
    };
    assert!(write_lazy_manifest(temp.path(), &[package], &temp.path().join("cache")).unwrap_err().contains("invalid integrity"));
    assert_eq!(std::fs::read_to_string(manifest).unwrap(), "preserved");
}
