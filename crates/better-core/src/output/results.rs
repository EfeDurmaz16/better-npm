use super::CommandOutput;

#[derive(Debug, serde::Serialize)]
pub struct InstallResult {
    pub command: &'static str,
    pub success: bool,
    pub total_packages: usize,
    pub total_ms: u64,
    pub cache_hits: usize,
    pub cache_misses: usize,
    pub lockfile_updated: bool,
}

impl CommandOutput for InstallResult {
    fn command_name(&self) -> &'static str {
        "install"
    }
    fn schema_url(&self) -> &'static str {
        "https://better.sh/schema/v1/install.json"
    }
}

#[derive(Debug, serde::Serialize)]
pub struct AuditResult {
    pub command: &'static str,
    pub total: usize,
    pub critical: usize,
    pub high: usize,
    pub medium: usize,
    pub low: usize,
    pub packages_scanned: usize,
    pub scan_ms: u64,
}

impl CommandOutput for AuditResult {
    fn command_name(&self) -> &'static str {
        "audit"
    }
    fn schema_url(&self) -> &'static str {
        "https://better.sh/schema/v1/audit.json"
    }
    fn exit_code(&self) -> i32 {
        if self.critical > 0 || self.high > 0 {
            2
        } else {
            0
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct OutdatedResult {
    pub command: &'static str,
    pub total_outdated: usize,
}

impl CommandOutput for OutdatedResult {
    fn command_name(&self) -> &'static str {
        "outdated"
    }
    fn schema_url(&self) -> &'static str {
        "https://better.sh/schema/v1/outdated.json"
    }
}

#[derive(Debug, serde::Serialize)]
pub struct WhyResult {
    pub command: &'static str,
    pub package: String,
    pub is_direct: bool,
}

impl CommandOutput for WhyResult {
    fn command_name(&self) -> &'static str {
        "why"
    }
    fn schema_url(&self) -> &'static str {
        "https://better.sh/schema/v1/why.json"
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::CommandOutput;

    #[test]
    fn audit_result_high_vulns_exit_code_2() {
        let r = AuditResult {
            command: "audit",
            total: 2,
            critical: 0,
            high: 1,
            medium: 0,
            low: 0,
            packages_scanned: 100,
            scan_ms: 500,
        };
        assert_eq!(r.exit_code(), 2);
    }

    #[test]
    fn audit_result_clean_exit_code_0() {
        let r = AuditResult {
            command: "audit",
            total: 0,
            critical: 0,
            high: 0,
            medium: 1,
            low: 0,
            packages_scanned: 100,
            scan_ms: 500,
        };
        assert_eq!(r.exit_code(), 0);
    }

    #[test]
    fn install_result_command_name() {
        let r = InstallResult {
            command: "install",
            success: true,
            total_packages: 10,
            total_ms: 1000,
            cache_hits: 8,
            cache_misses: 2,
            lockfile_updated: false,
        };
        assert_eq!(r.command_name(), "install");
    }
}
