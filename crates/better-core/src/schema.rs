// crates/better-core/src/schema.rs
// Stable CLI API — versioned JSON schema + deprecation notices

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonEnvelope {
    pub schema_version: String,
    pub command: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub deprecations: Vec<DeprecationNotice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeprecationNotice {
    pub feature: String,
    pub deprecated_in: String,
    pub removed_in: String,
    pub replacement: String,
    pub message: String,
}

impl JsonEnvelope {
    pub fn ok(command: &str) -> Self {
        Self {
            schema_version: SCHEMA_VERSION.to_string(),
            command: command.to_string(),
            success: true,
            warnings: vec![],
            deprecations: vec![],
        }
    }

    pub fn err(command: &str) -> Self {
        let mut e = Self::ok(command);
        e.success = false;
        e
    }

    pub fn with_warning(mut self, w: impl Into<String>) -> Self {
        self.warnings.push(w.into());
        self
    }

    pub fn with_deprecation(mut self, notice: DeprecationNotice) -> Self {
        self.deprecations.push(notice);
        self
    }
}

// Known deprecations registry — add entries here as CLI flags are retired
pub fn check_deprecations(args: &[String]) -> Vec<DeprecationNotice> {
    let known: &[(&str, &str, &str, &str, &str)] = &[
        // ("--flag", "deprecated_in", "removed_in", "replacement", "message")
    ];

    let mut out = vec![];
    for arg in args {
        for &(flag, dep_in, rem_in, replacement, message) in known {
            if arg == flag {
                out.push(DeprecationNotice {
                    feature: flag.to_string(),
                    deprecated_in: dep_in.to_string(),
                    removed_in: rem_in.to_string(),
                    replacement: replacement.to_string(),
                    message: message.to_string(),
                });
            }
        }
    }
    out
}
