use base64::{engine::general_purpose::STANDARD, Engine};
use better_core::{fetch_packages_with_options, fetch_pipeline::FetchOptions, PackageSelection, ResolvedPackage};
use sha2::{Digest, Sha512};
use std::{io::{Read, Write}, net::TcpListener, sync::{Arc, atomic::{AtomicUsize, Ordering}}, thread, time::{Duration, Instant}};

fn archive(name: &str) -> Vec<u8> {
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    let data = format!("{{\"name\":\"{name}\",\"version\":\"1.0.0\"}}");
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64); header.set_mode(0o644); header.set_cksum();
    tar.append_data(&mut header, "package/package.json", data.as_bytes()).unwrap();
    tar.into_inner().unwrap().finish().unwrap()
}

#[test]
fn real_http_obeys_jobs_and_returns_bounded_stage_metrics() {
    for jobs in [1, 4] {
        let cache = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let blobs: Vec<_> = (0..8).map(|n| archive(&format!("p{n}"))).collect();
        let packages: Vec<_> = blobs.iter().enumerate().map(|(n, blob)| ResolvedPackage {
            name: format!("p{n}"), version: "1.0.0".into(), rel_path: format!("node_modules/p{n}"),
            resolved_url: format!("{base}/{n}"), integrity: format!("sha512-{}", STANDARD.encode(Sha512::digest(blob))),
            selection: PackageSelection::default(),
        }).collect();
        let active = Arc::new(AtomicUsize::new(0)); let peak = Arc::new(AtomicUsize::new(0));
        let server_peak = peak.clone();
        let server = thread::spawn(move || {
            let start = Instant::now(); let mut requests = Vec::new();
            while requests.len() < 8 && start.elapsed() < Duration::from_secs(10) {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => { thread::sleep(Duration::from_millis(1)); continue; }
                    Err(e) => panic!("{e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let active = active.clone(); let peak = server_peak.clone(); let blobs = blobs.clone();
                requests.push(thread::spawn(move || {
                    let mut bytes = [0; 4096]; let n = stream.read(&mut bytes).unwrap();
                    let request = String::from_utf8_lossy(&bytes[..n]);
                    let path = request.split_whitespace().nth(1).unwrap();
                    let index: usize = path.trim_start_matches('/').parse().unwrap();
                    let count = active.fetch_add(1, Ordering::SeqCst) + 1; peak.fetch_max(count, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(75));
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", blobs[index].len()).unwrap();
                    stream.write_all(&blobs[index]).unwrap(); active.fetch_sub(1, Ordering::SeqCst);
                }));
            }
            let count = requests.len(); for request in requests { request.join().unwrap(); } count
        });
        let options = FetchOptions { network_jobs: jobs, extract_jobs: 1, ..FetchOptions::default() };
        let result = fetch_packages_with_options(&packages, cache.path(), None, &options).unwrap();
        assert_eq!(server.join().unwrap(), 8);
        assert_eq!(result.packages_fetched, 8);
        assert_eq!(peak.load(Ordering::SeqCst), jobs);
        assert!(result.metrics.peak_preparing <= jobs);
        assert_eq!(result.metrics.peak_extracting, 1);
        assert_eq!(result.metrics.queue_capacity, 1);
        // A warm run never contacts the now-closed server or performs extraction.
        let warm = fetch_packages_with_options(&packages, cache.path(), None, &options).unwrap();
        assert_eq!(warm.packages_cached, 8); assert_eq!(warm.bytes_downloaded, 0);
        assert_eq!(warm.metrics.peak_extracting, 0);
    }
}
