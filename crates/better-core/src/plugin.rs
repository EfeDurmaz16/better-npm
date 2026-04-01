use std::path::{Path, PathBuf};

use crate::engine::{PackageEngine, LockGraph, FetchResult, Vulnerability, OutdatedPackage, EngineError, EngineErrorKind};

/// Plugin manifest format (~/.better/plugins/<name>/plugin.json)
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub description: String,
    /// Entrypoint binary for subprocess-mode plugins
    pub bin: String,
    /// File patterns this plugin handles
    pub manifest_files: Vec<String>,
    /// Detection patterns (file names that trigger this plugin)
    pub detect_files: Vec<String>,
    pub author: String,
    pub engine_api_version: u32,
}

/// A subprocess-based plugin engine.
/// The plugin binary speaks JSON over stdin/stdout.
pub struct SubprocessPluginEngine {
    pub manifest: PluginManifest,
    pub bin_path: PathBuf,
}

impl PackageEngine for SubprocessPluginEngine {
    fn name(&self) -> &str { &self.manifest.name }

    fn manifest_files(&self) -> &[&str] { &[] }

    fn detect(&self, project_root: &Path) -> bool {
        self.manifest.detect_files.iter().any(|f| project_root.join(f).exists())
    }

    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError> {
        self.call_plugin("resolve", project_root, &serde_json::json!({}))
            .and_then(|v| {
                let packages = v["packages"].as_array().unwrap_or(&vec![]).iter().map(|p| {
                    crate::engine::ResolvedNode {
                        name: p["name"].as_str().unwrap_or("").to_string(),
                        version: p["version"].as_str().unwrap_or("").to_string(),
                        integrity: p["integrity"].as_str().map(|s| s.to_string()),
                        resolved_url: p["url"].as_str().map(|s| s.to_string()),
                        ecosystem: crate::engine::Ecosystem::Npm, // plugins use custom
                    }
                }).collect();
                Ok(LockGraph { packages, edges: vec![] })
            })
    }

    fn fetch(&self, _graph: &LockGraph, _cache_dir: &Path) -> Result<Vec<FetchResult>, EngineError> {
        Ok(vec![])
    }

    fn materialize(&self, _packages: &[FetchResult], _target: &Path) -> Result<(), EngineError> {
        Ok(())
    }

    fn audit(&self, _graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError> {
        Ok(vec![])
    }

    fn outdated(&self, _project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError> {
        Ok(vec![])
    }
}

impl SubprocessPluginEngine {
    fn call_plugin(&self, command: &str, project_root: &Path, extra: &serde_json::Value) -> Result<serde_json::Value, EngineError> {
        use std::process::{Command, Stdio};
        use std::io::Write;

        let input = serde_json::json!({
            "command": command,
            "projectRoot": project_root.to_string_lossy(),
            "args": extra
        });

        let mut child = Command::new(&self.bin_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| EngineError { message: format!("Failed to spawn plugin: {}", e), kind: EngineErrorKind::FetchFailed })?;

        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(input.to_string().as_bytes());
        }

        let output = child.wait_with_output()
            .map_err(|e| EngineError { message: e.to_string(), kind: EngineErrorKind::FetchFailed })?;

        serde_json::from_slice(&output.stdout)
            .map_err(|e| EngineError { message: format!("Plugin returned invalid JSON: {}", e), kind: EngineErrorKind::FetchFailed })
    }
}

/// Plugin registry — manages installed plugins.
pub struct PluginRegistry {
    plugins_dir: PathBuf,
}

impl PluginRegistry {
    pub fn new() -> Self {
        let plugins_dir = std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/tmp"))
            .join(".better")
            .join("plugins");
        Self { plugins_dir }
    }

    /// Load all installed plugins from ~/.better/plugins/
    pub fn load_all(&self) -> Vec<Box<dyn PackageEngine>> {
        let mut engines: Vec<Box<dyn PackageEngine>> = Vec::new();
        if !self.plugins_dir.exists() { return engines; }

        if let Ok(entries) = std::fs::read_dir(&self.plugins_dir) {
            for entry in entries.flatten() {
                let manifest_path = entry.path().join("plugin.json");
                if !manifest_path.exists() { continue; }
                if let Ok(content) = std::fs::read_to_string(&manifest_path) {
                    if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
                        let bin_path = entry.path().join(&manifest.bin);
                        if bin_path.exists() {
                            engines.push(Box::new(SubprocessPluginEngine { manifest, bin_path }));
                        }
                    }
                }
            }
        }
        engines
    }

    /// Install a plugin from a path or URL (currently: copy from local path).
    pub fn install(&self, plugin_dir: &Path) -> Result<String, String> {
        let manifest_path = plugin_dir.join("plugin.json");
        if !manifest_path.exists() {
            return Err("plugin.json not found in plugin directory".to_string());
        }
        let content = std::fs::read_to_string(&manifest_path)
            .map_err(|e| e.to_string())?;
        let manifest: PluginManifest = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid plugin.json: {}", e))?;

        let dest = self.plugins_dir.join(&manifest.name);
        std::fs::create_dir_all(&dest)
            .map_err(|e| e.to_string())?;

        // Copy plugin files
        for entry in std::fs::read_dir(plugin_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            std::fs::copy(entry.path(), dest.join(entry.file_name()))
                .map_err(|e| e.to_string())?;
        }

        Ok(manifest.name)
    }

    /// Remove a plugin.
    pub fn remove(&self, name: &str) -> Result<(), String> {
        let plugin_dir = self.plugins_dir.join(name);
        if !plugin_dir.exists() {
            return Err(format!("Plugin '{}' not installed", name));
        }
        std::fs::remove_dir_all(&plugin_dir)
            .map_err(|e| e.to_string())
    }

    /// List installed plugins.
    pub fn list(&self) -> Vec<PluginManifest> {
        let mut plugins = Vec::new();
        if !self.plugins_dir.exists() { return plugins; }
        if let Ok(entries) = std::fs::read_dir(&self.plugins_dir) {
            for entry in entries.flatten() {
                let manifest_path = entry.path().join("plugin.json");
                if let Ok(content) = std::fs::read_to_string(&manifest_path) {
                    if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
                        plugins.push(manifest);
                    }
                }
            }
        }
        plugins
    }
}

impl Default for PluginRegistry {
    fn default() -> Self { Self::new() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_new_does_not_panic() {
        let _r = PluginRegistry::new();
    }

    #[test]
    fn list_plugins_empty_dir_returns_empty() {
        let tmp = std::env::temp_dir().join("plugin-test-empty");
        let r = PluginRegistry { plugins_dir: tmp.clone() };
        assert!(r.list().is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_all_missing_dir_returns_empty() {
        let r = PluginRegistry { plugins_dir: std::path::PathBuf::from("/nonexistent-plugin-dir") };
        let engines = r.load_all();
        assert!(engines.is_empty());
    }
}
