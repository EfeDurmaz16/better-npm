use super::manifest::{parse_dependency_string, PyDependency};
use std::path::Path;

/// A parsed entry from requirements.txt.
#[derive(Debug, Clone)]
pub enum RequirementsEntry {
    Package(PyDependency),
    Include(String),         // -r other-requirements.txt
    Constraint(String),      // -c constraints.txt
    EditableInstall(String), // -e ./local-package
    IndexUrl(String),        // -i / --index-url
    ExtraIndexUrl(String),   // --extra-index-url
    FindLinks(String),       // -f / --find-links
    Option(String),          // other pip options (ignored)
}

/// Parsed requirements.txt file.
pub struct RequirementsFile {
    pub entries: Vec<RequirementsEntry>,
    pub packages: Vec<PyDependency>,
}

impl RequirementsFile {
    /// Parse a requirements.txt file, recursively resolving `-r` includes.
    pub fn parse_file(path: &Path) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
        Self::parse_content(&content, base_dir, 0)
    }

    /// Parse requirements content with a recursion depth limit.
    fn parse_content(content: &str, base_dir: &Path, depth: u32) -> Result<Self, String> {
        if depth > 10 {
            return Err("Too many nested -r includes (max 10)".to_string());
        }

        let mut entries = Vec::new();
        let mut packages = Vec::new();

        // Handle line continuations
        let joined = join_continuation_lines(content);

        for line in joined.lines() {
            match Self::parse_line(line)? {
                Some(RequirementsEntry::Include(ref_path)) => {
                    let include_path = base_dir.join(&ref_path);
                    let included = Self::parse_file_recursive(&include_path, depth + 1)?;
                    entries.push(RequirementsEntry::Include(ref_path.clone()));
                    entries.extend(included.entries);
                    packages.extend(included.packages);
                }
                Some(RequirementsEntry::Package(dep)) => {
                    packages.push(dep.clone());
                    entries.push(RequirementsEntry::Package(dep));
                }
                Some(entry) => {
                    entries.push(entry);
                }
                None => {}
            }
        }

        Ok(RequirementsFile { entries, packages })
    }

    fn parse_file_recursive(path: &Path, depth: u32) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
        Self::parse_content(&content, base_dir, depth)
    }

    /// Parse a single line from requirements.txt.
    fn parse_line(line: &str) -> Result<Option<RequirementsEntry>, String> {
        let line = line.trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') {
            return Ok(None);
        }

        // Strip inline comments (but not inside URLs or quoted strings)
        let line = strip_inline_comment(line);
        let line = line.trim();
        if line.is_empty() {
            return Ok(None);
        }

        // Handle pip options
        if line.starts_with('-') {
            return parse_pip_option(line);
        }

        // Strip hash options: --hash=sha256:abc123
        let line = strip_hash_options(line);
        let line = line.trim();
        if line.is_empty() {
            return Ok(None);
        }

        // Parse as package dependency
        let dep = parse_dependency_string(line)?;
        Ok(Some(RequirementsEntry::Package(dep)))
    }
}

/// Join lines ending with `\` (line continuation).
fn join_continuation_lines(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut continuation = false;

    for line in content.lines() {
        if continuation {
            result.push_str(line.trim_start());
        } else {
            if !result.is_empty() {
                result.push('\n');
            }
            result.push_str(line);
        }

        continuation = line.trim_end().ends_with('\\');
        if continuation {
            // Remove the trailing backslash
            let trimmed_len = result.trim_end().len();
            result.truncate(trimmed_len);
            if result.ends_with('\\') {
                result.pop();
            }
        }
    }

    result
}

/// Strip inline comments (# not inside a URL or after a version spec).
fn strip_inline_comment(line: &str) -> &str {
    // Find # that's preceded by whitespace and not inside a URL
    let bytes = line.as_bytes();
    for i in 1..bytes.len() {
        if bytes[i] == b'#' && bytes[i - 1] == b' ' {
            return line[..i].trim();
        }
    }
    line
}

/// Strip --hash=algorithm:value options from the end of a line.
fn strip_hash_options(line: &str) -> &str {
    match line.find(" --hash=") {
        Some(pos) => &line[..pos],
        None => line,
    }
}

/// Parse a pip option line.
fn parse_pip_option(line: &str) -> Result<Option<RequirementsEntry>, String> {
    // -r / --requirement
    if line.starts_with("-r ") || line.starts_with("--requirement ") {
        let path = line
            .splitn(2, ' ')
            .nth(1)
            .unwrap_or("")
            .trim()
            .to_string();
        return Ok(Some(RequirementsEntry::Include(path)));
    }
    if let Some(path) = line.strip_prefix("-r") {
        return Ok(Some(RequirementsEntry::Include(path.trim().to_string())));
    }

    // -c / --constraint
    if line.starts_with("-c ") || line.starts_with("--constraint ") {
        let path = line
            .splitn(2, ' ')
            .nth(1)
            .unwrap_or("")
            .trim()
            .to_string();
        return Ok(Some(RequirementsEntry::Constraint(path)));
    }

    // -e / --editable
    if line.starts_with("-e ") || line.starts_with("--editable ") {
        let path = line
            .splitn(2, ' ')
            .nth(1)
            .unwrap_or("")
            .trim()
            .to_string();
        return Ok(Some(RequirementsEntry::EditableInstall(path)));
    }

    // -i / --index-url
    if line.starts_with("-i ") || line.starts_with("--index-url ") {
        let url = line
            .splitn(2, ' ')
            .nth(1)
            .unwrap_or("")
            .trim()
            .to_string();
        return Ok(Some(RequirementsEntry::IndexUrl(url)));
    }

    // --extra-index-url
    if line.starts_with("--extra-index-url ") {
        let url = line
            .splitn(2, ' ')
            .nth(1)
            .unwrap_or("")
            .trim()
            .to_string();
        return Ok(Some(RequirementsEntry::ExtraIndexUrl(url)));
    }

    // -f / --find-links
    if line.starts_with("-f ") || line.starts_with("--find-links ") {
        let url = line
            .splitn(2, ' ')
            .nth(1)
            .unwrap_or("")
            .trim()
            .to_string();
        return Ok(Some(RequirementsEntry::FindLinks(url)));
    }

    // Other options: ignore
    Ok(Some(RequirementsEntry::Option(line.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_requirements() {
        let content = r#"
# This is a comment
flask>=3.0
requests==2.31.0
click
"#;
        let base = Path::new(".");
        let req = RequirementsFile::parse_content(content, base, 0).unwrap();
        assert_eq!(req.packages.len(), 3);
        assert_eq!(req.packages[0].name, "flask");
        assert_eq!(req.packages[1].name, "requests");
        assert_eq!(req.packages[2].name, "click");
    }

    #[test]
    fn test_parse_with_extras_and_markers() {
        let content = r#"
requests[security]>=2.20.0 ; python_version >= "3.6"
pywin32>=300 ; sys_platform == "win32"
"#;
        let base = Path::new(".");
        let req = RequirementsFile::parse_content(content, base, 0).unwrap();
        assert_eq!(req.packages.len(), 2);
        assert_eq!(req.packages[0].extras, vec!["security"]);
        assert!(req.packages[1].markers.is_some());
    }

    #[test]
    fn test_parse_with_hashes() {
        let content = r#"
flask==3.0.0 --hash=sha256:abc123 --hash=sha256:def456
"#;
        let base = Path::new(".");
        let req = RequirementsFile::parse_content(content, base, 0).unwrap();
        assert_eq!(req.packages.len(), 1);
        assert_eq!(req.packages[0].name, "flask");
    }

    #[test]
    fn test_parse_pip_options() {
        let content = r#"
-i https://pypi.org/simple/
--extra-index-url https://private.pypi.org/simple/
-e ./my-local-package
flask>=3.0
"#;
        let base = Path::new(".");
        let req = RequirementsFile::parse_content(content, base, 0).unwrap();
        assert_eq!(req.packages.len(), 1);
        assert_eq!(
            req.entries
                .iter()
                .filter(|e| matches!(e, RequirementsEntry::IndexUrl(_)))
                .count(),
            1
        );
    }

    #[test]
    fn test_line_continuation() {
        let content = "flask>=3.0 \\\n  --hash=sha256:abc123";
        let joined = join_continuation_lines(content);
        assert!(joined.contains("flask>=3.0"));
    }

    #[test]
    fn test_inline_comment() {
        let result = strip_inline_comment("flask>=3.0 # web framework");
        assert_eq!(result, "flask>=3.0");
    }
}
