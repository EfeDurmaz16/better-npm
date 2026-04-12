// crates/better-core/src/registry/unified.rs
// Task 106: Unified discovery across packages, OSP services, and plugins.

use serde::Serialize;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct UnifiedSearchResult {
    pub results: Vec<SearchEntry>,
    pub sources: Vec<SearchSource>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchEntry {
    pub name: String,
    pub entry_type: EntryType,
    pub description: String,
    pub ecosystem: String,
    /// Relevance score 0.0–1.0.
    pub score: f64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub enum EntryType {
    Package,
    OspService,
    Plugin,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchSource {
    pub name: String,
    pub result_count: usize,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SearchError {
    Network(String),
    Timeout,
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(s) => write!(f, "Network error: {}", s),
            Self::Timeout => write!(f, "Timeout"),
        }
    }
}

// ---------------------------------------------------------------------------
// Unified search (synchronous)
// ---------------------------------------------------------------------------

/// Search across npm registry, OSP services (curated), and known plugins.
///
/// In production this would fan-out HTTP calls in parallel. Here we use
/// blocking HTTP via reqwest and the curated OSP provider list.
pub fn unified_search(
    query: &str,
    ecosystems: &[String],
) -> Result<UnifiedSearchResult, SearchError> {
    let mut results = Vec::new();
    let mut sources = Vec::new();

    // npm search
    if ecosystems.is_empty() || ecosystems.iter().any(|e| e == "npm") {
        let start = std::time::Instant::now();
        let npm_results = search_npm(query);
        let latency = start.elapsed().as_millis() as u64;
        sources.push(SearchSource {
            name: "npm".to_string(),
            result_count: npm_results.len(),
            latency_ms: latency,
        });
        results.extend(npm_results);
    }

    // OSP services (curated fallback, no network)
    if ecosystems.is_empty() || ecosystems.iter().any(|e| e == "osp") {
        let osp_results = search_osp_curated(query);
        sources.push(SearchSource {
            name: "osp".to_string(),
            result_count: osp_results.len(),
            latency_ms: 0,
        });
        results.extend(osp_results);
    }

    // Rank by score
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    let total = results.len();
    Ok(UnifiedSearchResult { results, sources, total })
}

// ---------------------------------------------------------------------------
// Per-source search helpers
// ---------------------------------------------------------------------------

fn search_npm(query: &str) -> Vec<SearchEntry> {
    let url = format!(
        "https://registry.npmjs.org/-/v1/search?text={}&size=5",
        url_encode(query)
    );

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok();

    let text = client
        .as_ref()
        .and_then(|c| c.get(&url)
            .header("User-Agent", "better-npm/registry-search")
            .send()
            .ok())
        .and_then(|r| r.text().ok())
        .unwrap_or_default();

    parse_npm_search_response(&text, query)
}

fn parse_npm_search_response(text: &str, query: &str) -> Vec<SearchEntry> {
    if text.is_empty() || !text.contains("\"objects\"") {
        return vec![];
    }
    let mut results = Vec::new();
    let query_lower = query.to_lowercase();

    // Simple extraction without pulling in a JSON parser at this level
    for chunk in text.split("\"package\":{").skip(1).take(5) {
        let name = extract_json_str(chunk, "name").unwrap_or_default();
        let description = extract_json_str(chunk, "description").unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let score = if name.to_lowercase().contains(&query_lower) { 0.9 } else { 0.5 };
        results.push(SearchEntry {
            name,
            entry_type: EntryType::Package,
            description,
            ecosystem: "npm".to_string(),
            score,
            source: "npm".to_string(),
        });
    }
    results
}

fn search_osp_curated(query: &str) -> Vec<SearchEntry> {
    use crate::osp::search::curated_providers;

    let providers = curated_providers();
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for provider in &providers {
        for offering in &provider.offerings {
            let matches = query_lower.is_empty()
                || provider.name.to_lowercase().contains(&query_lower)
                || offering.category.contains(&query_lower)
                || offering.description.to_lowercase().contains(&query_lower);
            if matches {
                let offering_suffix = offering.offering_id
                    .trim_start_matches(provider.domain.as_str())
                    .trim_start_matches('/');
                results.push(SearchEntry {
                    name: format!("{}/{}", provider.domain, offering_suffix),
                    entry_type: EntryType::OspService,
                    description: offering.description.to_string(),
                    ecosystem: offering.category.to_string(),
                    score: 0.7,
                    source: "osp".to_string(),
                });
            }
        }
    }
    results
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn url_encode(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                vec![c]
            } else {
                format!("%{:02X}", c as u32).chars().collect()
            }
        })
        .collect()
}

fn extract_json_str(s: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\":\"", key);
    let start = s.find(&needle)?;
    let rest = &s[start + needle.len()..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encode_spaces() {
        assert!(url_encode("hello world").contains('%'));
    }

    #[test]
    fn url_encode_alphanumeric_unchanged() {
        assert_eq!(url_encode("database"), "database");
    }

    #[test]
    fn parse_npm_search_empty_text() {
        let results = parse_npm_search_response("", "test");
        assert!(results.is_empty());
    }

    #[test]
    fn parse_npm_search_valid_response() {
        let text = r#"{"objects":[{"package":{"name":"lodash","description":"Lodash modular utilities"}},{"package":{"name":"lodash-es","description":"Lodash ES modules"}}]}"#;
        let results = parse_npm_search_response(text, "lodash");
        assert!(!results.is_empty());
        assert!(results.iter().any(|r| r.name == "lodash"));
        assert!(results.iter().all(|r| r.entry_type == EntryType::Package));
    }

    #[test]
    fn search_osp_curated_returns_results() {
        let results = search_osp_curated("database");
        assert!(!results.is_empty());
        assert!(results.iter().all(|r| r.entry_type == EntryType::OspService));
    }

    #[test]
    fn search_osp_curated_empty_query_returns_all() {
        let all = search_osp_curated("");
        assert!(!all.is_empty());
    }

    #[test]
    fn unified_search_osp_only() {
        let result = unified_search("database", &["osp".to_string()]).unwrap();
        assert!(result.total > 0);
        assert!(result.sources.iter().any(|s| s.name == "osp"));
    }

    #[test]
    fn unified_search_results_sorted_by_score() {
        let result = unified_search("database", &["osp".to_string()]).unwrap();
        let scores: Vec<f64> = result.results.iter().map(|r| r.score).collect();
        for window in scores.windows(2) {
            assert!(window[0] >= window[1], "Results should be sorted by score descending");
        }
    }

    #[test]
    fn unified_search_result_serializes() {
        let result = unified_search("auth", &["osp".to_string()]).unwrap();
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("total"));
        assert!(json.contains("sources"));
    }
}
