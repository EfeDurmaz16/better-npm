// crates/better-core/src/schema.rs
// Versioned JSON envelope and schema constants for stable CLI API

pub const SCHEMA_VERSION: &str = "1.0";
pub const SCHEMA_MAJOR: u32 = 1;
pub const SCHEMA_MINOR: u32 = 0;

/// Deprecation notice embedded in JSON responses when a deprecated flag/command was used.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DeprecationNotice {
    pub feature: String,
    pub deprecated_in: String,
    pub removed_in: String,
    pub replacement: String,
    pub message: String,
}

/// Check if given CLI args contain deprecated flags and return warnings.
pub fn check_deprecated_flags(args: &[String]) -> Vec<DeprecationNotice> {
    let deprecated: &[(&str, &str, &str, &str)] = &[
        // flag, deprecated_in, removed_in, replacement
        // Add entries here as features are deprecated
        // ("--legacy-peer-deps", "1.0.0", "1.2.0", "--peer-deps=legacy"),
    ];
    let mut notices = vec![];
    for arg in args {
        for (flag, dep_in, rem_in, replacement) in deprecated {
            if arg == flag {
                notices.push(DeprecationNotice {
                    feature: flag.to_string(),
                    deprecated_in: dep_in.to_string(),
                    removed_in: rem_in.to_string(),
                    replacement: replacement.to_string(),
                    message: format!(
                        "'{}' is deprecated since v{} and will be removed in v{}. Use '{}' instead.",
                        flag, dep_in, rem_in, replacement
                    ),
                });
            }
        }
    }
    notices
}

/// Format a versioned JSON output header. Returned as a prefix object to be
/// merged into any command's JSON output.
pub fn json_header(command: &str, success: bool) -> String {
    format!(
        r#"{{"schema_version":"{}","command":"{}","success":{}"#,
        SCHEMA_VERSION,
        command,
        success
    )
}
