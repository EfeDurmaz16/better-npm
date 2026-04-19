pub mod bulk;
pub mod cache;
pub mod docc;
pub mod generator;
pub mod generators;
pub mod js;
pub mod protocol;
pub mod python;
pub mod template;
pub mod yard;

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
        "swift" | "spm" => {
            use generators::ContextGenerator;
            let gen = docc::DoccGenerator;
            let pkg_root = project_root.join(".build").join("checkouts").join(package_name);
            let search_root = if pkg_root.exists() { pkg_root } else { project_root.to_path_buf() };
            let sources = gen.detect_docs(&search_root);
            let doc = gen.generate(&sources).map_err(|e| e.message)?;
            Ok(doc_to_package_context(doc))
        }
        "ruby" | "gem" | "bundler" => {
            use generators::ContextGenerator;
            let gen = yard::YardGenerator;
            // Look in vendor/bundle/ruby/*/gems/<name>-*
            let vendor_path = find_ruby_gem(project_root, package_name);
            let search_root = vendor_path.unwrap_or_else(|| project_root.to_path_buf());
            let sources = gen.detect_docs(&search_root);
            let doc = gen.generate(&sources).map_err(|e| e.message)?;
            Ok(doc_to_package_context(doc))
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

/// Locate a Ruby gem inside vendor/bundle/ruby/<version>/gems/<name>-<version>/.
fn find_ruby_gem(project_root: &std::path::Path, gem_name: &str) -> Option<std::path::PathBuf> {
    let vendor = project_root.join("vendor").join("bundle").join("ruby");
    if !vendor.exists() {
        return None;
    }
    // Iterate ruby version dirs
    if let Ok(ruby_vers) = std::fs::read_dir(&vendor) {
        for ruby_ver in ruby_vers.flatten() {
            let gems_dir = ruby_ver.path().join("gems");
            if let Ok(gems) = std::fs::read_dir(&gems_dir) {
                for gem in gems.flatten() {
                    let name = gem.file_name();
                    let dir_name = name.to_string_lossy();
                    if dir_name.starts_with(gem_name) {
                        return Some(gem.path());
                    }
                }
            }
        }
    }
    None
}

/// Convert a `ContextDocument` (from the generators module) into the legacy `PackageContext`.
fn doc_to_package_context(doc: generators::ContextDocument) -> PackageContext {
    PackageContext {
        name: doc.package,
        version: doc.version,
        ecosystem: doc.ecosystem,
        description: doc.summary,
        exports: doc.exports.into_iter().map(|e| ExportedSymbol {
            name: e.name,
            kind: SymbolKind::Function,
            signature: Some(e.signature),
            description: Some(e.description),
            params: e.parameters.into_iter().map(|p| ParamInfo {
                name: p.name,
                type_str: Some(p.type_),
                optional: p.optional,
                default: None,
                description: Some(p.description),
            }).collect(),
            return_type: None,
        }).collect(),
        quick_start: String::new(),
        patterns: vec![],
        gotchas: doc.gotchas,
        types_summary: None,
        dependencies: vec![],
        generated_at: String::new(),
        markdown: doc.markdown,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbol_kind_display_function() {
        assert_eq!(SymbolKind::Function.to_string(), "function");
    }

    #[test]
    fn symbol_kind_display_class() {
        assert_eq!(SymbolKind::Class.to_string(), "class");
    }

    #[test]
    fn symbol_kind_display_all_variants() {
        assert_eq!(SymbolKind::Constant.to_string(), "const");
        assert_eq!(SymbolKind::Type.to_string(), "type");
        assert_eq!(SymbolKind::Interface.to_string(), "interface");
        assert_eq!(SymbolKind::Enum.to_string(), "enum");
        assert_eq!(SymbolKind::Module.to_string(), "module");
        assert_eq!(SymbolKind::Variable.to_string(), "variable");
    }

    #[test]
    fn package_context_fields_stored() {
        let ctx = PackageContext {
            name: "lodash".into(),
            version: "4.17.21".into(),
            ecosystem: "npm".into(),
            description: "Utility library".into(),
            exports: vec![],
            quick_start: "const _ = require('lodash');".into(),
            patterns: vec![],
            gotchas: vec!["side effects".into()],
            types_summary: None,
            dependencies: vec!["@types/lodash".into()],
            generated_at: "2026-01-01".into(),
            markdown: "# lodash".into(),
        };
        assert_eq!(ctx.name, "lodash");
        assert_eq!(ctx.version, "4.17.21");
        assert_eq!(ctx.gotchas.len(), 1);
        assert_eq!(ctx.dependencies.len(), 1);
    }

    #[test]
    fn bulk_context_result_fields() {
        let r = BulkContextResult {
            generated: 5,
            cached: 10,
            failed: vec![],
            total_ms: 200,
            output_dir: "/tmp/better/context".into(),
        };
        assert_eq!(r.generated, 5);
        assert_eq!(r.cached, 10);
        assert!(r.failed.is_empty());
    }

    #[test]
    fn exported_symbol_kind_is_function() {
        let sym = ExportedSymbol {
            name: "map".into(),
            kind: SymbolKind::Function,
            signature: Some("(fn: Function) => Array".into()),
            description: Some("Maps over array".into()),
            params: vec![],
            return_type: None,
        };
        assert_eq!(sym.kind.to_string(), "function");
        assert!(sym.signature.is_some());
    }

    #[test]
    fn usage_pattern_fields_stored() {
        let p = UsagePattern {
            title: "Basic usage".into(),
            code: "import _ from 'lodash';".into(),
            language: "javascript".into(),
        };
        assert_eq!(p.title, "Basic usage");
        assert_eq!(p.language, "javascript");
    }

    #[test]
    fn param_info_optional_flag() {
        let param = ParamInfo {
            name: "options".into(),
            type_str: Some("Object".into()),
            optional: true,
            default: Some("{}".into()),
            description: None,
        };
        assert!(param.optional);
        assert_eq!(param.default.as_deref(), Some("{}"));
    }
}
