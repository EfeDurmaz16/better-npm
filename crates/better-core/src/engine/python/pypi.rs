use super::version::Pep440Version;
use std::collections::HashMap;

const PYPI_BASE: &str = "https://pypi.org";

/// Package metadata from PyPI JSON API.
#[derive(Debug, Clone)]
pub struct PypiPackageInfo {
    pub name: String,
    pub versions: Vec<Pep440Version>,
    pub releases: HashMap<String, Vec<ReleaseFile>>,
}

/// A single release file (wheel or sdist) on PyPI.
#[derive(Debug, Clone)]
pub struct ReleaseFile {
    pub filename: String,
    pub url: String,
    pub size: u64,
    pub digests: FileDigests,
    pub requires_python: Option<String>,
    pub packagetype: PackageType,
    pub python_version: Option<String>,
    pub yanked: bool,
    pub yanked_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FileDigests {
    pub sha256: String,
    pub md5: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PackageType {
    BdistWheel,
    Sdist,
    Other(String),
}

/// Fetch package metadata from PyPI JSON API.
/// GET https://pypi.org/pypi/{name}/json
pub fn fetch_package_info(name: &str) -> Result<PypiPackageInfo, String> {
    let url = format!("{}/pypi/{}/json", PYPI_BASE, name);

    let client = reqwest::blocking::Client::builder()
        .user_agent("better-npm/0.1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("Failed to fetch {}: {}", url, e))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Package '{}' not found on PyPI", name));
    }

    if !response.status().is_success() {
        return Err(format!(
            "PyPI returned status {} for '{}'",
            response.status(),
            name
        ));
    }

    let body = response
        .text()
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    parse_pypi_json(&body, name)
}

/// Fetch specific version metadata from PyPI.
/// GET https://pypi.org/pypi/{name}/{version}/json
pub fn fetch_version_info(name: &str, version: &str) -> Result<PypiPackageInfo, String> {
    let url = format!("{}/pypi/{}/{}/json", PYPI_BASE, name, version);

    let client = reqwest::blocking::Client::builder()
        .user_agent("better-npm/0.1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("Failed to fetch {}: {}", url, e))?;

    if !response.status().is_success() {
        return Err(format!(
            "PyPI returned status {} for '{}@{}'",
            response.status(),
            name,
            version
        ));
    }

    let body = response
        .text()
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    parse_pypi_json(&body, name)
}

/// Batch fetch package info using rayon for parallelism.
pub fn fetch_packages_parallel(names: &[String]) -> Vec<Result<PypiPackageInfo, String>> {
    use rayon::prelude::*;
    names.par_iter().map(|name| fetch_package_info(name)).collect()
}

/// Parse the PyPI JSON API response.
fn parse_pypi_json(json_str: &str, name: &str) -> Result<PypiPackageInfo, String> {
    let json: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("JSON parse error: {}", e))?;

    let mut versions = Vec::new();
    let mut releases = HashMap::new();

    // Parse releases
    if let Some(releases_obj) = json.get("releases").and_then(|v| v.as_object()) {
        for (ver_str, files_val) in releases_obj {
            let version = match Pep440Version::parse(ver_str) {
                Ok(v) => v,
                Err(_) => continue, // Skip unparseable versions
            };

            let files = parse_release_files(files_val);
            if !files.is_empty() {
                versions.push(version);
                releases.insert(ver_str.clone(), files);
            }
        }
    }

    // Sort versions
    versions.sort();

    // Also try to get requires_dist from info for the latest version
    // (releases map may not have requires_dist per-file)

    Ok(PypiPackageInfo {
        name: json
            .get("info")
            .and_then(|i| i.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or(name)
            .to_string(),
        versions,
        releases,
    })
}

/// Parse release files array from PyPI JSON.
fn parse_release_files(val: &serde_json::Value) -> Vec<ReleaseFile> {
    let arr = match val.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };

    arr.iter()
        .filter_map(|f| {
            let filename = f.get("filename")?.as_str()?.to_string();
            let url = f.get("url")?.as_str()?.to_string();
            let size = f.get("size").and_then(|v| v.as_u64()).unwrap_or(0);

            let digests = f.get("digests").and_then(|d| d.as_object());
            let sha256 = digests
                .and_then(|d| d.get("sha256"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let md5 = digests
                .and_then(|d| d.get("md5"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let requires_python = f
                .get("requires_python")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let packagetype_str = f
                .get("packagetype")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let packagetype = match packagetype_str {
                "bdist_wheel" => PackageType::BdistWheel,
                "sdist" => PackageType::Sdist,
                other => PackageType::Other(other.to_string()),
            };

            let python_version = f
                .get("python_version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let yanked = f
                .get("yanked")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let yanked_reason = f
                .get("yanked_reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            Some(ReleaseFile {
                filename,
                url,
                size,
                digests: FileDigests { sha256, md5 },
                requires_python,
                packagetype,
                python_version,
                yanked,
                yanked_reason,
            })
        })
        .collect()
}

/// Get the requires_dist from a PyPI JSON response for a specific version.
pub fn get_requires_dist(name: &str, version: &str) -> Result<Vec<String>, String> {
    let url = format!("{}/pypi/{}/{}/json", PYPI_BASE, name, version);

    let client = reqwest::blocking::Client::builder()
        .user_agent("better-npm/0.1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("Failed to fetch {}: {}", url, e))?;

    if !response.status().is_success() {
        return Ok(Vec::new());
    }

    let body = response
        .text()
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("JSON parse error: {}", e))?;

    let requires_dist = json
        .get("info")
        .and_then(|i| i.get("requires_dist"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    Ok(requires_dist)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_pypi_json() {
        let json = r#"{
            "info": {
                "name": "flask",
                "version": "3.1.0"
            },
            "releases": {
                "3.0.0": [{
                    "filename": "flask-3.0.0-py3-none-any.whl",
                    "url": "https://files.pythonhosted.org/packages/flask-3.0.0-py3-none-any.whl",
                    "size": 101234,
                    "digests": {"sha256": "abc123", "md5": "def456"},
                    "requires_python": ">=3.8",
                    "packagetype": "bdist_wheel",
                    "python_version": "py3",
                    "yanked": false,
                    "yanked_reason": null
                }],
                "3.1.0": [{
                    "filename": "flask-3.1.0-py3-none-any.whl",
                    "url": "https://files.pythonhosted.org/packages/flask-3.1.0-py3-none-any.whl",
                    "size": 102345,
                    "digests": {"sha256": "xyz789", "md5": null},
                    "requires_python": ">=3.9",
                    "packagetype": "bdist_wheel",
                    "python_version": "py3",
                    "yanked": false,
                    "yanked_reason": null
                }]
            }
        }"#;

        let info = parse_pypi_json(json, "flask").unwrap();
        assert_eq!(info.name, "flask");
        assert_eq!(info.versions.len(), 2);
        assert_eq!(info.releases.len(), 2);

        let files_310 = &info.releases["3.1.0"];
        assert_eq!(files_310.len(), 1);
        assert_eq!(files_310[0].digests.sha256, "xyz789");
        assert_eq!(files_310[0].packagetype, PackageType::BdistWheel);
    }

    #[test]
    fn test_parse_release_files_yanked() {
        let json = serde_json::json!([{
            "filename": "pkg-1.0.0.tar.gz",
            "url": "https://example.com/pkg-1.0.0.tar.gz",
            "size": 5000,
            "digests": {"sha256": "aaa"},
            "packagetype": "sdist",
            "yanked": true,
            "yanked_reason": "security vulnerability"
        }]);

        let files = parse_release_files(&json);
        assert_eq!(files.len(), 1);
        assert!(files[0].yanked);
    }

    #[test]
    fn test_parse_pypi_json_empty_releases() {
        let json = r#"{"info": {"name": "mylib"}, "releases": {}}"#;
        let info = parse_pypi_json(json, "mylib").unwrap();
        assert_eq!(info.name, "mylib");
        assert!(info.versions.is_empty());
        assert!(info.releases.is_empty());
    }

    #[test]
    fn test_parse_pypi_json_invalid_json_returns_error() {
        let result = parse_pypi_json("not json at all", "pkg");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("JSON parse error"));
    }

    #[test]
    fn test_parse_release_files_empty_array() {
        let json = serde_json::json!([]);
        let files = parse_release_files(&json);
        assert!(files.is_empty());
    }

    #[test]
    fn test_package_type_other_variant() {
        let json = serde_json::json!([{
            "filename": "pkg-1.0.0.egg",
            "url": "https://example.com/pkg-1.0.0.egg",
            "size": 1234,
            "digests": {"sha256": "bbb"},
            "packagetype": "bdist_egg",
            "yanked": false
        }]);
        let files = parse_release_files(&json);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].packagetype, PackageType::Other("bdist_egg".to_string()));
    }

    #[test]
    fn test_parse_release_files_sdist_type() {
        let json = serde_json::json!([{
            "filename": "flask-3.0.0.tar.gz",
            "url": "https://example.com/flask-3.0.0.tar.gz",
            "size": 98765,
            "digests": {"sha256": "ccc", "md5": "ddd"},
            "requires_python": ">=3.8",
            "packagetype": "sdist",
            "python_version": "source",
            "yanked": false
        }]);
        let files = parse_release_files(&json);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].packagetype, PackageType::Sdist);
        assert_eq!(files[0].digests.md5, Some("ddd".to_string()));
        assert_eq!(files[0].requires_python, Some(">=3.8".to_string()));
    }

    #[test]
    fn test_parse_pypi_json_name_from_info_field() {
        let json = r#"{
            "info": {"name": "Flask"},
            "releases": {
                "2.3.0": [{
                    "filename": "Flask-2.3.0-py3-none-any.whl",
                    "url": "https://example.com/Flask-2.3.0.whl",
                    "size": 99000,
                    "digests": {"sha256": "zzz"},
                    "packagetype": "bdist_wheel",
                    "yanked": false
                }]
            }
        }"#;
        let info = parse_pypi_json(json, "flask").unwrap();
        // Name comes from info.name field, not the passed argument
        assert_eq!(info.name, "Flask");
        assert_eq!(info.versions.len(), 1);
    }
}
