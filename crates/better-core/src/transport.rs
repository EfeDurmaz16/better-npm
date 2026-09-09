//! Native npm GET boundary. Never carry credentials between destinations.
use crate::npmrc::{find_auth_token, registry_for_package};
use crate::types::{NpmrcConfig, ResolvedPackage};
use reqwest::blocking::{Client, Response};
use reqwest::{StatusCode, Url};
use std::time::Duration;

pub(crate) fn client() -> Result<Client, String> {
    Client::builder()
        .use_rustls_tls()
        .http2_adaptive_window(true)
        .pool_max_idle_per_host(10)
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Failed to create HTTP client".to_string())
}

fn validate_url(url: Url) -> Result<Url, String> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Tarball URL must use HTTP(S) without embedded credentials".to_string());
    }
    Ok(url)
}

fn download_url(pkg: &ResolvedPackage, config: Option<&NpmrcConfig>) -> Result<Url, String> {
    let mut url = validate_url(Url::parse(&pkg.resolved_url).map_err(|_| "Invalid tarball URL")?)?;
    if url.scheme() == "https"
        && url.host_str() == Some("registry.npmjs.org")
        && url.port_or_known_default() == Some(443)
    {
        if let Some(config) = config {
            let (registry, _) = registry_for_package(config, &pkg.name);
            let mut base = validate_url(Url::parse(registry).map_err(|_| "Invalid registry URL")?)?;
            if base.query().is_some() || base.fragment().is_some() {
                return Err("Registry URL must not contain a query or fragment".to_string());
            }
            // set_path preserves escaped package names and cannot reinterpret a
            // leading slash in the lockfile as a new authority.
            base.set_path(&format!(
                "{}/{}",
                base.path().trim_end_matches('/'),
                url.path().trim_start_matches('/')
            ));
            base.set_query(url.query());
            base.set_fragment(url.fragment());
            url = base;
        }
    }
    Ok(url)
}

fn redirect_url(current: &Url, location: &str) -> Result<Url, String> {
    let next = validate_url(
        current
            .join(location)
            .map_err(|_| "Invalid tarball redirect")?,
    )?;
    if current.scheme() == "https" && next.scheme() != "https" {
        return Err("Tarball HTTPS downgrade redirect rejected".to_string());
    }
    Ok(next)
}

pub(crate) fn download(
    client: &Client,
    pkg: &ResolvedPackage,
    config: Option<&NpmrcConfig>,
) -> Result<Response, String> {
    let mut url = download_url(pkg, config)?;
    let mut redirects = 0;
    let mut retries = 0;
    loop {
        let mut request = client.get(url.clone());
        if let Some(token) = config.and_then(|cfg| find_auth_token(cfg, url.as_str())) {
            let mut header = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token))
                .map_err(|_| "Invalid registry authorization header")?;
            header.set_sensitive(true);
            request = request.header(reqwest::header::AUTHORIZATION, header);
        }
        let response = match request.send() {
            Ok(response) => response,
            Err(error) if retries < 2 && (error.is_timeout() || error.is_connect()) => {
                retries += 1;
                std::thread::sleep(Duration::from_millis(100 * retries));
                continue;
            }
            // Avoid URL/query credentials in reqwest's Display implementation.
            Err(_) => return Err(format!("Failed to download {}", pkg.name)),
        };
        let status = response.status();
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            if redirects >= 10 {
                return Err("Tarball redirect limit exceeded".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("Invalid tarball redirect")?;
            url = redirect_url(&url, location)?;
            redirects += 1;
            continue;
        }
        if retries < 2 && matches!(status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504) {
            // Never retry early when the server asks for a longer/dated delay.
            // Return the status instead of sleeping without a bounded budget.
            if response
                .headers()
                .contains_key(reqwest::header::RETRY_AFTER)
            {
                return Err(format!(
                    "Download {} returned HTTP {}",
                    pkg.name,
                    status.as_u16()
                ));
            }
            retries += 1;
            drop(response);
            std::thread::sleep(Duration::from_millis(100 * retries));
            continue;
        }
        // No Range was sent: 206 and empty successful responses are not complete tarballs.
        if status != StatusCode::OK {
            return Err(format!(
                "Download {} returned HTTP {}",
                pkg.name,
                status.as_u16()
            ));
        }
        return Ok(response);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn package(url: &str) -> ResolvedPackage {
        ResolvedPackage {
            name: "@org/pkg".into(),
            version: "1.0.0".into(),
            rel_path: "node_modules/@org/pkg".into(),
            resolved_url: url.into(),
            integrity: String::new(),
            selection: Default::default(),
        }
    }

    fn server(
        responses: Vec<String>,
    ) -> (String, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output = seen.clone();
        let thread = std::thread::spawn(move || {
            for response in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    if socket.read(&mut byte).unwrap() == 0 {
                        break;
                    }
                    request.push(byte[0]);
                }
                output
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(request).unwrap().to_lowercase());
                socket.write_all(response.as_bytes()).unwrap();
            }
        });
        (url, seen, thread)
    }
    fn response(code: u16, extra: &str) -> String {
        format!(
            "HTTP/1.1 {} Test\r\nContent-Length: 2\r\nConnection: close\r\n{}\r\nok",
            code, extra
        )
    }
    fn cfg(url: &str, scope: &str) -> NpmrcConfig {
        let mut config = NpmrcConfig::default();
        config.default_registry = format!("{}/private/", url);
        config.auth_tokens.push((
            format!("{}{}", url.trim_start_matches("http://"), scope),
            "FAKE_TEST_TOKEN".into(),
        ));
        config
    }
    #[test]
    fn status_retry_and_terminal_failures() {
        let (url, seen, thread) = server(vec![response(503, ""), response(200, "")]);
        assert_eq!(
            download(&client().unwrap(), &package(&url), None)
                .unwrap()
                .text()
                .unwrap(),
            "ok"
        );
        thread.join().unwrap();
        assert_eq!(seen.lock().unwrap().len(), 2);
        for code in [401, 404, 206, 204, 304] {
            let (url, _, thread) = server(vec![response(code, "")]);
            assert!(download(&client().unwrap(), &package(&url), None)
                .unwrap_err()
                .contains(&code.to_string()));
            thread.join().unwrap();
        }
        let (url, seen, thread) = server(vec![response(503, ""); 3]);
        assert!(download(&client().unwrap(), &package(&url), None).is_err());
        thread.join().unwrap();
        assert_eq!(seen.lock().unwrap().len(), 3);
    }
    #[test]
    fn retry_after_does_not_retry_early() {
        let (url, seen, thread) = server(vec![response(429, "Retry-After: 120\r\n")]);
        assert!(download(&client().unwrap(), &package(&url), None).is_err());
        thread.join().unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
    #[test]
    fn http_requests_and_same_origin_redirects_remain_anonymous() {
        let (url, seen, thread) = server(vec![
            response(302, "Location: /outside/pkg.tgz\r\n"),
            response(200, ""),
        ]);
        let config = cfg(&url, "/private/");
        download(
            &client().unwrap(),
            &package(&format!("{}/private/pkg.tgz", url)),
            Some(&config),
        )
        .unwrap();
        thread.join().unwrap();
        let requests = seen.lock().unwrap();
        assert!(!requests[0].contains("authorization:"));
        assert!(!requests[1].contains("authorization:"));
        drop(requests);
        let (other, seen, thread) = server(vec![response(200, "")]);
        download(&client().unwrap(), &package(&other), Some(&config)).unwrap();
        thread.join().unwrap();
        assert!(!seen.lock().unwrap()[0].contains("authorization:"));
    }
    #[test]
    fn http_cross_origin_redirects_remain_anonymous() {
        let (other, seen_other, other_thread) = server(vec![response(200, "")]);
        let (url, seen, thread) = server(vec![response(
            302,
            &format!("Location: {}/pkg.tgz\r\n", other),
        )]);
        let config = cfg(&url, "/private/");
        download(
            &client().unwrap(),
            &package(&format!("{}/private/pkg", url)),
            Some(&config),
        )
        .unwrap();
        thread.join().unwrap();
        other_thread.join().unwrap();
        assert!(!seen.lock().unwrap()[0].contains("authorization:"));
        assert!(!seen_other.lock().unwrap()[0].contains("authorization:"));
    }

    #[test]
    fn initial_http_cannot_downgrade_https_registry_auth() {
        let (url, seen, thread) = server(vec![response(200, "")]);
        let mut config = cfg(&url, "/private/");
        config.default_registry = config.default_registry.replace("http:", "https:");
        download(
            &client().unwrap(),
            &package(&format!("{}/private/pkg", url)),
            Some(&config),
        )
        .unwrap();
        thread.join().unwrap();
        assert!(!seen.lock().unwrap()[0].contains("authorization:"));
    }

    #[test]
    fn scoped_registry_rewrite_preserves_path() {
        let mut config = NpmrcConfig::default();
        config.scoped_registries.push((
            "@org".into(),
            "https://private.example/repository/npm".into(),
        ));
        let url = download_url(
            &package("https://registry.npmjs.org/@org/pkg/-/pkg-1.tgz"),
            Some(&config),
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://private.example/repository/npm/@org/pkg/-/pkg-1.tgz"
        );
        let unrelated = "https://registry.npmjs.org.evil.test/pkg.tgz";
        assert_eq!(
            download_url(&package(unrelated), Some(&config))
                .unwrap()
                .as_str(),
            unrelated
        );
    }
    #[test]
    fn redirect_loops_and_embedded_credentials_fail() {
        let (url, seen, thread) = server(vec![response(302, "Location: /loop\r\n"); 11]);
        assert!(download(&client().unwrap(), &package(&url), None)
            .unwrap_err()
            .contains("limit"));
        thread.join().unwrap();
        assert_eq!(seen.lock().unwrap().len(), 11);
        assert!(redirect_url(
            &Url::parse("https://registry.example:444/private/pkg").unwrap(),
            "http://registry.example:444/private/pkg"
        )
        .is_err());
        for url in ["https://user:password@example.test/pkg", "file:///tmp/pkg"] {
            assert!(download_url(&package(url), None).is_err());
        }
    }
    #[test]
    fn valid_archive_with_error_status_never_publishes_cache() {
        use base64::Engine;
        use sha2::{Digest, Sha512};
        let mut tar = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(2);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, "package/package.json", &b"{}"[..])
            .unwrap();
        let raw = tar.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&raw).unwrap();
        let archive = gz.finish().unwrap();
        for status in [200, 503] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let mut pkg = package(&format!(
                "http://{}/pkg.tgz",
                listener.local_addr().unwrap()
            ));
            pkg.integrity = format!(
                "sha512-{}",
                base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&archive))
            );
            let body = archive.clone();
            let thread = std::thread::spawn(move || {
                for _ in 0..if status == 200 { 1 } else { 3 } {
                    let (mut socket, _) = listener.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        let mut byte = [0];
                        if socket.read(&mut byte).unwrap() == 0 {
                            break;
                        }
                        request.push(byte[0]);
                    }
                    write!(
                        socket,
                        "HTTP/1.1 {} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        status,
                        body.len()
                    )
                    .unwrap();
                    socket.write_all(&body).unwrap();
                }
            });
            let cache = tempfile::tempdir().unwrap();
            let result = crate::fetch::fetch_packages(&[pkg], cache.path(), None);
            thread.join().unwrap();
            if status == 200 {
                assert_eq!(result.unwrap().packages_fetched, 1);
            } else {
                assert!(result.err().unwrap().contains("503"));
                // Directory scaffolding is allowed, verified/extracted publication is not.
                fn has_marker(path: &std::path::Path) -> bool {
                    std::fs::read_dir(path).unwrap().any(|entry| {
                        let path = entry.unwrap().path();
                        if path.is_dir() {
                            has_marker(&path)
                        } else {
                            path.to_string_lossy().contains("verified")
                                || path.ends_with(".better_extracted")
                        }
                    })
                }
                assert!(!has_marker(cache.path()));
            }
        }
    }
}
