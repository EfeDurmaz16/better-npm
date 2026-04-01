// crates/better-core/src/cli_compat.rs
// CLI backward-compatibility helpers

use std::collections::HashMap;

pub struct CompatRegistry {
    aliases: HashMap<&'static str, &'static str>,
}

impl Default for CompatRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl CompatRegistry {
    pub fn new() -> Self {
        let mut aliases = HashMap::new();
        // Old → new command aliases (kept for backward compat)
        aliases.insert("i", "install");
        aliases.insert("add", "install");
        aliases.insert("rm", "remove");
        aliases.insert("list", "outdated");
        aliases.insert("info", "context");
        Self { aliases }
    }

    /// Resolve an alias to its canonical command name.
    pub fn resolve<'a>(&self, command: &'a str) -> &'a str {
        self.aliases.get(command).copied().unwrap_or(command)
    }

    /// Check if a command is deprecated and return its replacement.
    pub fn deprecated(&self, _command: &str) -> Option<(&str, &str)> {
        // (deprecated_command → (replacement, message))
        // Add entries here when commands are retired
        None
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_alias_i_to_install() {
        let reg = CompatRegistry::new();
        assert_eq!(reg.resolve("i"), "install");
    }

    #[test]
    fn resolve_unknown_returns_unchanged() {
        let reg = CompatRegistry::new();
        assert_eq!(reg.resolve("audit"), "audit");
    }

    #[test]
    fn resolve_rm_to_remove() {
        let reg = CompatRegistry::new();
        assert_eq!(reg.resolve("rm"), "remove");
    }
}
