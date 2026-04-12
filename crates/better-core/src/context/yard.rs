// crates/better-core/src/context/yard.rs
// Task 93: YARD context generator for Ruby gems
//
// Parses Ruby source files in `lib/` for YARD doc comments (`# @param`, `# @return`,
// `# @example` tags) and public `def`, `class`, `module` declarations.

use std::path::Path;

use super::generators::{
    ContextDocument, ContextError, ContextGenerator, DocFormat, DocSource, ExportEntry, ParamEntry,
};

// ---------------------------------------------------------------------------
// YARD Generator
// ---------------------------------------------------------------------------

pub struct YardGenerator;

impl ContextGenerator for YardGenerator {
    fn ecosystem(&self) -> &str {
        "ruby"
    }

    /// Walk `package_path/lib` for `.rb` files.
    fn detect_docs(&self, package_path: &Path) -> Vec<DocSource> {
        let mut sources = Vec::new();

        // Primary: lib/ directory
        collect_ruby_files(&package_path.join("lib"), &mut sources);

        // Fallback: root .rb files
        if sources.is_empty() {
            if let Ok(entries) = std::fs::read_dir(package_path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("rb") {
                        sources.push(DocSource { path, format: DocFormat::Yard });
                    }
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

            if package_name == "unknown" {
                if let Some(stem) = source.path.file_stem().and_then(|s| s.to_str()) {
                    package_name = stem.to_string();
                }
            }

            parse_yard_docs(&text, &mut exports, &mut examples);
        }

        let markdown = build_markdown(&package_name, &exports, &examples);
        let mut doc = ContextDocument {
            package: package_name,
            version: "unknown".to_string(),
            ecosystem: "ruby".to_string(),
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

fn collect_ruby_files(dir: &Path, out: &mut Vec<DocSource>) {
    if !dir.exists() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_ruby_files(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rb") {
                out.push(DocSource { path, format: DocFormat::Yard });
            }
        }
    }
}

/// Parse YARD-annotated Ruby source code.
/// YARD tags of interest: `@param`, `@return`, `@example`.
fn parse_yard_docs(
    text: &str,
    exports: &mut Vec<ExportEntry>,
    examples: &mut Vec<String>,
) {
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i].trim();

        // Accumulate YARD `#` comment block
        if line.starts_with('#') {
            let mut doc_lines: Vec<String> = Vec::new();
            while i < lines.len() && lines[i].trim().starts_with('#') {
                let stripped = lines[i].trim().trim_start_matches('#').trim().to_string();
                doc_lines.push(stripped);
                i += 1;
            }

            // Look for the declaration on the next non-empty line
            let decl_line = (i..lines.len())
                .map(|j| lines[j].trim())
                .find(|l| !l.is_empty() && !l.starts_with('#'))
                .unwrap_or("");

            // Collect @example blocks
            let mut in_example = false;
            let mut example_buf: Vec<String> = Vec::new();
            for dl in &doc_lines {
                if dl.starts_with("@example") {
                    in_example = true;
                    example_buf.push(dl.clone());
                } else if in_example {
                    if dl.starts_with('@') {
                        in_example = false;
                        if !example_buf.is_empty() {
                            examples.push(example_buf.join("\n"));
                            example_buf.clear();
                        }
                    } else {
                        example_buf.push(dl.clone());
                    }
                }
            }
            if !example_buf.is_empty() {
                examples.push(example_buf.join("\n"));
            }

            if let Some(entry) = parse_ruby_declaration(decl_line, &doc_lines) {
                exports.push(entry);
            }
        }

        i += 1;
    }
}

fn parse_ruby_declaration(decl: &str, doc_lines: &[String]) -> Option<ExportEntry> {
    let description: String = doc_lines
        .iter()
        .take_while(|l| !l.starts_with('@'))
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");

    let (kind, name) = if decl.starts_with("def ") {
        let rest = decl.trim_start_matches("def ").trim();
        let name: String = rest.chars().take_while(|c| !matches!(*c, '(' | ' ' | '\n')).collect();
        if name.is_empty() { return None; }
        ("method", name)
    } else if decl.starts_with("class ") {
        let rest = decl.trim_start_matches("class ").trim();
        let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == ':').collect();
        if name.is_empty() { return None; }
        ("class", name)
    } else if decl.starts_with("module ") {
        let rest = decl.trim_start_matches("module ").trim();
        let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == ':').collect();
        if name.is_empty() { return None; }
        ("module", name)
    } else if decl.starts_with("attr_accessor ") || decl.starts_with("attr_reader ") {
        let rest = decl.split(':').nth(1).unwrap_or("").trim();
        let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if name.is_empty() { return None; }
        ("attribute", name)
    } else {
        return None;
    };

    let parameters = extract_yard_params(doc_lines);

    Some(ExportEntry {
        name,
        kind: kind.to_string(),
        signature: decl.trim().to_string(),
        description,
        parameters,
    })
}

/// Extract `@param [Type] name Description` tags.
fn extract_yard_params(doc_lines: &[String]) -> Vec<ParamEntry> {
    let mut params = Vec::new();
    for line in doc_lines {
        let l = line.trim();
        if !l.starts_with("@param") {
            continue;
        }
        // Format: @param [Type] name Description
        let rest = l.trim_start_matches("@param").trim();
        let (type_str, rest2) = if rest.starts_with('[') {
            if let Some(end) = rest.find(']') {
                let ty = rest[1..end].to_string();
                let r = rest[end + 1..].trim();
                (ty, r)
            } else {
                ("Object".to_string(), rest)
            }
        } else {
            ("Object".to_string(), rest)
        };
        let name: String = rest2.chars().take_while(|c| !c.is_whitespace()).collect();
        let desc = rest2[name.len()..].trim().to_string();
        if !name.is_empty() {
            params.push(ParamEntry {
                name,
                type_: type_str,
                description: desc,
                optional: false,
            });
        }
    }
    params
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
            md.push_str(&format!("```ruby\n{}\n```\n\n", e.signature));
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

    fn generator() -> YardGenerator {
        YardGenerator
    }

    #[test]
    fn ecosystem_name_is_ruby() {
        assert_eq!(generator().ecosystem(), "ruby");
    }

    #[test]
    fn detect_docs_empty_dir_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let sources = generator().detect_docs(dir.path());
        assert!(sources.is_empty());
    }

    #[test]
    fn detect_docs_finds_rb_files_in_lib() {
        let dir = tempfile::tempdir().unwrap();
        let lib = dir.path().join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("mylib.rb"), "def hello; end").unwrap();
        let sources = generator().detect_docs(dir.path());
        assert!(!sources.is_empty());
    }

    #[test]
    fn parse_yard_docs_extracts_def() {
        let code = r#"
# Greet a user.
# @param [String] name The user's name
# @return [String] greeting message
def greet(name)
  "Hello, #{name}!"
end
"#;
        let mut exports = vec![];
        let mut examples = vec![];
        parse_yard_docs(code, &mut exports, &mut examples);
        assert!(!exports.is_empty(), "Expected at least one export");
        let greet = exports.iter().find(|e| e.name == "greet");
        assert!(greet.is_some(), "Expected 'greet' export");
        assert_eq!(greet.unwrap().kind, "method");
    }

    #[test]
    fn parse_yard_docs_extracts_class() {
        let code = r#"
# Represents a user account.
class User
  attr_accessor :name
end
"#;
        let mut exports = vec![];
        let mut examples = vec![];
        parse_yard_docs(code, &mut exports, &mut examples);
        assert!(exports.iter().any(|e| e.name == "User" && e.kind == "class"));
    }

    #[test]
    fn parse_yard_docs_extracts_module() {
        let code = r#"
# Utility helpers.
module Utils
end
"#;
        let mut exports = vec![];
        let mut examples = vec![];
        parse_yard_docs(code, &mut exports, &mut examples);
        assert!(exports.iter().any(|e| e.name == "Utils" && e.kind == "module"));
    }

    #[test]
    fn parse_yard_params_extracted() {
        let code = r#"
# Add two numbers.
# @param [Integer] a First number
# @param [Integer] b Second number
# @return [Integer] sum
def add(a, b); a + b; end
"#;
        let mut exports = vec![];
        let mut examples = vec![];
        parse_yard_docs(code, &mut exports, &mut examples);
        let add = exports.iter().find(|e| e.name == "add").unwrap();
        assert_eq!(add.parameters.len(), 2);
        assert_eq!(add.parameters[0].name, "a");
        assert_eq!(add.parameters[0].type_, "Integer");
    }

    #[test]
    fn parse_yard_docs_extracts_example_block() {
        let code = r#"
# A method.
# @example Basic usage
#   greet("Alice") #=> "Hello, Alice!"
def greet(name); end
"#;
        let mut exports = vec![];
        let mut examples = vec![];
        parse_yard_docs(code, &mut exports, &mut examples);
        assert!(!examples.is_empty(), "Expected examples to be extracted");
    }

    #[test]
    fn generate_builds_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let lib = dir.path().join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("greeter.rb"), r#"
# Greet method
def greet(name)
  "Hello, #{name}"
end
"#).unwrap();
        let sources = generator().detect_docs(dir.path());
        let doc = generator().generate(&sources).unwrap();
        assert!(doc.ecosystem == "ruby");
        assert!(!doc.markdown.is_empty());
    }

    #[test]
    fn build_markdown_has_api_section() {
        let exports = vec![ExportEntry {
            name: "save".to_string(),
            kind: "method".to_string(),
            signature: "def save(path)".to_string(),
            description: "Save the file".to_string(),
            parameters: vec![],
        }];
        let md = build_markdown("MyGem", &exports, &[]);
        assert!(md.contains("# MyGem"));
        assert!(md.contains("## API"));
        assert!(md.contains("save"));
    }
}
