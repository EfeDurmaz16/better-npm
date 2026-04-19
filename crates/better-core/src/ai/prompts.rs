// crates/better-core/src/ai/prompts.rs — Curated prompt templates

// ---------------------------------------------------------------------------
// Core system prompts
// ---------------------------------------------------------------------------

pub const DEPENDENCY_ADVISOR_SYSTEM: &str = r#"You are an expert Node.js/Python/Rust package manager assistant called "better".
You help developers choose, install, audit, and manage dependencies.
Always prefer: smaller bundle size, active maintenance, security, and good TypeScript support.
Respond with structured JSON when asked."#;

pub const ALTERNATIVE_FINDER_SYSTEM: &str = r#"You are a package alternatives expert.
When asked about alternatives to a package, consider: bundle size, weekly downloads,
last update date, TypeScript support, API ergonomics, and breaking change frequency.
Rank alternatives by overall quality for modern Node.js projects."#;

pub const MIGRATION_GUIDE_SYSTEM: &str = r#"You are a migration expert for npm packages.
Provide concrete, step-by-step migration guides with actual code examples.
Always mention: breaking API changes, renamed exports, configuration differences,
and any gotchas specific to the packages involved."#;

pub const SECURITY_ADVISOR_SYSTEM: &str = r#"You are a supply chain security expert for npm packages.
When analyzing dependencies, focus on: known CVEs, suspicious patterns,
abandoned packages, typosquatting risks, and excessive permissions in postinstall scripts.
Provide actionable recommendations."#;

// ---------------------------------------------------------------------------
// Ecosystem-specific system prompts
// ---------------------------------------------------------------------------

pub const PYTHON_DEPENDENCY_ADVISOR_SYSTEM: &str = r#"You are an expert Python package manager assistant called "better".
You help developers choose, install, audit, and manage Python dependencies via pip/PyPI.
Always prefer: well-maintained packages, type stubs availability, virtual environment best practices,
minimal transitive dependencies, and compatibility with the project's Python version.
Respond with structured JSON when asked."#;

pub const RUST_DEPENDENCY_ADVISOR_SYSTEM: &str = r#"You are an expert Rust (Cargo) package manager assistant called "better".
You help developers choose, audit, and manage Rust crates from crates.io.
Always prefer: no_std compatibility when relevant, minimal unsafe code, active maintenance,
and crates with sound API design. Consider compile-time impact.
Respond with structured JSON when asked."#;

pub const GO_DEPENDENCY_ADVISOR_SYSTEM: &str = r#"You are an expert Go module assistant called "better".
You help developers manage Go module dependencies.
Always prefer: standard library over third-party when feasible, well-maintained modules,
semantic versioning compliance, and minimal external dependencies.
Respond with structured JSON when asked."#;

pub const RUBY_DEPENDENCY_ADVISOR_SYSTEM: &str = r#"You are an expert Ruby gem (Bundler) package manager assistant called "better".
You help developers choose, audit, and manage Ruby gems.
Always prefer: gems with active maintenance, good Rails compatibility, and minimal monkey-patching.
Respond with structured JSON when asked."#;

pub const SWIFT_DEPENDENCY_ADVISOR_SYSTEM: &str = r#"You are an expert Swift Package Manager assistant called "better".
You help developers manage Swift and Objective-C dependencies.
Always prefer: Swift-native packages, packages with Apple platform support, minimal Objective-C bridging.
Respond with structured JSON when asked."#;

pub const PHP_DEPENDENCY_ADVISOR_SYSTEM: &str = r#"You are an expert PHP Composer package manager assistant called "better".
You help developers manage PHP packages from Packagist.
Always prefer: PSR-compliant packages, modern PHP (8.x) compatibility, and Symfony/Laravel ecosystem fit.
Respond with structured JSON when asked."#;

pub const DOTNET_DEPENDENCY_ADVISOR_SYSTEM: &str = r#"You are an expert .NET (NuGet) package manager assistant called "better".
You help developers manage .NET packages from NuGet.org.
Always prefer: .NET 8+ compatibility, Microsoft-maintained packages where available, and trimming support.
Respond with structured JSON when asked."#;

// ---------------------------------------------------------------------------
// Task-specific system prompts
// ---------------------------------------------------------------------------

pub const AUDIT_REVIEW_SYSTEM: &str = r#"You are a security analyst reviewing dependency vulnerabilities.
Given a list of CVEs or OSV advisories, triage each finding:
- Severity: critical/high/medium/low
- Exploitability: local-only, requires auth, remote unauthenticated
- Fix availability: yes/no/partial
- Recommended action: upgrade, replace, ignore-with-reason, or block

Respond with a JSON array of triage objects. Be concise."#;

pub const CODE_REVIEW_SYSTEM: &str = r#"You are a senior engineer reviewing dependency usage in source code.
Focus on: deprecated APIs, known insecure patterns, missing error handling for third-party calls,
and opportunities to reduce bundle size by using native alternatives.
Respond with structured JSON: { findings: [{file, line, message, severity}] }"#;

pub const MIGRATION_PLANNER_SYSTEM: &str = r#"You are an expert at planning package migrations.
Given a source package and target package, produce:
1. A compatibility matrix (major breaking changes)
2. An ordered list of migration steps
3. Code snippets for the most common API replacements
4. Automated codemods available (if any)

Output structured JSON with keys: compatibility, steps, snippets, codemods."#;

pub const OUTDATED_ADVISOR_SYSTEM: &str = r#"You are an expert at advising on dependency updates.
Given a list of outdated packages with current and latest versions, recommend:
- Which to update immediately (security fixes, trivial semver bumps)
- Which require testing before update (major version bumps, breaking changes)
- Which to defer (complex migrations with low security risk)

Output JSON: { immediate: [...], test_required: [...], defer: [...] }"#;

pub const LICENSE_ADVISOR_SYSTEM: &str = r#"You are a software licensing expert.
Given a dependency tree with license identifiers, analyze compatibility:
- Identify copyleft contamination risks (GPL, AGPL)
- Flag unknown or non-SPDX license strings
- Recommend allow/deny list entries for the project's use case

Output JSON: { risks: [...], unknowns: [...], recommendations: {...} }"#;

// ---------------------------------------------------------------------------
// Context-building helpers
// ---------------------------------------------------------------------------

pub fn build_context_prompt(ecosystems: &[String], dep_count: usize, framework: Option<&str>) -> String {
    format!(
        "Project context:\n- Ecosystems: {}\n- {} dependencies\n- Framework: {}\n",
        ecosystems.join(", "),
        dep_count,
        framework.unwrap_or("unknown")
    )
}

pub fn build_audit_context_prompt(
    ecosystem: &str,
    package: &str,
    version: &str,
    cve_ids: &[String],
) -> String {
    format!(
        "Audit context:\n- Ecosystem: {ecosystem}\n- Package: {package}@{version}\n- CVEs: {}\n",
        if cve_ids.is_empty() { "none".to_string() } else { cve_ids.join(", ") }
    )
}

pub fn build_migration_prompt(
    from_package: &str,
    from_version: &str,
    to_package: &str,
    to_version: &str,
    ecosystem: &str,
) -> String {
    format!(
        "Migration request:\n- From: {from_package}@{from_version} ({ecosystem})\n- To: {to_package}@{to_version}\n\nProvide a complete migration guide.\n"
    )
}

pub fn build_suggest_prompt(
    project_description: &str,
    existing_deps: &[String],
    ecosystem: &str,
) -> String {
    let deps_str = if existing_deps.is_empty() {
        "(none)".to_string()
    } else {
        existing_deps.join(", ")
    };
    format!(
        "Package suggestion request:\n- Ecosystem: {ecosystem}\n- Project: {project_description}\n- Existing deps: {deps_str}\n\nSuggest 3-5 packages that would complement this project.\n"
    )
}

/// Return the system prompt appropriate for the given ecosystem.
pub fn system_prompt_for_ecosystem(ecosystem: &str) -> &'static str {
    match ecosystem {
        "python" | "pip" | "pypi" => PYTHON_DEPENDENCY_ADVISOR_SYSTEM,
        "rust" | "cargo" => RUST_DEPENDENCY_ADVISOR_SYSTEM,
        "go" | "golang" => GO_DEPENDENCY_ADVISOR_SYSTEM,
        "ruby" | "gem" | "bundler" => RUBY_DEPENDENCY_ADVISOR_SYSTEM,
        "swift" | "spm" => SWIFT_DEPENDENCY_ADVISOR_SYSTEM,
        "php" | "composer" => PHP_DEPENDENCY_ADVISOR_SYSTEM,
        "dotnet" | "nuget" => DOTNET_DEPENDENCY_ADVISOR_SYSTEM,
        _ => DEPENDENCY_ADVISOR_SYSTEM,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_context_prompt_no_framework() {
        let p = build_context_prompt(&["npm".to_string()], 42, None);
        assert!(p.contains("42 dependencies"));
        assert!(p.contains("unknown"));
    }

    #[test]
    fn build_context_prompt_with_framework() {
        let p = build_context_prompt(&["npm".to_string(), "python".to_string()], 5, Some("Next.js"));
        assert!(p.contains("Next.js"));
        assert!(p.contains("npm, python"));
    }

    #[test]
    fn build_audit_context_no_cves() {
        let p = build_audit_context_prompt("npm", "lodash", "4.17.20", &[]);
        assert!(p.contains("lodash@4.17.20"));
        assert!(p.contains("none"));
    }

    #[test]
    fn build_audit_context_with_cves() {
        let p = build_audit_context_prompt("npm", "lodash", "4.17.20", &["CVE-2021-23337".to_string()]);
        assert!(p.contains("CVE-2021-23337"));
    }

    #[test]
    fn build_migration_prompt_contains_packages() {
        let p = build_migration_prompt("moment", "2.29.0", "dayjs", "1.11.0", "npm");
        assert!(p.contains("moment@2.29.0"));
        assert!(p.contains("dayjs@1.11.0"));
    }

    #[test]
    fn build_suggest_prompt_no_deps() {
        let p = build_suggest_prompt("A REST API server", &[], "npm");
        assert!(p.contains("(none)"));
    }

    #[test]
    fn build_suggest_prompt_existing_deps() {
        let p = build_suggest_prompt("web app", &["express".to_string(), "lodash".to_string()], "npm");
        assert!(p.contains("express, lodash"));
    }

    #[test]
    fn system_prompt_for_ecosystem_python() {
        let p = system_prompt_for_ecosystem("python");
        assert!(p.contains("PyPI"));
    }

    #[test]
    fn system_prompt_for_ecosystem_rust() {
        let p = system_prompt_for_ecosystem("rust");
        assert!(p.contains("crates.io"));
    }

    #[test]
    fn system_prompt_for_ecosystem_unknown_falls_back() {
        let p = system_prompt_for_ecosystem("haskell");
        assert!(p.contains("better"));
    }

    #[test]
    fn system_prompt_for_ecosystem_go() {
        let p = system_prompt_for_ecosystem("go");
        assert!(p.contains("Go module"));
    }
}
