// crates/better-core/src/context/generators.rs
// Task 93: ContextGenerator trait — ecosystem-agnostic documentation extraction

use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

/// Implemented by each ecosystem-specific context extractor.
pub trait ContextGenerator {
    /// Short ecosystem name: "npm", "python", "swift", "ruby", etc.
    fn ecosystem(&self) -> &str;

    /// Find documentation sources for a package installed at `package_path`.
    fn detect_docs(&self, package_path: &Path) -> Vec<DocSource>;

    /// Extract a `ContextDocument` from the located sources.
    fn generate(&self, sources: &[DocSource]) -> Result<ContextDocument, ContextError>;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum DocFormat {
    TypeDoc,
    JsDoc,
    DocC,
    Yard,
    Sphinx,
    RustDoc,
    GoDoc,
    PhpDoc,
    XmlDoc,
    Readme,
}

#[derive(Debug, Clone)]
pub struct DocSource {
    pub path: PathBuf,
    pub format: DocFormat,
}

/// Structured documentation for a single package, ready to feed into an LLM.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextDocument {
    pub package: String,
    pub version: String,
    pub ecosystem: String,
    pub summary: String,
    pub exports: Vec<ExportEntry>,
    pub examples: Vec<String>,
    pub gotchas: Vec<String>,
    pub migration_notes: Vec<String>,
    pub markdown: String,
    /// Rough word / token estimate for prompt budgeting.
    pub token_estimate: usize,
}

impl ContextDocument {
    pub fn empty(package: &str, version: &str, ecosystem: &str) -> Self {
        Self {
            package: package.to_string(),
            version: version.to_string(),
            ecosystem: ecosystem.to_string(),
            summary: String::new(),
            exports: vec![],
            examples: vec![],
            gotchas: vec![],
            migration_notes: vec![],
            markdown: String::new(),
            token_estimate: 0,
        }
    }

    /// Estimate tokens as ~4 chars per token (rough approximation).
    pub fn estimate_tokens(&mut self) {
        self.token_estimate = self.markdown.len() / 4;
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportEntry {
    pub name: String,
    /// "function", "class", "struct", "protocol", "module", "enum", "method"
    pub kind: String,
    pub signature: String,
    pub description: String,
    pub parameters: Vec<ParamEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ParamEntry {
    pub name: String,
    pub type_: String,
    pub description: String,
    pub optional: bool,
}

#[derive(Debug)]
pub struct ContextError {
    pub message: String,
}

impl std::fmt::Display for ContextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<String> for ContextError {
    fn from(s: String) -> Self {
        Self { message: s }
    }
}

impl From<&str> for ContextError {
    fn from(s: &str) -> Self {
        Self { message: s.to_string() }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_document_empty_has_zero_tokens() {
        let doc = ContextDocument::empty("mylib", "1.0.0", "swift");
        assert_eq!(doc.token_estimate, 0);
        assert_eq!(doc.package, "mylib");
        assert_eq!(doc.ecosystem, "swift");
    }

    #[test]
    fn context_document_estimate_tokens() {
        let mut doc = ContextDocument::empty("mylib", "1.0.0", "swift");
        doc.markdown = "a".repeat(400);
        doc.estimate_tokens();
        assert_eq!(doc.token_estimate, 100);
    }

    #[test]
    fn export_entry_round_trips_json() {
        let entry = ExportEntry {
            name: "init".to_string(),
            kind: "function".to_string(),
            signature: "func init() -> Self".to_string(),
            description: "Initialise the instance".to_string(),
            parameters: vec![],
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("init"));
        assert!(json.contains("function"));
    }

    #[test]
    fn context_error_display() {
        let err = ContextError { message: "file not found".into() };
        assert_eq!(err.to_string(), "file not found");
    }

    #[test]
    fn context_error_from_string() {
        let err: ContextError = "parse failed".into();
        assert_eq!(err.message, "parse failed");
    }

    #[test]
    fn param_entry_serializes() {
        let p = ParamEntry {
            name: "limit".into(),
            type_: "u32".into(),
            description: "Max results".into(),
            optional: true,
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"optional\":true"));
        assert!(json.contains("\"name\":\"limit\""));
    }

    #[test]
    fn context_document_has_all_fields() {
        let doc = ContextDocument::empty("serde", "1.0.0", "rust");
        assert_eq!(doc.version, "1.0.0");
        assert!(doc.exports.is_empty());
        assert!(doc.examples.is_empty());
        assert!(doc.gotchas.is_empty());
        assert!(doc.migration_notes.is_empty());
        assert!(doc.markdown.is_empty());
    }

    #[test]
    fn context_document_token_estimate_rounds_down() {
        let mut doc = ContextDocument::empty("pkg", "0.1", "npm");
        doc.markdown = "x".repeat(7); // 7 / 4 = 1
        doc.estimate_tokens();
        assert_eq!(doc.token_estimate, 1);
    }
}
