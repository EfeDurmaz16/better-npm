/// Schema version embedded in `better.context.json`.
pub const CONTEXT_SCHEMA_VERSION: &str = "1";

// ---------------------------------------------------------------------------
// Authored context detection
// ---------------------------------------------------------------------------

/// Check if a package ships its own hand-authored context file.
///
/// Returns `true` when the package root contains `.better-context.md` or
/// `better.context.json`.
pub fn has_authored_context(package_root: &std::path::Path) -> bool {
    package_root.join(".better-context.md").exists()
        || package_root.join("better.context.json").exists()
}

/// Load authored context from a package root, preferring the Markdown form.
///
/// Returns `None` when neither file is present.
pub fn read_authored_context(package_root: &std::path::Path) -> Option<AuthoredContext> {
    let md = package_root.join(".better-context.md");
    if md.exists() {
        let content = std::fs::read_to_string(&md).ok()?;
        return Some(AuthoredContext { format: ContextFormat::Markdown, content, path: md });
    }

    let json = package_root.join("better.context.json");
    if json.exists() {
        let content = std::fs::read_to_string(&json).ok()?;
        return Some(AuthoredContext { format: ContextFormat::Json, content, path: json });
    }

    None
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct AuthoredContext {
    pub format: ContextFormat,
    pub content: String,
    pub path: std::path::PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ContextFormat {
    Markdown,
    Json,
}

/// Typed representation of `better.context.json`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContextJson {
    pub schema: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub exports: Vec<ContextExport>,
    pub quick_start: String,
    #[serde(default)]
    pub patterns: Vec<ContextPattern>,
    #[serde(default)]
    pub gotchas: Vec<String>,
    #[serde(default)]
    pub migration: Option<Vec<MigrationNote>>,
    #[serde(default)]
    pub see_also: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContextExport {
    pub name: String,
    pub kind: String,
    pub signature: String,
    pub description: String,
    #[serde(default)]
    pub examples: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContextPattern {
    pub title: String,
    pub description: String,
    pub code: String,
    pub language: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MigrationNote {
    pub from_version: String,
    pub to_version: String,
    #[serde(default)]
    pub breaking_changes: Vec<String>,
    #[serde(default)]
    pub new_features: Vec<String>,
}

// ---------------------------------------------------------------------------
// Template generators (used by `better init --context-template`)
// ---------------------------------------------------------------------------

/// Generate a `.better-context.md` template for a new package.
pub fn generate_context_md_template(name: &str, ecosystem: &str) -> String {
    let lang = match ecosystem {
        "npm" => "typescript",
        "python" => "python",
        _ => "text",
    };

    format!(
        r#"# {name}

> Brief description of what this package does.

## Exports

### `mainFunction`

```{lang}
// function signature here
```

Description of what it does.

**Parameters:**
- `param1` (Type) — description
- `param2` (Type, optional) — description

**Returns:** Type — description

## Quick Start

```{lang}
// minimal working example
```

## Common Patterns

### Pattern Name

```{lang}
// code example
```

## Gotchas

- Known issue or common mistake #1
- Known issue or common mistake #2

## Migration

### From v1.x to v2.x

- Breaking change #1
- Breaking change #2
"#
    )
}

/// Generate a `better.context.json` template for a new package.
pub fn generate_context_json_template(name: &str) -> String {
    let template = ContextJson {
        schema: CONTEXT_SCHEMA_VERSION.to_string(),
        name: name.to_string(),
        version: "1.0.0".to_string(),
        description: "Brief description".to_string(),
        exports: vec![ContextExport {
            name: "mainFunction".to_string(),
            kind: "function".to_string(),
            signature: "function mainFunction(param: string): Result".to_string(),
            description: "What this function does".to_string(),
            examples: Some(vec!["mainFunction('hello')".to_string()]),
        }],
        quick_start: "// minimal example\nconst result = mainFunction('hello');".to_string(),
        patterns: vec![ContextPattern {
            title: "Basic usage".to_string(),
            description: "How to use mainFunction".to_string(),
            code: "const result = mainFunction('hello');\nconsole.log(result);".to_string(),
            language: "typescript".to_string(),
        }],
        gotchas: vec!["Gotcha #1 — description".to_string()],
        migration: None,
        see_also: None,
    };

    serde_json::to_string_pretty(&template).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Parsing authored context JSON
// ---------------------------------------------------------------------------

/// Parse a `better.context.json` file.
pub fn parse_context_json(content: &str) -> Result<ContextJson, String> {
    serde_json::from_str(content).map_err(|e| format!("invalid better.context.json: {}", e))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_authored_context_false_when_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!has_authored_context(tmp.path()));
    }

    #[test]
    fn has_authored_context_true_for_md() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".better-context.md"), "# pkg").unwrap();
        assert!(has_authored_context(tmp.path()));
    }

    #[test]
    fn has_authored_context_true_for_json() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("better.context.json"), "{}").unwrap();
        assert!(has_authored_context(tmp.path()));
    }

    #[test]
    fn read_authored_context_prefers_md() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".better-context.md"), "# pkg").unwrap();
        std::fs::write(tmp.path().join("better.context.json"), "{}").unwrap();
        let ctx = read_authored_context(tmp.path()).unwrap();
        assert_eq!(ctx.format, ContextFormat::Markdown);
    }

    #[test]
    fn read_authored_context_falls_back_to_json() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("better.context.json"), "{}").unwrap();
        let ctx = read_authored_context(tmp.path()).unwrap();
        assert_eq!(ctx.format, ContextFormat::Json);
    }

    #[test]
    fn generate_md_template_contains_name() {
        let tmpl = generate_context_md_template("my-pkg", "npm");
        assert!(tmpl.contains("my-pkg"));
        assert!(tmpl.contains("typescript"));
    }

    #[test]
    fn generate_json_template_is_valid_json() {
        let json = generate_context_json_template("my-pkg");
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["name"], "my-pkg");
    }

    #[test]
    fn parse_context_json_round_trips() {
        let json = generate_context_json_template("test-pkg");
        let parsed = parse_context_json(&json).unwrap();
        assert_eq!(parsed.name, "test-pkg");
        assert!(!parsed.exports.is_empty());
    }

    #[test]
    fn schema_version_constant() {
        assert_eq!(CONTEXT_SCHEMA_VERSION, "1");
    }
}
