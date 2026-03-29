pub mod generator;
pub mod template;
pub mod js;
pub mod python;
pub mod cache;

#[derive(Debug, Clone, serde::Serialize)]
pub struct PackageContext {
    pub name: String,
    pub version: String,
    pub ecosystem: String,
    pub description: String,
    pub exports: Vec<ExportedSymbol>,
    pub quick_start: String,
    pub patterns: Vec<UsagePattern>,
    pub gotchas: Vec<String>,
    pub types_summary: Option<String>,
    pub dependencies: Vec<String>,
    pub generated_at: String,
    pub markdown: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportedSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub signature: Option<String>,
    pub description: Option<String>,
    pub params: Vec<ParamInfo>,
    pub return_type: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum SymbolKind {
    Function,
    Class,
    Constant,
    Type,
    Interface,
    Enum,
    Module,
    Variable,
}

impl std::fmt::Display for SymbolKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Function => write!(f, "function"),
            Self::Class => write!(f, "class"),
            Self::Constant => write!(f, "const"),
            Self::Type => write!(f, "type"),
            Self::Interface => write!(f, "interface"),
            Self::Enum => write!(f, "enum"),
            Self::Module => write!(f, "module"),
            Self::Variable => write!(f, "variable"),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ParamInfo {
    pub name: String,
    pub type_str: Option<String>,
    pub optional: bool,
    pub default: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UsagePattern {
    pub title: String,
    pub code: String,
    pub language: String,
}

/// Generate context for a single package by locating it in the project.
pub fn generate_context(
    project_root: &std::path::Path,
    package_name: &str,
    ecosystem: Option<&str>,
) -> Result<PackageContext, String> {
    let eco = ecosystem.unwrap_or("npm");
    match eco {
        "npm" | "node" => {
            let pkg_root = project_root.join("node_modules").join(package_name);
            if !pkg_root.exists() {
                return Err(format!("package '{}' not found in node_modules", package_name));
            }
            let version = read_pkg_version(&pkg_root).unwrap_or_else(|| "0.0.0".to_string());
            js::extract_js_context(&pkg_root, package_name, &version)
        }
        "python" | "pip" => {
            let pkg_root = find_python_package(project_root, package_name)?;
            let version = python::read_python_version(&pkg_root)
                .unwrap_or_else(|| "0.0.0".to_string());
            python::extract_python_context(&pkg_root, package_name, &version)
        }
        _ => Err(format!("unsupported ecosystem: {}", eco)),
    }
}

/// Generate context for all installed packages.
pub fn generate_all_context(
    project_root: &std::path::Path,
    cache_root: &std::path::Path,
    force: bool,
) -> Result<BulkContextResult, String> {
    generator::generate_all(project_root, cache_root, force)
}

#[derive(Debug, serde::Serialize)]
pub struct BulkContextResult {
    pub generated: usize,
    pub cached: usize,
    pub failed: Vec<(String, String)>,
    pub total_ms: u64,
    pub output_dir: String,
}

fn read_pkg_version(pkg_root: &std::path::Path) -> Option<String> {
    let pkg_json = pkg_root.join("package.json");
    let content = std::fs::read_to_string(pkg_json).ok()?;
    super::extract_json_field(&content, "version")
}

fn find_python_package(
    project_root: &std::path::Path,
    package_name: &str,
) -> Result<std::path::PathBuf, String> {
    // Check common venv locations
    let candidates = [
        project_root.join(".venv/lib"),
        project_root.join("venv/lib"),
    ];
    let pkg_name_normalized = package_name.replace('-', "_");
    for lib_dir in &candidates {
        if !lib_dir.exists() {
            continue;
        }
        // Look for python3.X/site-packages/
        if let Ok(entries) = std::fs::read_dir(lib_dir) {
            for entry in entries.flatten() {
                let sp = entry.path().join("site-packages").join(&pkg_name_normalized);
                if sp.exists() {
                    return Ok(sp);
                }
            }
        }
    }
    Err(format!(
        "Python package '{}' not found in venv site-packages",
        package_name
    ))
}
