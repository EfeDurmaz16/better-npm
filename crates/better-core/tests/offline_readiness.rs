use base64::{engine::general_purpose::STANDARD, Engine};
use better_core::{artifact_cache::{ArtifactCache, prepare_offline_packages}, cas_key_from_integrity, ResolvedPackage};
use sha2::{Digest, Sha512};
use std::fs;

fn fixture(root: &std::path::Path) -> (ResolvedPackage, ArtifactCache) {
    let body = br#"{"name":"fixture","version":"1.0.0"}"#;
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);
    for (path, bytes) in [("package/package.json", &body[..]), ("package/index.js", b"module.exports = 42;")] {
        let mut header = tar::Header::new_gnu(); header.set_size(bytes.len() as u64); header.set_mode(0o644); header.set_cksum();
        tar.append_data(&mut header, path, bytes).unwrap();
    }
    let bytes = tar.into_inner().unwrap().finish().unwrap();
    let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(&bytes)));
    let (algorithm, hex) = cas_key_from_integrity(&integrity).unwrap();
    let cache = ArtifactCache::new(root, &algorithm, &hex);
    fs::create_dir_all(cache.tarball.parent().unwrap()).unwrap(); fs::write(&cache.tarball, bytes).unwrap();
    (ResolvedPackage { name:"fixture".into(), version:"1.0.0".into(), rel_path:"node_modules/fixture".into(), resolved_url:"http://127.0.0.1:1/never-requested".into(), integrity, selection:Default::default() }, cache)
}

#[test]
fn offline_migrates_and_repairs_without_any_download() {
    let dir = tempfile::tempdir().unwrap(); let (package, artifact) = fixture(dir.path());
    let result = prepare_offline_packages(&[package.clone()], dir.path(), Default::default()).unwrap();
    assert_eq!(result.bytes_downloaded, 0); assert_eq!(result.packages_fetched, 0); assert!(artifact.ready());
    fs::remove_file(artifact.unpacked.join("package/index.js")).unwrap(); assert!(!artifact.ready());
    fs::write(artifact.unpacked.join("package/extra.js"), "unexpected").unwrap();
    prepare_offline_packages(&[package], dir.path(), Default::default()).unwrap();
    assert!(artifact.ready()); assert!(!artifact.unpacked.join("package/extra.js").exists());
    assert_eq!(fs::read(artifact.unpacked.join("package/index.js")).unwrap(), b"module.exports = 42;");
}

#[test]
fn offline_rejects_corrupt_archive_and_preflights_all_identities() {
    let dir = tempfile::tempdir().unwrap(); let (package, artifact) = fixture(dir.path());
    let mut invalid = package.clone(); invalid.integrity = "sha512-".into();
    assert!(prepare_offline_packages(&[package.clone(), invalid], dir.path(), Default::default()).is_err());
    assert!(!artifact.unpacked.exists());
    fs::write(&artifact.tarball, "corrupted").unwrap();
    assert!(prepare_offline_packages(&[package], dir.path(), Default::default()).is_err()); assert!(!artifact.unpacked.exists());
}

#[test]
fn offline_honors_archive_limits_before_publishing_repair() {
    let dir = tempfile::tempdir().unwrap(); let (package, artifact) = fixture(dir.path());
    let limits = better_core::fetch_pipeline::ArtifactLimits { expanded_bytes: 1, ..Default::default() };
    assert!(prepare_offline_packages(&[package.clone()], dir.path(), limits).is_err());
    assert!(!artifact.unpacked.exists());
    let limits = better_core::fetch_pipeline::ArtifactLimits { compressed_bytes: 1, ..Default::default() };
    assert!(prepare_offline_packages(&[package], dir.path(), limits).is_err());
    assert!(!artifact.unpacked.exists());
}
