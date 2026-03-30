pub mod cargo;
pub mod npm;
pub mod python;

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
        // registry.register(Box::new(go::GoEngine));
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
