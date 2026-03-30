// crates/better-core/src/cli_compat.rs
// Backwards-compatibility shims and alias resolution

use std::collections::HashMap;

/// Command aliases for backwards compatibility.
pub fn resolve_command_alias(cmd: &str) -> &str {
    match cmd {
        "add" => "install",
        "i" => "install",
        "rm" | "uninstall" | "remove" => "install",
        "run-script" => "run",
        "up" => "update",
        "ls" => "list",
        _ => cmd,
    }
}

/// Resolve flag aliases for backwards compat.
pub fn resolve_flag_aliases(args: &[String]) -> Vec<String> {
    args.iter().map(|a| match a.as_str() {
        "--save" | "-S" => "--save-prod".to_string(),
        "--save-dev" | "-D" => "--save-dev".to_string(),
        "--save-exact" | "-E" => "--save-exact".to_string(),
        "-g" => "--global".to_string(),
        other => other.to_string(),
    }).collect()
}

/// Returns true if the argument is a known global flag.
pub fn is_global_flag(arg: &str) -> bool {
    matches!(arg,
        "--json" | "--no-color" | "--color" |
        "--log-level" | "--cache-root" | "--config" |
        "--version" | "-v" | "--help" | "-h"
    )
}

#[derive(Debug)]
pub struct CompatReport {
    pub resolved_command: String,
    pub resolved_args: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn normalize_invocation(command: &str, args: &[String]) -> CompatReport {
    let resolved_command = resolve_command_alias(command).to_string();
    let resolved_args = resolve_flag_aliases(args);
    let mut warnings = vec![];
    if resolved_command != command {
        warnings.push(format!(
            "Command '{}' is an alias for '{}'. Use the canonical form.",
            command, resolved_command
        ));
    }
    CompatReport { resolved_command, resolved_args, warnings }
}
