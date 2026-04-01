// crates/better-core/src/exit_codes.rs
//
// Stable semantic exit codes — v1.0 API contract (Task 80.2).
// These MUST NOT change within a major version.

/// Stable exit codes used by the `better` CLI.
pub mod exit {
    /// Command succeeded
    pub const SUCCESS: i32 = 0;
    /// General / unclassified error
    pub const GENERAL_ERROR: i32 = 1;
    /// Vulnerability found and threshold exceeded
    pub const SECURITY_VIOLATION: i32 = 2;
    /// Policy rule violated (license, approval, firewall)
    pub const POLICY_VIOLATION: i32 = 3;
    /// Dependency resolution failed
    pub const RESOLUTION_FAILURE: i32 = 4;
    /// Network / registry unreachable
    pub const NETWORK_ERROR: i32 = 5;
    /// Authentication / token error
    pub const AUTH_ERROR: i32 = 6;
    /// Lockfile mismatch (frozen install failed)
    pub const LOCKFILE_MISMATCH: i32 = 7;
    /// Plugin error
    pub const PLUGIN_ERROR: i32 = 8;
    /// OSP provisioning error
    pub const OSP_ERROR: i32 = 9;
    /// Invalid arguments (mirrors sysexits.h EX_USAGE)
    pub const INVALID_ARGS: i32 = 64;
}

/// Map an error category string to the corresponding exit code.
pub fn exit_code_for(category: &str) -> i32 {
    match category {
        "security"    => exit::SECURITY_VIOLATION,
        "policy"      => exit::POLICY_VIOLATION,
        "resolution"  => exit::RESOLUTION_FAILURE,
        "network"     => exit::NETWORK_ERROR,
        "auth"        => exit::AUTH_ERROR,
        "lockfile"    => exit::LOCKFILE_MISMATCH,
        "plugin"      => exit::PLUGIN_ERROR,
        "osp"         => exit::OSP_ERROR,
        "args"        => exit::INVALID_ARGS,
        _             => exit::GENERAL_ERROR,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_is_zero() {
        assert_eq!(exit::SUCCESS, 0);
    }

    #[test]
    fn all_codes_non_negative() {
        let codes = [
            exit::SUCCESS, exit::GENERAL_ERROR, exit::SECURITY_VIOLATION,
            exit::POLICY_VIOLATION, exit::RESOLUTION_FAILURE, exit::NETWORK_ERROR,
            exit::AUTH_ERROR, exit::LOCKFILE_MISMATCH, exit::PLUGIN_ERROR,
            exit::OSP_ERROR, exit::INVALID_ARGS,
        ];
        for &c in &codes {
            assert!(c >= 0, "exit code {} is negative", c);
        }
    }

    #[test]
    fn all_codes_unique() {
        let mut codes = vec![
            exit::SUCCESS, exit::GENERAL_ERROR, exit::SECURITY_VIOLATION,
            exit::POLICY_VIOLATION, exit::RESOLUTION_FAILURE, exit::NETWORK_ERROR,
            exit::AUTH_ERROR, exit::LOCKFILE_MISMATCH, exit::PLUGIN_ERROR,
            exit::OSP_ERROR, exit::INVALID_ARGS,
        ];
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), 11, "exit codes must be unique");
    }

    #[test]
    fn exit_code_for_known_categories() {
        assert_eq!(exit_code_for("security"), exit::SECURITY_VIOLATION);
        assert_eq!(exit_code_for("lockfile"), exit::LOCKFILE_MISMATCH);
        assert_eq!(exit_code_for("args"), exit::INVALID_ARGS);
    }

    #[test]
    fn exit_code_for_unknown_returns_general() {
        assert_eq!(exit_code_for("foo"), exit::GENERAL_ERROR);
    }
}
