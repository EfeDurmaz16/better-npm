use super::SearchPackage;

/// Search PyPI using the JSON API.
/// PyPI doesn't have a dedicated search API (XMLRPC was deprecated),
/// so we query individual package metadata by guessing likely names
/// and use the Simple API for discovery.
pub fn search(query: &str, limit: usize) -> Result<Vec<SearchPackage>, String> {
    // Strategy: query the PyPI JSON API for the exact package name first,
    // then try common variations. Also use the simple index for broader search.
    let mut results = Vec::new();

    // 1. Try exact match
    if let Ok(pkg) = fetch_pypi_package(query) {
        results.push(pkg);
    }

    // 2. Try hyphenated/underscored variations
    let variations = generate_variations(query);
    for variant in &variations {
        if results.len() >= limit {
            break;
        }
        if results.iter().any(|r: &SearchPackage| r.name == *variant) {
            continue;
        }
        if let Ok(pkg) = fetch_pypi_package(variant) {
            results.push(pkg);
        }
    }

    results.truncate(limit);
    Ok(results)
}

fn fetch_pypi_package(name: &str) -> Result<SearchPackage, String> {
    let url = format!("https://pypi.org/pypi/{}/json", name);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("failed to create HTTP client: {}", e))?;

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("PyPI request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("PyPI returned status {}", resp.status()));
    }

    let body = resp
        .text()
        .map_err(|e| format!("failed to read PyPI response: {}", e))?;

    parse_pypi_package(&body)
}

fn parse_pypi_package(json: &str) -> Result<SearchPackage, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("invalid JSON from PyPI: {}", e))?;

    let info = value
        .get("info")
        .ok_or("missing 'info' in PyPI response")?;

    let name = info
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version = info
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let description = info
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let license = info
        .get("license")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let keywords: Vec<String> = info
        .get("keywords")
        .and_then(|v| v.as_str())
        .map(|s| s.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect())
        .unwrap_or_default();

    let maintainers = info
        .get("maintainer")
        .and_then(|v| v.as_str())
        .map(|_| 1usize)
        .unwrap_or(1);

    let has_types = info
        .get("classifiers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter().any(|c| {
                c.as_str()
                    .map(|s| s.contains("Typing :: Typed"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    Ok(SearchPackage {
        name,
        ecosystem: "python".to_string(),
        version,
        description,
        score: 0.0,
        downloads_weekly: 0,
        last_publish: String::new(),
        license,
        maintainers,
        has_types,
        keywords,
    })
}

fn generate_variations(query: &str) -> Vec<String> {
    let mut variations = Vec::new();
    let words: Vec<&str> = query.split_whitespace().collect();

    if words.len() == 1 {
        let word = words[0];
        // Try with hyphens and underscores
        if word.contains('-') {
            variations.push(word.replace('-', "_"));
            variations.push(word.replace('-', ""));
        } else if word.contains('_') {
            variations.push(word.replace('_', "-"));
            variations.push(word.replace('_', ""));
        } else {
            // Try prefixed versions
            variations.push(format!("python-{}", word));
            variations.push(format!("py{}", word));
            variations.push(format!("py-{}", word));
        }
    } else {
        // Multi-word: try joining
        variations.push(words.join("-"));
        variations.push(words.join("_"));
        variations.push(words.join(""));
    }

    variations
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_variations_hyphenated_word() {
        let v = generate_variations("some-package");
        assert!(v.contains(&"some_package".to_string()));
        assert!(v.contains(&"somepackage".to_string()));
    }

    #[test]
    fn generate_variations_underscored_word() {
        let v = generate_variations("some_package");
        assert!(v.contains(&"some-package".to_string()));
    }

    #[test]
    fn generate_variations_plain_word_adds_prefixes() {
        let v = generate_variations("requests");
        assert!(v.contains(&"python-requests".to_string()));
        assert!(v.contains(&"pyrequests".to_string()));
    }

    #[test]
    fn generate_variations_multi_word() {
        let v = generate_variations("http client");
        assert!(v.contains(&"http-client".to_string()));
        assert!(v.contains(&"http_client".to_string()));
    }

    #[test]
    fn parse_pypi_package_valid_json() {
        let json = r#"{
            "info": {
                "name": "requests",
                "version": "2.28.0",
                "summary": "HTTP library",
                "license": "Apache-2.0",
                "keywords": "http,client",
                "maintainer": "kennethreitz",
                "classifiers": []
            }
        }"#;
        let pkg = parse_pypi_package(json).unwrap();
        assert_eq!(pkg.name, "requests");
        assert_eq!(pkg.version, "2.28.0");
        assert_eq!(pkg.ecosystem, "python");
        assert_eq!(pkg.license, Some("Apache-2.0".to_string()));
    }

    #[test]
    fn parse_pypi_package_missing_info_returns_err() {
        let result = parse_pypi_package(r#"{"urls": []}"#);
        assert!(result.is_err());
    }
}
