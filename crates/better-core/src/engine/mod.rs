pub mod audit;
pub mod cargo;
pub mod cocoapods;
pub mod dotnet;
pub mod go;
pub mod npm;
pub mod php;
pub mod python;
pub mod ruby;
pub mod swift;

pub use audit::{cross_ecosystem_audit, CrossSeverity, UnifiedAuditReport, UnifiedVulnerability};

use std::fmt;
use std::path::Path;

/// Core trait that every package manager engine must implement.
///
/// This is the abstraction boundary that makes `better` a universal
/// package manager: npm today, Python / Cargo / Go / etc. tomorrow.
pub trait PackageEngine: Send + Sync {
    /// Engine name (e.g. "npm", "python", "cargo")
    fn name(&self) -> &str;

    /// File patterns this engine recognizes (e.g. ["package.json"])
    fn manifest_files(&self) -> &[&str];

    /// Check if this engine should handle the given project
    fn detect(&self, project_root: &Path) -> bool;

    /// Resolve dependencies from manifest + lockfile
    fn resolve(&self, project_root: &Path) -> Result<LockGraph, EngineError>;

    /// Fetch packages to cache
    fn fetch(&self, graph: &LockGraph, cache_dir: &Path) -> Result<Vec<FetchResult>, EngineError>;

    /// Materialize packages into project directory
    fn materialize(&self, packages: &[FetchResult], target: &Path) -> Result<(), EngineError>;

    /// Audit for vulnerabilities
    fn audit(&self, graph: &LockGraph) -> Result<Vec<Vulnerability>, EngineError>;

    /// Check for outdated packages
    fn outdated(&self, project_root: &Path) -> Result<Vec<OutdatedPackage>, EngineError>;

    /// Run a command in the engine's managed environment (e.g. venv for Python).
    /// Returns the process exit code.
    /// Default: exec the command directly without special environment setup.
    fn run(&self, command: &str, args: &[String], project_root: &Path) -> Result<i32, EngineError> {
        let status = std::process::Command::new(command)
            .args(args)
            .current_dir(project_root)
            .status()
            .map_err(|e| EngineError {
                kind: EngineErrorKind::FetchFailed,
                message: format!("failed to run '{}': {}", command, e),
            })?;
        Ok(status.code().unwrap_or(1))
    }
}

// ---------------------------------------------------------------------------
// Engine-agnostic types
// ---------------------------------------------------------------------------

/// Engine-agnostic dependency graph.
pub struct LockGraph {
    pub packages: Vec<ResolvedNode>,
    /// Dependency edges: (from_idx, to_idx) into `packages`.
    pub edges: Vec<(usize, usize)>,
}

/// A single resolved package in the lock graph.
pub struct ResolvedNode {
    pub name: String,
    pub version: String,
    pub integrity: Option<String>,
    pub resolved_url: Option<String>,
    pub ecosystem: Ecosystem,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Ecosystem {
    Npm,
    Python,
    Cargo,
    Go,
    Swift,
    CocoaPods,
    Ruby,
    Php,
    DotNet,
}

impl fmt::Display for Ecosystem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Npm => write!(f, "npm"),
            Self::Python => write!(f, "python"),
            Self::Cargo => write!(f, "cargo"),
            Self::Go => write!(f, "go"),
            Self::Swift => write!(f, "swift"),
            Self::CocoaPods => write!(f, "cocoapods"),
            Self::Ruby => write!(f, "ruby"),
            Self::Php => write!(f, "php"),
            Self::DotNet => write!(f, "dotnet"),
        }
    }
}

/// Result of fetching a single package (engine-agnostic).
pub struct FetchResult {
    pub name: String,
    pub version: String,
    pub cached: bool,
    pub bytes_downloaded: u64,
}

/// A vulnerability found during audit.
pub struct Vulnerability {
    pub id: String,
    pub summary: String,
    pub severity: String,
    pub package: String,
    pub version: String,
    pub fixed_in: Option<String>,
}

/// A package with a newer version available.
pub struct OutdatedPackage {
    pub name: String,
    pub current: String,
    pub latest: String,
    pub update_type: String,
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

pub struct EngineError {
    pub message: String,
    pub kind: EngineErrorKind,
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl fmt::Debug for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EngineError({:?}, {:?})", self.kind, self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineErrorKind {
    ManifestNotFound,
    LockfileNotFound,
    ResolutionFailed,
    FetchFailed,
    NetworkError,
    IntegrityMismatch,
}

impl fmt::Display for EngineErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ManifestNotFound => write!(f, "manifest not found"),
            Self::LockfileNotFound => write!(f, "lockfile not found"),
            Self::ResolutionFailed => write!(f, "resolution failed"),
            Self::FetchFailed => write!(f, "fetch failed"),
            Self::NetworkError => write!(f, "network error"),
            Self::IntegrityMismatch => write!(f, "integrity mismatch"),
        }
    }
}

// ---------------------------------------------------------------------------
// Engine registry
// ---------------------------------------------------------------------------

/// Registry of all available engines.
pub struct EngineRegistry {
    engines: Vec<Box<dyn PackageEngine>>,
}

impl EngineRegistry {
    pub fn new() -> Self {
        let mut registry = Self { engines: Vec::new() };
        registry.register(Box::new(npm::NpmEngine));
        registry.register(Box::new(python::PythonEngine::new()));
        registry.register(Box::new(cargo::CargoEngine));
        registry.register(Box::new(go::GoEngine));
        registry.register(Box::new(dotnet::DotNetEngine));
        registry.register(Box::new(ruby::RubyEngine));
        registry.register(Box::new(php::PhpEngine));
        registry.register(Box::new(swift::SwiftEngine));
        registry.register(Box::new(cocoapods::CocoaPodsEngine));
        registry
    }

    /// Detect which engines match the given project root.
    pub fn detect(&self, project_root: &Path) -> Vec<&dyn PackageEngine> {
        self.engines
            .iter()
            .filter(|e| e.detect(project_root))
            .map(|e| e.as_ref())
            .collect()
    }

    /// Get a specific engine by name.
    pub fn get(&self, name: &str) -> Option<&dyn PackageEngine> {
        self.engines
            .iter()
            .find(|e| e.name() == name)
            .map(|e| e.as_ref())
    }

    /// List all registered engine names.
    pub fn list(&self) -> Vec<&str> {
        self.engines.iter().map(|e| e.name()).collect()
    }

    fn register(&mut self, engine: Box<dyn PackageEngine>) {
        self.engines.push(engine);
    }
}

impl Default for EngineRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Cross-ecosystem workspace detection
// ---------------------------------------------------------------------------

/// A workspace member with its detected ecosystem and manifest path.
pub struct WorkspaceMember {
    pub path: std::path::PathBuf,
    pub ecosystem: String,
    pub manifest: Option<std::path::PathBuf>,
}

/// Find the first existing manifest file for an engine in a directory.
fn find_manifest(dir: &Path, files: &[&str]) -> Option<std::path::PathBuf> {
    for f in files {
        let p = dir.join(f);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

impl EngineRegistry {
    /// Detect all ecosystems in a monorepo by scanning subdirectories.
    pub fn detect_workspace_ecosystems(&self, root: &Path) -> Vec<WorkspaceMember> {
        let mut members = Vec::new();

        // Check root first
        let root_engines = self.detect(root);
        if !root_engines.is_empty() {
            for engine in &root_engines {
                members.push(WorkspaceMember {
                    path: root.to_path_buf(),
                    ecosystem: engine.name().to_string(),
                    manifest: find_manifest(root, engine.manifest_files()),
                });
            }
        }

        // Scan one level deep for workspace members
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with('.') || name == "node_modules" || name == "target" || name == "vendor" {
                    continue;
                }
                let engines = self.detect(&path);
                for engine in &engines {
                    members.push(WorkspaceMember {
                        path: path.clone(),
                        ecosystem: engine.name().to_string(),
                        manifest: find_manifest(&path, engine.manifest_files()),
                    });
                }
            }
        }

        members
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_registry_lists_expected_engines() {
        let reg = EngineRegistry::new();
        let names = reg.list();
        assert!(names.contains(&"npm"));
        assert!(names.contains(&"cargo"));
        assert!(names.contains(&"go"));
        assert!(names.contains(&"python"));
    }

    #[test]
    fn engine_registry_get_npm() {
        let reg = EngineRegistry::new();
        let engine = reg.get("npm");
        assert!(engine.is_some());
        assert_eq!(engine.unwrap().name(), "npm");
    }

    #[test]
    fn engine_registry_get_unknown_returns_none() {
        let reg = EngineRegistry::new();
        assert!(reg.get("unknown-engine-xyz").is_none());
    }

    #[test]
    fn engine_registry_detect_empty_dir_no_engines() {
        let tmp = std::env::temp_dir().join("engine-reg-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        let reg = EngineRegistry::new();
        let detected = reg.detect(&tmp);
        assert!(detected.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ecosystem_display_all_variants() {
        assert_eq!(Ecosystem::Npm.to_string(), "npm");
        assert_eq!(Ecosystem::Python.to_string(), "python");
        assert_eq!(Ecosystem::Cargo.to_string(), "cargo");
        assert_eq!(Ecosystem::Go.to_string(), "go");
        assert_eq!(Ecosystem::Swift.to_string(), "swift");
        assert_eq!(Ecosystem::CocoaPods.to_string(), "cocoapods");
        assert_eq!(Ecosystem::Ruby.to_string(), "ruby");
        assert_eq!(Ecosystem::Php.to_string(), "php");
        assert_eq!(Ecosystem::DotNet.to_string(), "dotnet");
    }

    #[test]
    fn engine_error_kind_display_all_variants() {
        assert!(EngineErrorKind::ManifestNotFound.to_string().contains("manifest"));
        assert!(EngineErrorKind::LockfileNotFound.to_string().contains("lockfile"));
        assert!(EngineErrorKind::ResolutionFailed.to_string().contains("resolution"));
        assert!(EngineErrorKind::FetchFailed.to_string().contains("fetch"));
        assert!(EngineErrorKind::NetworkError.to_string().contains("network"));
        assert!(EngineErrorKind::IntegrityMismatch.to_string().contains("integrity"));
    }

    #[test]
    fn engine_error_display_includes_kind_and_message() {
        let err = EngineError {
            message: "file not found".into(),
            kind: EngineErrorKind::LockfileNotFound,
        };
        let s = err.to_string();
        assert!(s.contains("lockfile"));
        assert!(s.contains("file not found"));
    }

    #[test]
    fn engine_registry_detects_npm_from_package_json() {
        let tmp = std::env::temp_dir().join("engine-reg-test-npm");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), r#"{"name":"app"}"#).unwrap();
        let reg = EngineRegistry::new();
        let detected = reg.detect(&tmp);
        let names: Vec<&str> = detected.iter().map(|e| e.name()).collect();
        assert!(names.contains(&"npm"), "expected npm in {:?}", names);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
