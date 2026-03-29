use super::SearchPackage;

/// Search npm registry using the official search API.
/// GET https://registry.npmjs.org/-/v1/search?text={query}&size={limit}
pub fn search(query: &str, limit: usize) -> Result<Vec<SearchPackage>, String> {
    let url = format!(
        "https://registry.npmjs.org/-/v1/search?text={}&size={}",
        urlencoded(query),
        limit
    );

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("failed to create HTTP client: {}", e))?;

    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("npm search request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("npm search returned status {}", resp.status()));
    }

    let body = resp
        .text()
        .map_err(|e| format!("failed to read npm search response: {}", e))?;

    parse_npm_search_response(&body)
}

fn parse_npm_search_response(json: &str) -> Result<Vec<SearchPackage>, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("invalid JSON from npm: {}", e))?;

    let objects = value
        .get("objects")
        .and_then(|v| v.as_array())
        .ok_or("missing 'objects' array in npm response")?;

    let mut results = Vec::new();

    for obj in objects {
        let pkg = match obj.get("package") {
            Some(p) => p,
            None => continue,
        };

        let name = pkg
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let version = pkg
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0")
            .to_string();
        let description = pkg
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let last_publish = pkg
            .get("date")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let license = pkg
            .get("license")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let keywords: Vec<String> = pkg
            .get("keywords")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let maintainers = pkg
            .get("maintainers")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
            .unwrap_or(0);

        // Check for types (look for @types/ or "types" field in package)
        let has_types = name.starts_with("@types/")
            || pkg.get("types").is_some()
            || pkg.get("typings").is_some();

        // Extract score from search result
        let search_score = obj
            .get("score")
            .and_then(|s| s.get("final"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        // Weekly downloads from flags (if available)
        let downloads_weekly = obj
            .get("downloads")
            .and_then(|v| v.get("weekly"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        results.push(SearchPackage {
            name,
            ecosystem: "npm".to_string(),
            version,
            description,
            score: search_score,
            downloads_weekly,
            last_publish,
            license,
            maintainers,
            has_types,
            keywords,
        });
    }

    Ok(results)
}

fn urlencoded(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ' ' => "+".to_string(),
            '&' => "%26".to_string(),
            '=' => "%3D".to_string(),
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            '+' => "%2B".to_string(),
            _ if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' || c == '/' || c == '@' => {
                c.to_string()
            }
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}
