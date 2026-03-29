use super::specifier::VersionConstraint;
use std::collections::HashMap;
use std::path::Path;

/// Parsed pyproject.toml [project] table (PEP 621).
#[derive(Debug, Clone)]
pub struct PyProjectManifest {
    pub name: String,
    pub version: Option<String>,
    pub requires_python: Option<VersionConstraint>,
    pub dependencies: Vec<PyDependency>,
    pub optional_dependencies: HashMap<String, Vec<PyDependency>>,
    pub build_system: Option<BuildSystem>,
    pub scripts: HashMap<String, String>,
}

/// A single Python dependency specification.
#[derive(Debug, Clone)]
pub struct PyDependency {
    pub name: String,
    pub extras: Vec<String>,
    pub constraint: VersionConstraint,
    pub markers: Option<EnvironmentMarkers>,
}

#[derive(Debug, Clone)]
pub struct BuildSystem {
    pub requires: Vec<String>,
    pub build_backend: Option<String>,
}

/// PEP 508 environment markers.
#[derive(Debug, Clone)]
pub struct EnvironmentMarkers {
    pub raw: String,
}

impl EnvironmentMarkers {
    pub fn parse(input: &str) -> Result<Self, String> {
        Ok(EnvironmentMarkers {
            raw: input.trim().to_string(),
        })
    }

    /// Evaluate markers against the current platform.
    pub fn evaluate(&self, env: &MarkerEnvironment) -> bool {
        // Simple marker evaluation: supports common markers
        let raw = &self.raw;
        evaluate_marker_expr(raw, env)
    }
}

/// Current platform marker values.
#[derive(Debug, Clone)]
pub struct MarkerEnvironment {
    pub os_name: String,
    pub sys_platform: String,
    pub platform_machine: String,
    pub platform_system: String,
    pub python_version: String,
    pub python_full_version: String,
    pub implementation_name: String,
}

impl MarkerEnvironment {
    /// Detect from current system + specified Python version.
    pub fn detect(python_version: &str) -> Self {
        let (os_name, sys_platform, platform_system) = if cfg!(target_os = "macos") {
            ("posix", "darwin", "Darwin")
        } else if cfg!(target_os = "linux") {
            ("posix", "linux", "Linux")
        } else if cfg!(target_os = "windows") {
            ("nt", "win32", "Windows")
        } else {
            ("posix", "linux", "Linux")
        };

        let platform_machine = if cfg!(target_arch = "aarch64") || cfg!(target_arch = "arm") {
            "aarch64"
        } else if cfg!(target_arch = "x86_64") {
            "x86_64"
        } else {
            "x86_64"
        };

        // Extract major.minor from full version
        let py_short = python_version
            .split('.')
            .take(2)
            .collect::<Vec<_>>()
            .join(".");

        MarkerEnvironment {
            os_name: os_name.to_string(),
            sys_platform: sys_platform.to_string(),
            platform_machine: platform_machine.to_string(),
            platform_system: platform_system.to_string(),
            python_version: py_short,
            python_full_version: python_version.to_string(),
            implementation_name: "cpython".to_string(),
        }
    }

    /// Get a marker variable by name.
    fn get(&self, key: &str) -> Option<&str> {
        match key {
            "os_name" | "os.name" => Some(&self.os_name),
            "sys_platform" | "sys.platform" => Some(&self.sys_platform),
            "platform_machine" | "platform.machine" => Some(&self.platform_machine),
            "platform_system" | "platform.system" => Some(&self.platform_system),
            "python_version" | "platform.python_version" => Some(&self.python_version),
            "python_full_version" | "platform.python_full_version" => {
                Some(&self.python_full_version)
            }
            "implementation_name" | "platform.python_implementation" => {
                Some(&self.implementation_name)
            }
            _ => None,
        }
    }
}

impl PyProjectManifest {
    /// Parse a pyproject.toml file from disk.
    pub fn parse_file(path: &Path) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        Self::parse_toml(&content)
    }

    /// Parse pyproject.toml content string.
    pub fn parse_toml(content: &str) -> Result<Self, String> {
        let table: toml::Table =
            content.parse().map_err(|e| format!("TOML parse error: {}", e))?;

        let project = table
            .get("project")
            .and_then(|v| v.as_table())
            .ok_or_else(|| "Missing [project] table in pyproject.toml".to_string())?;

        let name = project
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing project.name".to_string())?
            .to_string();

        let version = project
            .get("version")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let requires_python = project
            .get("requires-python")
            .and_then(|v| v.as_str())
            .map(|s| VersionConstraint::parse(s))
            .transpose()?;

        let dependencies = project
            .get("dependencies")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(parse_dependency_string)
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();

        let mut optional_dependencies = HashMap::new();
        if let Some(opt_deps) = project
            .get("optional-dependencies")
            .and_then(|v| v.as_table())
        {
            for (group, deps_val) in opt_deps {
                if let Some(arr) = deps_val.as_array() {
                    let deps: Result<Vec<_>, _> = arr
                        .iter()
                        .filter_map(|v| v.as_str())
                        .map(parse_dependency_string)
                        .collect();
                    optional_dependencies.insert(group.clone(), deps?);
                }
            }
        }

        let build_system = table.get("build-system").and_then(|v| v.as_table()).map(|bs| {
            let requires = bs
                .get("requires")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str())
                        .map(|s| s.to_string())
                        .collect()
                })
                .unwrap_or_default();
            let build_backend = bs
                .get("build-backend")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            BuildSystem {
                requires,
                build_backend,
            }
        });

        let mut scripts = HashMap::new();
        if let Some(scripts_table) = project.get("scripts").and_then(|v| v.as_table()) {
            for (k, v) in scripts_table {
                if let Some(s) = v.as_str() {
                    scripts.insert(k.clone(), s.to_string());
                }
            }
        }

        Ok(PyProjectManifest {
            name,
            version,
            requires_python,
            dependencies,
            optional_dependencies,
            build_system,
            scripts,
        })
    }
}

/// Parse a PEP 508 dependency string, e.g.:
///   `requests[security]>=2.20.0 ; python_version >= "3.6"`
pub fn parse_dependency_string(input: &str) -> Result<PyDependency, String> {
    let input = input.trim();

    // Split on `;` for environment markers
    let (spec_part, markers) = match input.find(';') {
        Some(pos) => {
            let markers = EnvironmentMarkers::parse(&input[pos + 1..])?;
            (&input[..pos], Some(markers))
        }
        None => (input, None),
    };

    let spec_part = spec_part.trim();

    // Extract package name and extras
    let (name_part, constraint_str) = split_name_constraint(spec_part);

    // Extract extras from name_part: name[extra1,extra2]
    let (name, extras) = if let Some(bracket_start) = name_part.find('[') {
        let bracket_end = name_part.find(']').unwrap_or(name_part.len());
        let extras_str = &name_part[bracket_start + 1..bracket_end];
        let extras: Vec<String> = extras_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        (name_part[..bracket_start].trim().to_string(), extras)
    } else {
        (name_part.trim().to_string(), Vec::new())
    };

    // Normalize package name (PEP 503: lowercase, replace -, _, . with -)
    let name = normalize_package_name(&name);

    let constraint = VersionConstraint::parse(constraint_str)?;

    Ok(PyDependency {
        name,
        extras,
        constraint,
        markers,
    })
}

/// Split a dependency spec into name and constraint parts.
/// E.g. `requests>=2.20.0` -> (`requests`, `>=2.20.0`)
fn split_name_constraint(spec: &str) -> (&str, &str) {
    // Find the first version operator character
    for (i, c) in spec.char_indices() {
        if matches!(c, '>' | '<' | '=' | '!' | '~') {
            return (spec[..i].trim(), spec[i..].trim());
        }
    }
    // No constraint
    (spec.trim(), "")
}

/// Normalize a Python package name per PEP 503.
pub fn normalize_package_name(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c == '_' || c == '.' { '-' } else { c })
        .collect()
}

/// Evaluate a simple marker expression against the environment.
fn evaluate_marker_expr(expr: &str, env: &MarkerEnvironment) -> bool {
    let expr = expr.trim();

    // Handle `and` / `or` (simple left-to-right, no precedence beyond parens)
    // Split on ` and ` first
    if let Some(pos) = find_logical_op(expr, " and ") {
        let left = &expr[..pos];
        let right = &expr[pos + 5..];
        return evaluate_marker_expr(left, env) && evaluate_marker_expr(right, env);
    }

    if let Some(pos) = find_logical_op(expr, " or ") {
        let left = &expr[..pos];
        let right = &expr[pos + 4..];
        return evaluate_marker_expr(left, env) || evaluate_marker_expr(right, env);
    }

    // Handle parentheses
    let expr = expr.trim();
    if expr.starts_with('(') && expr.ends_with(')') {
        return evaluate_marker_expr(&expr[1..expr.len() - 1], env);
    }

    // Parse a single comparison: `key op "value"`
    evaluate_single_marker(expr, env)
}

/// Find a logical operator not inside quotes or parentheses.
fn find_logical_op(expr: &str, op: &str) -> Option<usize> {
    let mut depth = 0;
    let mut in_quote = false;
    let mut quote_char = '"';
    let bytes = expr.as_bytes();
    let op_bytes = op.as_bytes();

    for i in 0..expr.len() {
        let c = bytes[i] as char;
        if in_quote {
            if c == quote_char {
                in_quote = false;
            }
            continue;
        }
        if c == '"' || c == '\'' {
            in_quote = true;
            quote_char = c;
            continue;
        }
        if c == '(' {
            depth += 1;
            continue;
        }
        if c == ')' {
            depth -= 1;
            continue;
        }
        if depth == 0 && i + op_bytes.len() <= bytes.len() && &bytes[i..i + op_bytes.len()] == op_bytes {
            return Some(i);
        }
    }
    None
}

/// Evaluate a single marker comparison like `sys_platform == "linux"`.
fn evaluate_single_marker(expr: &str, env: &MarkerEnvironment) -> bool {
    // Try operators in order of specificity (longest first to avoid partial matches).
    // Use find_operator_outside_quotes to avoid matching inside string literals.
    let ops: &[&str] = &[" not in ", " in ", "===", "~=", "!=", "==", "<=", ">=", "<", ">"];

    for op in ops {
        if let Some(pos) = find_operator_outside_quotes(expr, op) {
            let left = expr[..pos].trim();
            let right = expr[pos + op.len()..].trim();

            let left_val = resolve_marker_value(left, env);
            let right_val = resolve_marker_value(right, env);

            return match op.trim() {
                "==" => left_val == right_val,
                "!=" => left_val != right_val,
                "<" => version_cmp(&left_val, &right_val) == std::cmp::Ordering::Less,
                "<=" => version_cmp(&left_val, &right_val) != std::cmp::Ordering::Greater,
                ">" => version_cmp(&left_val, &right_val) == std::cmp::Ordering::Greater,
                ">=" => version_cmp(&left_val, &right_val) != std::cmp::Ordering::Less,
                "in" => right_val.contains(&left_val),
                "not in" => !right_val.contains(&left_val),
                _ => true,
            };
        }
    }

    // If we can't parse it, assume true (permissive)
    true
}

/// Version-aware comparison for marker evaluation.
/// If both values look like version numbers, compare as versions.
/// Otherwise, fall back to string comparison.
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    // Try parsing as PEP 440 versions
    if let (Ok(va), Ok(vb)) = (
        super::version::Pep440Version::parse(a),
        super::version::Pep440Version::parse(b),
    ) {
        return va.cmp(&vb);
    }
    // Fall back to string comparison
    a.cmp(b)
}

/// Find an operator in an expression, skipping occurrences inside quoted strings.
fn find_operator_outside_quotes(expr: &str, op: &str) -> Option<usize> {
    let bytes = expr.as_bytes();
    let op_bytes = op.as_bytes();
    let mut in_quote = false;
    let mut quote_char = b'"';

    for i in 0..expr.len() {
        let c = bytes[i];
        if in_quote {
            if c == quote_char {
                in_quote = false;
            }
            continue;
        }
        if c == b'"' || c == b'\'' {
            in_quote = true;
            quote_char = c;
            continue;
        }
        if i + op_bytes.len() <= bytes.len() && &bytes[i..i + op_bytes.len()] == op_bytes {
            return Some(i);
        }
    }
    None
}

/// Resolve a marker value: either a variable reference or a string literal.
fn resolve_marker_value(val: &str, env: &MarkerEnvironment) -> String {
    let val = val.trim();
    // Strip quotes
    if (val.starts_with('"') && val.ends_with('"'))
        || (val.starts_with('\'') && val.ends_with('\''))
    {
        return val[1..val.len() - 1].to_string();
    }
    // Variable reference
    env.get(val).unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_dependency() {
        let dep = parse_dependency_string("requests>=2.20.0").unwrap();
        assert_eq!(dep.name, "requests");
        assert!(dep.extras.is_empty());
        assert!(dep.markers.is_none());
        assert!(!dep.constraint.is_empty());
    }

    #[test]
    fn test_parse_dependency_with_extras() {
        let dep = parse_dependency_string("requests[security,socks]>=2.20.0").unwrap();
        assert_eq!(dep.name, "requests");
        assert_eq!(dep.extras, vec!["security", "socks"]);
    }

    #[test]
    fn test_parse_dependency_with_markers() {
        let dep =
            parse_dependency_string("pywin32>=300 ; sys_platform == \"win32\"").unwrap();
        assert_eq!(dep.name, "pywin32");
        assert!(dep.markers.is_some());
    }

    #[test]
    fn test_parse_bare_dependency() {
        let dep = parse_dependency_string("requests").unwrap();
        assert_eq!(dep.name, "requests");
        assert!(dep.constraint.is_empty());
    }

    #[test]
    fn test_normalize_name() {
        assert_eq!(normalize_package_name("My.Package_Name"), "my-package-name");
    }

    #[test]
    fn test_pyproject_toml_parse() {
        let toml_content = r#"
[project]
name = "my-project"
version = "1.0.0"
requires-python = ">=3.8"
dependencies = [
    "flask>=3.0",
    "requests[security]>=2.20.0",
    "click",
]

[project.optional-dependencies]
dev = ["pytest>=7.0", "black"]

[project.scripts]
my-cli = "my_project.cli:main"

[build-system]
requires = ["setuptools>=68.0"]
build-backend = "setuptools.build_meta"
"#;
        let manifest = PyProjectManifest::parse_toml(toml_content).unwrap();
        assert_eq!(manifest.name, "my-project");
        assert_eq!(manifest.version, Some("1.0.0".to_string()));
        assert!(manifest.requires_python.is_some());
        assert_eq!(manifest.dependencies.len(), 3);
        assert_eq!(manifest.dependencies[0].name, "flask");
        assert_eq!(manifest.dependencies[1].name, "requests");
        assert_eq!(manifest.dependencies[1].extras, vec!["security"]);
        assert_eq!(manifest.optional_dependencies.len(), 1);
        assert_eq!(manifest.optional_dependencies["dev"].len(), 2);
        assert!(manifest.build_system.is_some());
        assert_eq!(manifest.scripts.len(), 1);
    }

    #[test]
    fn test_marker_evaluation() {
        let env = MarkerEnvironment::detect("3.12.1");

        // Platform check
        let markers = EnvironmentMarkers::parse("sys_platform == \"win32\"").unwrap();
        if cfg!(target_os = "windows") {
            assert!(markers.evaluate(&env));
        } else {
            assert!(!markers.evaluate(&env));
        }

        // Python version check
        let markers = EnvironmentMarkers::parse("python_version >= \"3.8\"").unwrap();
        assert!(markers.evaluate(&env));
    }

    #[test]
    fn test_marker_and_or() {
        let env = MarkerEnvironment::detect("3.12.1");

        let markers =
            EnvironmentMarkers::parse("python_version >= \"3.8\" and os_name == \"posix\"")
                .unwrap();
        if cfg!(unix) {
            assert!(markers.evaluate(&env));
        }

        let markers =
            EnvironmentMarkers::parse("sys_platform == \"win32\" or sys_platform == \"darwin\"")
                .unwrap();
        if cfg!(target_os = "macos") || cfg!(target_os = "windows") {
            assert!(markers.evaluate(&env));
        }
    }
}
