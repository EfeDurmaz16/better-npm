use super::*;
use std::path::Path;

/// Extract context from a Python package
pub fn extract_python_context(
    package_root: &Path,
    name: &str,
    version: &str,
) -> Result<PackageContext, String> {
    let mut exports = Vec::new();
    let mut patterns = Vec::new();
    let mut gotchas = Vec::new();
    let mut description = String::new();

    // 1. Parse __init__.py for exported symbols
    let init_py = package_root.join("__init__.py");
    if init_py.exists() {
        if let Ok(init_exports) = parse_python_init(&init_py) {
            exports.extend(init_exports);
        }
    }

    // 2. Parse .pyi stub files if available
    let init_pyi = package_root.join("__init__.pyi");
    if init_pyi.exists() {
        if let Ok(pyi_exports) = parse_pyi_stub(&init_pyi) {
            // Merge with existing exports
            for pyi_sym in pyi_exports {
                if !exports.iter().any(|e| e.name == pyi_sym.name) {
                    exports.push(pyi_sym);
                }
            }
        }
    }

    // 3. Look for README in package or parent dist-info
    let readme = find_python_readme(package_root);
    if let Some(readme_path) = readme {
        let (qs, ps, gs) = extract_python_readme(&readme_path);
        if !qs.is_empty() {
            patterns.push(UsagePattern {
                title: "Quick Start".to_string(),
                code: qs,
                language: "python".to_string(),
            });
        }
        patterns.extend(ps);
        gotchas.extend(gs);
    }

    // 4. Try to get description from METADATA
    if let Some(meta) = find_metadata(package_root, name) {
        if let Some(desc) = extract_metadata_field(&meta, "Summary") {
            description = desc;
        }
    }

    let types_summary = if !exports.is_empty() {
        Some(generate_python_types_summary(&exports))
    } else {
        None
    };

    let ctx = PackageContext {
        name: name.to_string(),
        version: version.to_string(),
        ecosystem: "python".to_string(),
        description,
        exports,
        quick_start: String::new(),
        patterns,
        gotchas,
        types_summary,
        dependencies: Vec::new(),
        generated_at: crate::chrono_now(),
        markdown: String::new(),
    };

    let markdown = template::render_context(&ctx);
    Ok(PackageContext { markdown, ..ctx })
}

pub fn read_python_version(package_root: &Path) -> Option<String> {
    let name = package_root.file_name()?.to_string_lossy().to_string();
    let parent = package_root.parent()?;
    // Look for dist-info directory
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let entry_name = entry.file_name().to_string_lossy().to_string();
            if entry_name.ends_with(".dist-info") && entry_name.starts_with(&name) {
                // Parse version from dirname: name-version.dist-info
                let without_suffix = entry_name.strip_suffix(".dist-info")?;
                let dash_pos = without_suffix.rfind('-')?;
                return Some(without_suffix[dash_pos + 1..].to_string());
            }
        }
    }
    None
}

fn parse_python_init(path: &Path) -> Result<Vec<ExportedSymbol>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;

    let mut symbols = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();

        // "def function_name(...)"
        if trimmed.starts_with("def ") {
            if let Some(sym) = parse_python_function(trimmed) {
                symbols.push(sym);
            }
        }
        // "class ClassName(...)"
        else if trimmed.starts_with("class ") {
            if let Some(sym) = parse_python_class(trimmed) {
                symbols.push(sym);
            }
        }
        // __all__ = ["a", "b", "c"] -- record as exports but we already capture defs
    }

    Ok(symbols)
}

fn parse_pyi_stub(path: &Path) -> Result<Vec<ExportedSymbol>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;

    let mut symbols = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("def ") {
            if let Some(sym) = parse_python_function(trimmed) {
                symbols.push(sym);
            }
        } else if trimmed.starts_with("class ") {
            if let Some(sym) = parse_python_class(trimmed) {
                symbols.push(sym);
            }
        }
    }

    Ok(symbols)
}

fn parse_python_function(line: &str) -> Option<ExportedSymbol> {
    let rest = line.strip_prefix("def ")?;
    let paren = rest.find('(')?;
    let name = rest[..paren].trim().to_string();
    if name.starts_with('_') && !name.starts_with("__") {
        return None; // Skip private functions
    }

    let return_type = if let Some(arrow) = line.find("->") {
        let ret = line[arrow + 2..].trim().trim_end_matches(':').trim();
        if ret.is_empty() { None } else { Some(ret.to_string()) }
    } else {
        None
    };

    Some(ExportedSymbol {
        name,
        kind: SymbolKind::Function,
        signature: Some(line.trim_end_matches(':').to_string()),
        description: None,
        params: Vec::new(),
        return_type,
    })
}

fn parse_python_class(line: &str) -> Option<ExportedSymbol> {
    let rest = line.strip_prefix("class ")?;
    let name_end = rest.find(|c: char| c == '(' || c == ':')?;
    let name = rest[..name_end].trim().to_string();
    if name.starts_with('_') {
        return None;
    }
    Some(ExportedSymbol {
        name,
        kind: SymbolKind::Class,
        signature: Some(line.trim_end_matches(':').to_string()),
        description: None,
        params: Vec::new(),
        return_type: None,
    })
}

fn find_python_readme(package_root: &Path) -> Option<std::path::PathBuf> {
    // Check in dist-info for DESCRIPTION or README
    let parent = package_root.parent()?;
    let name = package_root.file_name()?.to_string_lossy().to_string();
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let entry_name = entry.file_name().to_string_lossy().to_string();
            if entry_name.ends_with(".dist-info") && entry_name.starts_with(&name) {
                let desc = entry.path().join("DESCRIPTION");
                if desc.exists() {
                    return Some(desc);
                }
            }
        }
    }
    // Fallback: README in package root
    let candidates = ["README.md", "README.rst", "README.txt", "README"];
    for c in &candidates {
        let p = package_root.join(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn extract_python_readme(
    path: &Path,
) -> (String, Vec<UsagePattern>, Vec<String>) {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (String::new(), Vec::new(), Vec::new()),
    };

    let mut quick_start = String::new();
    let mut patterns = Vec::new();
    let mut gotchas = Vec::new();
    let mut in_code = false;
    let mut code_buf = String::new();
    let mut first_code = false;

    for line in content.lines() {
        if line.starts_with("```") || line.starts_with(".. code-block::") {
            if in_code {
                in_code = false;
                if !code_buf.trim().is_empty() && !first_code {
                    quick_start = code_buf.trim().to_string();
                    first_code = true;
                }
                code_buf.clear();
            } else {
                in_code = true;
            }
        } else if in_code {
            if !code_buf.is_empty() {
                code_buf.push('\n');
            }
            code_buf.push_str(line);
        } else {
            let lower = line.to_lowercase();
            if lower.contains("breaking") || lower.contains("deprecat") || lower.contains("warning") {
                let t = line.trim().to_string();
                if t.len() > 10 {
                    gotchas.push(t);
                }
            }
        }
    }

    patterns.truncate(5);
    gotchas.truncate(10);
    (quick_start, patterns, gotchas)
}

fn find_metadata(package_root: &Path, name: &str) -> Option<String> {
    let parent = package_root.parent()?;
    let pkg_name = name.replace('-', "_");
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let entry_name = entry.file_name().to_string_lossy().to_string();
            if entry_name.ends_with(".dist-info") && entry_name.starts_with(&pkg_name) {
                let metadata = entry.path().join("METADATA");
                if metadata.exists() {
                    return std::fs::read_to_string(metadata).ok();
                }
            }
        }
    }
    None
}

fn extract_metadata_field(metadata: &str, field: &str) -> Option<String> {
    let prefix = format!("{}: ", field);
    for line in metadata.lines() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            let val = rest.trim().to_string();
            if !val.is_empty() && val != "UNKNOWN" {
                return Some(val);
            }
        }
    }
    None
}

fn generate_python_types_summary(exports: &[ExportedSymbol]) -> String {
    let mut summary = String::new();
    for sym in exports {
        if let Some(ref sig) = sym.signature {
            summary.push_str("- `");
            summary.push_str(sig);
            summary.push_str("`\n");
        } else {
            summary.push_str(&format!("- {} `{}`\n", sym.kind, sym.name));
        }
    }
    summary
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_python_context_empty_dir_returns_ok() {
        let tmp = std::env::temp_dir().join("py-ctx-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = extract_python_context(&tmp, "mypackage", "1.0.0");
        assert!(result.is_ok());
        let ctx = result.unwrap();
        assert_eq!(ctx.name, "mypackage");
        assert_eq!(ctx.ecosystem, "python");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn extract_python_context_parses_init_py() {
        let tmp = std::env::temp_dir().join("py-ctx-test-init");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join("__init__.py"),
            "def hello(name: str) -> str:\n    return f'Hello {name}'\n\nclass MyClass:\n    pass\n",
        ).unwrap();
        let ctx = extract_python_context(&tmp, "mypkg", "1.0.0").unwrap();
        assert!(!ctx.exports.is_empty());
        let names: Vec<&str> = ctx.exports.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"hello"));
        assert!(names.contains(&"MyClass"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_python_version_returns_none_no_dist_info() {
        let tmp = std::env::temp_dir().join("py-ctx-test-ver");
        std::fs::create_dir_all(&tmp).unwrap();
        let pkg_dir = tmp.join("mypkg");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        let result = read_python_version(&pkg_dir);
        assert!(result.is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_python_version_finds_dist_info() {
        let tmp = std::env::temp_dir().join("py-ctx-test-ver-found");
        std::fs::create_dir_all(&tmp).unwrap();
        let pkg_dir = tmp.join("requests");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        // Create dist-info dir in parent
        let dist_info = tmp.join("requests-2.28.0.dist-info");
        std::fs::create_dir_all(&dist_info).unwrap();
        let version = read_python_version(&pkg_dir);
        assert_eq!(version, Some("2.28.0".to_string()));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
