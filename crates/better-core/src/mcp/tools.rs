use super::protocol::*;
use std::path::PathBuf;

pub fn list_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "install".to_string(),
            description: "Install dependencies for the current project".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "project_root": { "type": "string", "description": "Project root directory" },
                    "packages": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Specific packages to install (empty for all)"
                    },
                    "ecosystem": { "type": "string", "enum": ["npm", "python", "auto"] }
                },
                "required": ["project_root"]
            }),
        },
        ToolDefinition {
            name: "add".to_string(),
            description: "Add a package to the project dependencies".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "project_root": { "type": "string" },
                    "package": { "type": "string", "description": "Package name with optional version (e.g. 'express@4.18.0')" },
                    "dev": { "type": "boolean", "description": "Add as dev dependency" },
                    "ecosystem": { "type": "string", "enum": ["npm", "python", "auto"] }
                },
                "required": ["project_root", "package"]
            }),
        },
        ToolDefinition {
            name: "remove".to_string(),
            description: "Remove a package from the project".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "project_root": { "type": "string" },
                    "package": { "type": "string" }
                },
                "required": ["project_root", "package"]
            }),
        },
        ToolDefinition {
            name: "audit".to_string(),
            description: "Run security audit on all dependencies, returning vulnerabilities".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "project_root": { "type": "string" },
                    "min_severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] }
                },
                "required": ["project_root"]
            }),
        },
        ToolDefinition {
            name: "why".to_string(),
            description: "Explain why a package is installed (dependency path trace)".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "project_root": { "type": "string" },
                    "package": { "type": "string" }
                },
                "required": ["project_root", "package"]
            }),
        },
        ToolDefinition {
            name: "context".to_string(),
            description: "Generate LLM-friendly context/documentation for a package".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "project_root": { "type": "string" },
                    "package": { "type": "string" },
                    "ecosystem": { "type": "string", "enum": ["npm", "python", "auto"] }
                },
                "required": ["project_root", "package"]
            }),
        },
        ToolDefinition {
            name: "outdated".to_string(),
            description: "List outdated packages with available updates".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "project_root": { "type": "string" }
                },
                "required": ["project_root"]
            }),
        },
        ToolDefinition {
            name: "search".to_string(),
            description: "Search for packages across npm and PyPI registries".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query string" },
                    "ecosystem": { "type": "string", "enum": ["npm", "python", "all"], "default": "all" },
                    "limit": { "type": "integer", "default": 10, "description": "Max results to return" }
                },
                "required": ["query"]
            }),
        },
    ]
}

pub fn execute_tool(name: &str, args: &serde_json::Value) -> ToolResult {
    match name {
        "install" => execute_install(args),
        "add" => execute_add(args),
        "remove" => execute_remove(args),
        "audit" => execute_audit(args),
        "why" => execute_why(args),
        "context" => execute_context(args),
        "outdated" => execute_outdated(args),
        "search" => execute_search(args),
        _ => ToolResult::error(format!("Unknown tool: {}", name)),
    }
}

fn get_string_arg(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn execute_install(args: &serde_json::Value) -> ToolResult {
    let project_root = match get_string_arg(args, "project_root") {
        Some(p) => PathBuf::from(p),
        None => return ToolResult::error("project_root is required".to_string()),
    };

    // Delegate to the underlying install command via subprocess
    let mut cmd = std::process::Command::new("better-core");
    cmd.arg("install")
        .arg("--project-root")
        .arg(&project_root);

    match cmd.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if output.status.success() {
                ToolResult::text(if stdout.is_empty() { "Install completed successfully".to_string() } else { stdout })
            } else {
                ToolResult::error(format!("Install failed: {}{}", stdout, stderr))
            }
        }
        Err(e) => ToolResult::error(format!("Failed to run install: {}", e)),
    }
}

fn execute_add(args: &serde_json::Value) -> ToolResult {
    let project_root = match get_string_arg(args, "project_root") {
        Some(p) => p,
        None => return ToolResult::error("project_root is required".to_string()),
    };
    let package = match get_string_arg(args, "package") {
        Some(p) => p,
        None => return ToolResult::error("package is required".to_string()),
    };
    let dev = args.get("dev").and_then(|v| v.as_bool()).unwrap_or(false);
    let dev_flag = if dev { " --save-dev" } else { "" };

    // Use npm/pip add via subprocess
    let pkg_json = PathBuf::from(&project_root).join("package.json");
    let (cmd_name, cmd_args) = if pkg_json.exists() {
        ("npm", vec!["install".to_string(), package.clone(), if dev { "--save-dev".to_string() } else { "--save".to_string() }])
    } else {
        ("pip", vec!["install".to_string(), package.clone()])
    };

    match std::process::Command::new(cmd_name)
        .args(&cmd_args)
        .current_dir(&project_root)
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                ToolResult::text(format!("Added {}{}", package, dev_flag))
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                ToolResult::error(format!("Failed to add {}: {}", package, stderr))
            }
        }
        Err(e) => ToolResult::error(format!("Failed to run {}: {}", cmd_name, e)),
    }
}

fn execute_remove(args: &serde_json::Value) -> ToolResult {
    let project_root = match get_string_arg(args, "project_root") {
        Some(p) => p,
        None => return ToolResult::error("project_root is required".to_string()),
    };
    let package = match get_string_arg(args, "package") {
        Some(p) => p,
        None => return ToolResult::error("package is required".to_string()),
    };

    let pkg_json = PathBuf::from(&project_root).join("package.json");
    let (cmd_name, cmd_args) = if pkg_json.exists() {
        ("npm", vec!["uninstall".to_string(), package.clone()])
    } else {
        ("pip", vec!["uninstall".to_string(), "-y".to_string(), package.clone()])
    };

    match std::process::Command::new(cmd_name)
        .args(&cmd_args)
        .current_dir(&project_root)
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                ToolResult::text(format!("Removed {}", package))
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                ToolResult::error(format!("Failed to remove {}: {}", package, stderr))
            }
        }
        Err(e) => ToolResult::error(format!("Failed to run {}: {}", cmd_name, e)),
    }
}

fn execute_audit(args: &serde_json::Value) -> ToolResult {
    let project_root = match get_string_arg(args, "project_root") {
        Some(p) => PathBuf::from(p),
        None => return ToolResult::error("project_root is required".to_string()),
    };
    let min_severity = get_string_arg(args, "min_severity").unwrap_or_else(|| "low".to_string());

    let lockfile = project_root.join("package-lock.json");

    match crate::run_audit_with_config(&lockfile, &project_root, &min_severity, false) {
        Ok(result) => {
            let mut output = format!("# Security Audit\n\n");
            output.push_str(&format!("Scanned: {} packages\n", result.scanned_packages));
            output.push_str(&format!("Risk level: {}\n", result.risk_level));
            output.push_str(&format!("Vulnerabilities: {} total ({} critical, {} high, {} medium, {} low)\n\n",
                result.total, result.critical, result.high, result.medium, result.low));
            for vuln in &result.vulnerabilities {
                output.push_str(&format!("- [{}] {} in {}@{}: {}\n",
                    vuln.severity, vuln.id, vuln.package, vuln.version, vuln.summary));
            }
            ToolResult::text(output)
        }
        Err(e) => ToolResult::error(format!("Audit failed: {}", e)),
    }
}

fn execute_why(args: &serde_json::Value) -> ToolResult {
    let project_root = match get_string_arg(args, "project_root") {
        Some(p) => PathBuf::from(p),
        None => return ToolResult::error("project_root is required".to_string()),
    };
    let package = match get_string_arg(args, "package") {
        Some(p) => p,
        None => return ToolResult::error("package is required".to_string()),
    };

    let lockfile = project_root.join("package-lock.json");

    match crate::trace_dependency(&project_root, &lockfile, &package) {
        Ok(result) => {
            let mut output = format!("# Why is {} installed?\n\n", package);
            output.push_str(&format!("Direct dependency: {}\n", result.is_direct));
            output.push_str(&format!("Dependency paths: {}\n\n", result.dependency_paths.len()));
            for (i, path) in result.dependency_paths.iter().enumerate() {
                output.push_str(&format!("Path {}:\n", i + 1));
                for (j, step) in path.iter().enumerate() {
                    output.push_str(&format!("  {} {}\n", if j == 0 { ">" } else { " " }, step));
                }
                output.push('\n');
            }
            ToolResult::text(output)
        }
        Err(e) => ToolResult::error(format!("Why trace failed: {}", e)),
    }
}

fn execute_context(args: &serde_json::Value) -> ToolResult {
    let project_root = match get_string_arg(args, "project_root") {
        Some(p) => PathBuf::from(p),
        None => return ToolResult::error("project_root is required".to_string()),
    };
    let package = match get_string_arg(args, "package") {
        Some(p) => p,
        None => return ToolResult::error("package is required".to_string()),
    };
    let ecosystem = get_string_arg(args, "ecosystem");

    match crate::context::generate_context(&project_root, &package, ecosystem.as_deref()) {
        Ok(ctx) => ToolResult::text(ctx.markdown),
        Err(e) => ToolResult::error(format!("Context generation failed: {}", e)),
    }
}

fn execute_outdated(args: &serde_json::Value) -> ToolResult {
    let project_root = match get_string_arg(args, "project_root") {
        Some(p) => PathBuf::from(p),
        None => return ToolResult::error("project_root is required".to_string()),
    };

    let lockfile = project_root.join("package-lock.json");

    match crate::check_outdated(&project_root, &lockfile) {
        Ok(report) => {
            if report.packages.is_empty() {
                ToolResult::text("All packages are up to date.".to_string())
            } else {
                let mut output = format!("# {} outdated packages\n\n", report.outdated);
                output.push_str("| Package | Current | Latest | Type |\n");
                output.push_str("|---------|---------|--------|------|\n");
                for pkg in &report.packages {
                    output.push_str(&format!(
                        "| {} | {} | {} | {} |\n",
                        pkg.name, pkg.current, pkg.latest, pkg.update_type
                    ));
                }
                ToolResult::text(output)
            }
        }
        Err(e) => ToolResult::error(format!("Outdated check failed: {}", e)),
    }
}

fn execute_search(args: &serde_json::Value) -> ToolResult {
    let query = match get_string_arg(args, "query") {
        Some(q) => q,
        None => return ToolResult::error("query is required".to_string()),
    };
    let ecosystem = get_string_arg(args, "ecosystem");
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(10) as usize;

    match crate::search::search(&query, ecosystem.as_deref(), limit) {
        Ok(result) => match serde_json::to_string_pretty(&result) {
            Ok(json) => ToolResult::text(json),
            Err(_) => ToolResult::text(format!("Found {} packages", result.total)),
        },
        Err(e) => ToolResult::error(format!("Search failed: {}", e)),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_tools_returns_expected_names() {
        let tools = list_tools();
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"install"));
        assert!(names.contains(&"audit"));
        assert!(names.contains(&"search"));
        assert!(names.contains(&"why"));
    }

    fn get_text(result: &ToolResult) -> &str {
        match result.content.first() {
            Some(ToolContent::Text { text }) => text.as_str(),
            None => "",
        }
    }

    #[test]
    fn execute_tool_unknown_returns_error() {
        let result = execute_tool("unknown_xyz", &serde_json::json!({}));
        assert!(result.is_error);
        assert!(get_text(&result).contains("Unknown tool"));
    }

    #[test]
    fn execute_tool_install_missing_project_root_returns_error() {
        let result = execute_tool("install", &serde_json::json!({}));
        assert!(result.is_error);
        assert!(get_text(&result).contains("project_root"));
    }

    #[test]
    fn execute_tool_audit_missing_project_root_returns_error() {
        let result = execute_tool("audit", &serde_json::json!({}));
        assert!(result.is_error);
    }

    #[test]
    fn list_tools_all_have_descriptions() {
        let tools = list_tools();
        for tool in &tools {
            assert!(!tool.description.is_empty(), "tool {} has empty description", tool.name);
        }
    }

    #[test]
    fn execute_tool_why_missing_args_returns_error() {
        let result = execute_tool("why", &serde_json::json!({}));
        assert!(result.is_error);
    }

    #[test]
    fn execute_tool_add_missing_project_root_returns_error() {
        let result = execute_tool("add", &serde_json::json!({}));
        assert!(result.is_error);
        assert!(get_text(&result).contains("project_root"));
    }

    #[test]
    fn execute_tool_remove_missing_package_returns_error() {
        let result = execute_tool("remove", &serde_json::json!({"project_root": "/tmp"}));
        assert!(result.is_error);
        assert!(get_text(&result).contains("package"));
    }

    #[test]
    fn get_string_arg_returns_value() {
        let args = serde_json::json!({"key": "value"});
        assert_eq!(get_string_arg(&args, "key"), Some("value".to_string()));
        assert_eq!(get_string_arg(&args, "missing"), None);
    }
}
