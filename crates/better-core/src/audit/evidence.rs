//! Shared raw security evidence. Policy decisions are deliberately not cached.
use super::cache::OsvCache;
use rayon::prelude::*;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
const REGISTRY_TTL: u64 = 300;
const MISSING_TTL: u64 = 30;
const OSV_URL: &str = "https://api.osv.dev/v1/querybatch";

static CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
static POOL: OnceLock<Result<rayon::ThreadPool, String>> = OnceLock::new();

static CACHE_HITS: AtomicU64 = AtomicU64::new(0);
static HTTP_REQUESTS: AtomicU64 = AtomicU64::new(0);
static RESPONSE_BYTES: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct EvidenceMetrics {
    pub cache_hits: u64,
    pub http_requests: u64,
    pub response_bytes: u64,
}

/// Process counters; concurrent callers can take before/after snapshots for an
/// aggregate phase, not attribute overlapping requests to an individual caller.
pub fn metrics() -> EvidenceMetrics {
    EvidenceMetrics {
        cache_hits: CACHE_HITS.load(Ordering::Relaxed),
        http_requests: HTTP_REQUESTS.load(Ordering::Relaxed),
        response_bytes: RESPONSE_BYTES.load(Ordering::Relaxed),
    }
}

fn client() -> Result<&'static reqwest::blocking::Client, String> {
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .use_rustls_tls()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| format!("security HTTP client: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// One resident pool shared by firewall and provenance, never one per package.
/// Indexed collection preserves the caller's report order.
pub(crate) fn map_bounded<T: Sync, R: Send>(
    items: &[T],
    f: impl Fn(&T) -> R + Sync + Send,
) -> Vec<R> {
    match POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(8)
            .thread_name(|i| format!("better-evidence-{i}"))
            .build()
            .map_err(|e| e.to_string())
    }) {
        Ok(pool) => pool.install(|| items.par_iter().map(f).collect()),
        Err(_) => items.iter().map(f).collect(),
    }
}

fn read_response(response: reqwest::blocking::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|len| len > MAX_RESPONSE_BYTES)
    {
        return Err("security evidence response exceeds limit".into());
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("security evidence read: {e}"))?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("security evidence response exceeds limit".into());
    }
    RESPONSE_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
    String::from_utf8(bytes).map_err(|e| format!("security evidence UTF-8: {e}"))
}

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
pub(crate) enum RegistryEvidence {
    Present(String),
    Missing,
}

pub(crate) fn registry_url(base: &str, segments: &[&str]) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| format!("security registry URL: {e}"))?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("security registry must be HTTPS (or loopback HTTP) without credentials, query or fragment".into());
    }
    url.path_segments_mut()
        .map_err(|_| "security registry cannot be a base URL")?
        .pop_if_empty()
        .extend(segments.iter().copied());
    Ok(url.into())
}

/// Generated scoped package segments contain an encoded slash. The generic
/// tarball auth selector rejects these ambiguous paths. For a validated npm name,
/// the registry base is an unambiguous authorization prefix for this endpoint.
pub(crate) fn registry_token<'a>(
    config: &'a crate::types::NpmrcConfig,
    base: &str,
    url: &str,
    name: &str,
) -> Option<&'a str> {
    crate::npmrc::find_auth_token(config, url).or_else(|| {
        let origin = reqwest::Url::parse(base).ok()?;
        let destination = reqwest::Url::parse(url).ok()?;
        let prefix = format!("{}/", origin.path().trim_end_matches('/'));
        if origin.origin() != destination.origin() || !destination.path().starts_with(&prefix) {
            return None;
        }
        let valid_component = |part: &str| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        };
        let valid = if let Some(scoped) = name.strip_prefix('@') {
            scoped
                .split_once('/')
                .is_some_and(|(scope, package)| valid_component(scope) && valid_component(package))
        } else {
            valid_component(name)
        };
        if valid {
            crate::npmrc::find_auth_token(config, base)
        } else {
            None
        }
    })
}

pub(crate) fn registry_get(url: &str, token: Option<&str>) -> Result<RegistryEvidence, String> {
    registry_get_with_cache(url, token, &OsvCache::new())
}

fn registry_get_with_cache(
    url: &str,
    token: Option<&str>,
    cache: &OsvCache,
) -> Result<RegistryEvidence, String> {
    // Source and representation are part of the full, hashed request identity.
    let auth_scope = token
        .map(super::cache::digest)
        .unwrap_or_else(|| "anonymous".into());
    let key = format!("registry-evidence-v1\nGET\napplication/json\n{url}\n{auth_scope}");
    let cached = || {
        cache
            .get(&key)
            .and_then(|raw| serde_json::from_str(&raw).ok())
    };
    if let Some(value) = cached() {
        CACHE_HITS.fetch_add(1, Ordering::Relaxed);
        return Ok(value);
    }
    // Cache failure must not make an online check unavailable. Without a lock,
    // duplicate requests may happen but no decision is skipped.
    let _lease = cache.lock(&key).ok();
    if let Some(value) = cached() {
        CACHE_HITS.fetch_add(1, Ordering::Relaxed);
        return Ok(value);
    }
    let mut request = client()?.get(url).header("Accept", "application/json");
    if let Some(token) = token {
        let mut header = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "invalid security registry authorization")?;
        header.set_sensitive(true);
        request = request.header(reqwest::header::AUTHORIZATION, header);
    }
    HTTP_REQUESTS.fetch_add(1, Ordering::Relaxed);
    let response = request
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .map_err(|e| {
            let _ = e;
            "security registry request failed".to_owned()
        })?;
    let (evidence, ttl) = if response.status() == reqwest::StatusCode::NOT_FOUND {
        (RegistryEvidence::Missing, MISSING_TTL)
    } else {
        let response = response
            .error_for_status()
            .map_err(|e| format!("security registry status: {e}"))?;
        // Redirect responses aren't success and aren't followed or cached.
        if !response.status().is_success() {
            return Err("unexpected security registry redirect".into());
        }
        let raw = read_response(response)?;
        let value: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("malformed registry evidence: {e}"))?;
        if !value.is_object() {
            return Err("registry evidence must be an object".into());
        }
        (RegistryEvidence::Present(raw), REGISTRY_TTL)
    };
    if let Ok(raw) = serde_json::to_string(&evidence) {
        let _ = cache.put_with_ttl(&key, &raw, ttl);
    }
    Ok(evidence)
}

fn canonical_packages(packages: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut canonical: Vec<_> = packages
        .iter()
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .collect();
    canonical.sort();
    canonical.dedup();
    canonical
}

fn batch_body(packages: &[(String, String)], ecosystem: &str) -> String {
    serde_json::json!({"queries": packages.iter().map(|(name, version)|
        serde_json::json!({"package": {"name": name, "ecosystem": ecosystem}, "version": version}))
        .collect::<Vec<_>>()})
    .to_string()
}

fn validated_rows(raw: &str, count: usize) -> Result<Vec<serde_json::Value>, String> {
    // Check typed field shapes too, so invalid vuln data cannot become a clean scan.
    let typed: super::OsvBatchResponse =
        serde_json::from_str(raw).map_err(|e| format!("malformed OSV evidence: {e}"))?;
    if typed.results.as_ref().map(Vec::len) != Some(count) {
        return Err("OSV response count does not match exact queries".into());
    }
    let mut value: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if value
        .get("results")
        .and_then(|v| v.as_array())
        .is_some_and(|rows| {
            rows.iter().any(|row| {
                row.get("next_page_token")
                    .is_some_and(|token| !token.is_null() && token.as_str() != Some(""))
            })
        })
    {
        return Err("OSV returned paginated evidence; complete results are required".into());
    }
    value
        .get_mut("results")
        .and_then(|r| r.as_array_mut())
        .map(std::mem::take)
        .ok_or_else(|| "OSV response results missing".into())
}

/// Canonical query and response order share one identity; return rows explicitly
/// mapped back to the caller's order, including repeated package instances.
pub(crate) fn query_osv(packages: &[(&str, &str)], ecosystem: &str) -> Result<String, String> {
    let canonical = canonical_packages(packages);
    let cache = OsvCache::new();
    let mut rows = Vec::with_capacity(canonical.len());
    for chunk in canonical.chunks(1000) {
        let body = batch_body(chunk, ecosystem);
        let key = format!("osv-querybatch-v2\n{OSV_URL}\n{body}");
        let cached = || {
            cache
                .get(&key)
                .and_then(|raw| validated_rows(&raw, chunk.len()).ok())
        };
        if let Some(values) = cached() {
            CACHE_HITS.fetch_add(1, Ordering::Relaxed);
            rows.extend(values);
            continue;
        }
        let _lease = cache.lock(&key).ok();
        if let Some(values) = cached() {
            CACHE_HITS.fetch_add(1, Ordering::Relaxed);
            rows.extend(values);
            continue;
        }
        HTTP_REQUESTS.fetch_add(1, Ordering::Relaxed);
        let response = client()?
            .post(OSV_URL)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .map_err(|e| format!("OSV request: {e}"))?
            .error_for_status()
            .map_err(|e| format!("OSV status: {e}"))?;
        if !response.status().is_success() {
            return Err("unexpected OSV redirect".into());
        }
        let raw = read_response(response)?;
        rows.extend(validated_rows(&raw, chunk.len())?);
        let _ = cache.put(&key, &raw);
    }
    map_rows(packages, &canonical, &rows)
}

fn map_rows(
    packages: &[(&str, &str)],
    canonical: &[(String, String)],
    rows: &[serde_json::Value],
) -> Result<String, String> {
    let mapped: Result<Vec<_>, String> = packages
        .iter()
        .map(|(name, version)| {
            let index = canonical
                .binary_search(&(name.to_string(), version.to_string()))
                .map_err(|_| "OSV identity missing from canonical query".to_owned())?;
            rows.get(index)
                .cloned()
                .ok_or_else(|| "OSV identity missing from response".into())
        })
        .collect();
    Ok(serde_json::json!({"results": mapped?}).to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn canonical_identity_includes_tail_ecosystem_and_exact_strings() {
        let prefix = "a".repeat(240);
        let a = canonical_packages(&[(&prefix, "1"), ("z", "1")]);
        let b = canonical_packages(&[("z", "1"), (&prefix, "1")]);
        assert_eq!(batch_body(&a, "npm"), batch_body(&b, "npm"));
        assert_ne!(batch_body(&a, "npm"), batch_body(&a, "PyPI"));
        assert_ne!(
            batch_body(&a, "npm"),
            batch_body(&canonical_packages(&[(&prefix, "1"), ("z", "2")]), "npm")
        );
    }

    #[test]
    fn malformed_or_incomplete_batches_are_errors() {
        for raw in [
            "{}",
            r#"{"results":[]}"#,
            r#"{"results":[{"vulns":"bad"}]}"#,
            "not json",
        ] {
            assert!(validated_rows(raw, 1).is_err());
        }
        assert!(validated_rows(r#"{"results":[{}]}"#, 1).is_ok());
    }

    #[test]
    fn bounded_pool_preserves_input_order() {
        assert_eq!(map_bounded(&[3, 1, 2], |n| n * 2), vec![6, 2, 4]);
    }
    #[test]
    fn response_rows_follow_exact_identity_after_reordering_and_duplicates() {
        let canonical = canonical_packages(&[("b", "2"), ("a", "1")]);
        let rows = vec![
            serde_json::json!({"vulns":[{"id":"A"}]}),
            serde_json::json!({"vulns":[{"id":"B"}]}),
        ];
        let result: serde_json::Value = serde_json::from_str(
            &map_rows(&[("b", "2"), ("a", "1"), ("b", "2")], &canonical, &rows).unwrap(),
        )
        .unwrap();
        assert_eq!(result["results"][0]["vulns"][0]["id"], "B");
        assert_eq!(result["results"][1]["vulns"][0]["id"], "A");
        assert_eq!(result["results"][2]["vulns"][0]["id"], "B");
    }

    // Local-only fixture: no package execution or external registry dependency.
    pub(crate) fn server(
        status: u16,
        body: &'static str,
        count: usize,
    ) -> (String, std::thread::JoinHandle<()>) {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/package", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            for _ in 0..count {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "fixture request timed out"
                            );
                            std::thread::sleep(std::time::Duration::from_millis(1));
                        }
                        Err(error) => panic!("fixture accept: {error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0; 1];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() <= 16 * 1024, "fixture headers too large");
                }
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (url, handle)
    }

    #[test]
    fn fresh_registry_evidence_is_singleflight_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let cache = OsvCache::with_dir(dir.path().to_owned());
        let (url, server) = server(200, r#"{"time":{"1.0.0":"2020-01-01"}}"#, 1);
        let result = map_bounded(&[1, 2, 3, 4, 5, 6, 7, 8], |_| {
            registry_get_with_cache(&url, None, &cache)
        });
        assert!(result
            .iter()
            .all(|r| matches!(r, Ok(RegistryEvidence::Present(_)))));
        server.join().unwrap();
        assert!(matches!(
            registry_get_with_cache(&url, None, &cache),
            Ok(RegistryEvidence::Present(_))
        ));
    }

    #[test]
    fn only_confirmed_missing_is_negatively_cached() {
        let dir = tempfile::tempdir().unwrap();
        let cache = OsvCache::with_dir(dir.path().to_owned());
        let (url, server) = server(404, "{}", 1);
        assert_eq!(
            registry_get_with_cache(&url, None, &cache).unwrap(),
            RegistryEvidence::Missing
        );
        server.join().unwrap();
        assert_eq!(
            registry_get_with_cache(&url, None, &cache).unwrap(),
            RegistryEvidence::Missing
        );
        for (status, body) in [(500, "{}"), (429, "{}"), (200, "not JSON")] {
            let (url, server) = self::server(status, body, 2);
            assert!(registry_get_with_cache(&url, None, &cache).is_err());
            assert!(registry_get_with_cache(&url, None, &cache).is_err());
            server.join().unwrap();
        }
    }

    #[test]
    fn registry_url_preserves_scope_and_rejects_unsafe_base() {
        assert_eq!(
            registry_url("https://registry.example/base/", &["@scope/pkg"]).unwrap(),
            "https://registry.example/base/@scope%2Fpkg"
        );
        assert!(registry_url("https://user:pass@registry.example/", &["pkg"]).is_err());
        assert!(registry_url("http://registry.example/", &["pkg"]).is_err());
        assert!(registry_url("https://registry.example/?token=x", &["pkg"]).is_err());
        assert!(registry_url("http://127.0.0.1:8080/", &["pkg"]).is_ok());
    }
    #[test]
    fn scoped_auth_uses_only_validated_registry_prefix() {
        let config = crate::types::NpmrcConfig {
            default_registry: "https://registry.example/private/".into(),
            scoped_registries: vec![],
            auth_tokens: vec![("registry.example/private/".into(), "fixture-token".into())],
        };
        let base = &config.default_registry;
        let scoped = registry_url(base, &["@scope/pkg"]).unwrap();
        assert_eq!(
            registry_token(&config, base, &scoped, "@scope/pkg"),
            Some("fixture-token")
        );
        let invalid = registry_url(base, &["@scope/../outside"]).unwrap();
        assert!(registry_token(&config, base, &invalid, "@scope/../outside").is_none());
        assert!(registry_token(
            &config,
            "https://other.example/",
            "https://other.example/@scope%2Fpkg",
            "@scope/pkg"
        )
        .is_none());
    }
}
