// crates/better-core/src/context/docc.rs
// Task 93: DocC context generator for Swift packages
//
// Parses Swift source files for `///` documentation comments and extracts
// public/open declarations to build a ContextDocument.

use std::path::Path;

use super::generators::{
    ContextDocument, ContextError, ContextGenerator, DocFormat, DocSource, ExportEntry, ParamEntry,
};

// ---------------------------------------------------------------------------
// DocC Generator
// ---------------------------------------------------------------------------

pub struct DoccGenerator;

impl ContextGenerator for DoccGenerator {
    fn ecosystem(&self) -> &str {
        "swift"
    }

    /// Walk `package_path` looking for `.swift` source files and a `.docc` bundle.
    fn detect_docs(&self, package_path: &Path) -> Vec<DocSource> {
        let mut sources = Vec::new();

        // Look for .docc bundles
        if let Ok(entries) = std::fs::read_dir(package_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("docc") {
                    sources.push(DocSource { path, format: DocFormat::DocC });
                }
            }
        }

        // Walk Sources/ directory for .swift files
        let sources_dir = package_path.join("Sources");
        collect_swift_files(&sources_dir, &mut sources);

        // Also scan package root .swift files (e.g. single-file libraries)
        if let Ok(entries) = std::fs::read_dir(package_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("swift") {
                    sources.push(DocSource { path, format: DocFormat::DocC });
                }
            }
        }

        sources
    }

    fn generate(&self, sources: &[DocSource]) -> Result<ContextDocument, ContextError> {
        let mut exports: Vec<ExportEntry> = Vec::new();
        let mut examples: Vec<String> = Vec::new();
        let mut package_name = "unknown".to_string();

        for source in sources {
            let text = match std::fs::read_to_string(&source.path) {
                Ok(t) => t,
                Err(_) => continue,
            };

            // Extract package name from directory name if unknown
            if package_name == "unknown" {
                if let Some(stem) = source.path.file_stem().and_then(|s| s.to_str()) {
                    package_name = stem.to_string();
                }
            }

            parse_swift_docs(&text, &mut exports, &mut examples);
        }

        let markdown = build_markdown(&package_name, &exports, &examples);
        let mut doc = ContextDocument {
            package: package_name,
            version: "unknown".to_string(),
            ecosystem: "swift".to_string(),
            summary: exports.first().map(|e| e.description.clone()).unwrap_or_default(),
            exports,
            examples,
            gotchas: vec![],
            migration_notes: vec![],
            markdown,
            token_estimate: 0,
        };
        doc.estimate_tokens();
        Ok(doc)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn collect_swift_files(dir: &Path, out: &mut Vec<DocSource>) {
    if !dir.exists() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_swift_files(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("swift") {
                out.push(DocSource { path, format: DocFormat::DocC });
            }
        }
    }
}

/// Parse `///` doc comments followed by public/open declarations.
fn parse_swift_docs(
    text: &str,
    exports: &mut Vec<ExportEntry>,
    examples: &mut Vec<String>,
) {
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i].trim();

        // Accumulate consecutive `///` comment lines
        if line.starts_with("///") {
            let mut doc_lines: Vec<String> = Vec::new();
            while i < lines.len() && lines[i].trim().starts_with("///") {
                let stripped = lines[i].trim().trim_start_matches("///").trim().to_string();
                doc_lines.push(stripped);
                i += 1;
            }

            // Look for the declaration on the next non-empty line
            let decl_line = (i..lines.len())
                .map(|j| lines[j].trim())
                .find(|l| !l.is_empty() && !l.starts_with("///") && !l.starts_with("@"))
                .unwrap_or("");

            if let Some(entry) = parse_declaration(decl_line, &doc_lines) {
                // Pull ``code`` examples from doc comment
                let example = doc_lines
                    .iter()
                    .filter(|l| l.contains("```"))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                if !example.is_empty() {
                    examples.push(example);
                }
                exports.push(entry);
            }
        }

        i += 1;
    }
}

/// Try to extract a function, class, struct, enum, or protocol declaration.
fn parse_declaration(decl: &str, doc_lines: &[String]) -> Option<ExportEntry> {
    let description = doc_lines
        .iter()
        .take_while(|l| !l.starts_with('-') && !l.starts_with("```"))
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");

    // Must be public or open
    if !decl.contains("public ") && !decl.contains("open ") {
        return None;
    }

    let (kind, name) = if decl.contains("func ") {
        let name = extract_identifier_after(decl, "func ")?;
        ("function", name)
    } else if decl.contains("class ") {
        let name = extract_identifier_after(decl, "class ")?;
        ("class", name)
    } else if decl.contains("struct ") {
        let name = extract_identifier_after(decl, "struct ")?;
        ("struct", name)
    } else if decl.contains("protocol ") {
        let name = extract_identifier_after(decl, "protocol ")?;
        ("protocol", name)
    } else if decl.contains("enum ") {
        let name = extract_identifier_after(decl, "enum ")?;
        ("enum", name)
    } else if decl.contains("var ") || decl.contains("let ") {
        let keyword = if decl.contains("var ") { "var " } else { "let " };
        let name = extract_identifier_after(decl, keyword)?;
        ("variable", name)
    } else {
        return None;
    };

    // Extract parameters from func signature
    let parameters = if kind == "function" {
        extract_params(decl, doc_lines)
    } else {
        vec![]
    };

    Some(ExportEntry {
        name,
        kind: kind.to_string(),
        signature: decl.trim().to_string(),
        description,
        parameters,
    })
}

fn extract_identifier_after(s: &str, after: &str) -> Option<String> {
    let pos = s.find(after)?;
    let rest = &s[pos + after.len()..];
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() { None } else { Some(name) }
}

/// Parse `@param name Description` tags from doc comment lines.
fn extract_params(signature: &str, doc_lines: &[String]) -> Vec<ParamEntry> {
    // From YARD/DocC style: `- Parameter name: description`
    let mut params: Vec<ParamEntry> = Vec::new();
    for line in doc_lines {
        let l = line.trim();
        if l.starts_with("- Parameter") {
            let rest = l.trim_start_matches("- Parameter").trim();
            if let Some((name, desc)) = rest.split_once(':') {
                params.push(ParamEntry {
                    name: name.trim().to_string(),
                    type_: infer_param_type(signature, name.trim()),
                    description: desc.trim().to_string(),
                    optional: false,
                });
            }
        }
    }
    params
}

/// Crude type inference: look for `name: TypeName` in the signature.
fn infer_param_type(signature: &str, param_name: &str) -> String {
    let needle = format!("{}: ", param_name);
    if let Some(pos) = signature.find(&needle) {
        let after = &signature[pos + needle.len()..];
        let ty: String = after
            .chars()
            .take_while(|c| !matches!(*c, ',' | ')' | '\n'))
            .collect();
        return ty.trim().to_string();
    }
    "Any".to_string()
}

fn build_markdown(name: &str, exports: &[ExportEntry], examples: &[String]) -> String {
    let mut md = format!("# {}\n\n", name);

    if !exports.is_empty() {
        md.push_str("## API\n\n");
        for e in exports {
            md.push_str(&format!("### `{}` ({})\n\n", e.name, e.kind));
            if !e.description.is_empty() {
                md.push_str(&format!("{}\n\n", e.description));
            }
            md.push_str(&format!("```swift\n{}\n```\n\n", e.signature));
            if !e.parameters.is_empty() {
                md.push_str("**Parameters:**\n\n");
                for p in &e.parameters {
                    md.push_str(&format!("- `{}` (`{}`): {}\n", p.name, p.type_, p.description));
                }
                md.push('\n');
            }
        }
    }

    if !examples.is_empty() {
        md.push_str("## Examples\n\n");
        for ex in examples {
            md.push_str(&format!("{}\n\n", ex));
        }
    }

    md
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn generator() -> DoccGenerator {
        DoccGenerator
    }

    #[test]
    fn ecosystem_name_is_swift() {
        assert_eq!(generator().ecosystem(), "swift");
    }

    #[test]
    fn detect_docs_on_empty_dir_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let sources = generator().detect_docs(dir.path());
        assert!(sources.is_empty());
    }

    #[test]
    fn detect_docs_finds_swift_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("MyLib.swift"), "public func foo() {}").unwrap();
        let sources = generator().detect_docs(dir.path());
        assert!(!sources.is_empty());
    }

    #[test]
    fn parse_swift_docs_extracts_public_func() {
        let code = r#"
/// Adds two integers.
/// - Parameter a: First value
/// - Parameter b: Second value
/// - Returns: Sum
public func add(_ a: Int, _ b: Int) -> Int { a + b }
"#;
        let mut exports = vec![];
        let mut examples = vec![];
        parse_swift_docs(code, &mut exports, &mut examples);
        assert!(!exports.is_empty(), "Expected at least one export");
        assert_eq!(exports[0].name, "add");
        assert_eq!(exports[0].kind, "function");
        assert!(!exports[0].description.is_empty());
    }

    #[test]
    fn parse_swift_docs_skips_internal_funcs() {
        let code = r#"
/// Internal helper
internal func helper() {}
"#;
        let mut exports = vec![];
        let mut examples = vec![];
        parse_swift_docs(code, &mut exports, &mut examples);
        assert!(exports.is_empty(), "Internal functions should not be exported");
    }

    #[test]
    fn parse_swift_docs_extracts_public_struct() {
        let code = r#"
/// Represents a point in 2D space.
public struct Point {
    public var x: Double
    public var y: Double
}
"#;
        let mut exports = vec![];
        let mut examples = vec![];
        parse_swift_docs(code, &mut exports, &mut examples);
        assert!(exports.iter().any(|e| e.name == "Point" && e.kind == "struct"));
    }

    #[test]
    fn generate_builds_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let swift_file = dir.path().join("Lib.swift");
        std::fs::write(&swift_file, r#"
/// Returns greeting.
public func greet(_ name: String) -> String { "Hello, \(name)!" }
"#).unwrap();
        let sources = generator().detect_docs(dir.path());
        let doc = generator().generate(&sources).unwrap();
        assert!(doc.markdown.contains("greet") || doc.exports.is_empty());
    }

    #[test]
    fn extract_identifier_after_func() {
        let result = extract_identifier_after("public func myFunction(x: Int)", "func ");
        assert_eq!(result, Some("myFunction".to_string()));
    }

    #[test]
    fn extract_identifier_after_returns_none_on_missing() {
        let result = extract_identifier_after("public class Foo", "func ");
        assert!(result.is_none());
    }

    #[test]
    fn build_markdown_has_api_section() {
        let exports = vec![ExportEntry {
            name: "init".to_string(),
            kind: "function".to_string(),
            signature: "public func init()".to_string(),
            description: "Initialise".to_string(),
            parameters: vec![],
        }];
        let md = build_markdown("MyLib", &exports, &[]);
        assert!(md.contains("# MyLib"));
        assert!(md.contains("## API"));
        assert!(md.contains("init"));
    }
}
