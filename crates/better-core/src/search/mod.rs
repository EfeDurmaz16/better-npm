pub mod npm;
pub mod pypi;
pub mod ranking;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    pub packages: Vec<SearchPackage>,
    pub query: String,
    pub total: usize,
    pub search_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchPackage {
    pub name: String,
    pub ecosystem: String,
    pub version: String,
    pub description: String,
    pub score: f64,
    pub downloads_weekly: u64,
    pub last_publish: String,
    pub license: Option<String>,
    pub maintainers: usize,
    pub has_types: bool,
    pub keywords: Vec<String>,
}

pub fn search(
    query: &str,
    ecosystem_filter: Option<&str>,
    limit: usize,
) -> Result<SearchResult, String> {
    let start = std::time::Instant::now();

    let (npm_results, pypi_results) = match ecosystem_filter {
        Some("npm") | Some("node") => (npm::search(query, limit)?, Vec::new()),
        Some("python") | Some("pip") | Some("pypi") => {
            (Vec::new(), pypi::search(query, limit)?)
        }
        _ => {
            // Search both in parallel using rayon
            let (npm, pypi) = rayon::join(
                || npm::search(query, limit),
                || pypi::search(query, limit),
            );
            (npm.unwrap_or_default(), pypi.unwrap_or_default())
        }
    };

    let mut packages: Vec<SearchPackage> = Vec::new();
    packages.extend(npm_results);
    packages.extend(pypi_results);

    ranking::rank(&mut packages, query);
    packages.truncate(limit);

    let total = packages.len();
    Ok(SearchResult {
        packages,
        query: query.to_string(),
        total,
        search_ms: start.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_result_serde() {
        let result = SearchResult {
            packages: vec![],
            query: "lodash".to_string(),
            total: 0,
            search_ms: 5,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"query\":\"lodash\""));
    }

    #[test]
    fn search_package_has_types_field() {
        let pkg = SearchPackage {
            name: "@types/node".to_string(),
            ecosystem: "npm".to_string(),
            version: "18.0.0".to_string(),
            description: "".to_string(),
            score: 0.9,
            downloads_weekly: 1000000,
            last_publish: "2024-01-01".to_string(),
            license: None,
            maintainers: 1,
            has_types: true,
            keywords: vec![],
        };
        let json = serde_json::to_string(&pkg).unwrap();
        assert!(json.contains("has_types"));
    }
}
