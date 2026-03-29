use std::collections::HashSet;
use std::fs;
use std::path::Path;

use crate::{extract_json_field, extract_json_object_pairs, extract_json_array_strings, list_packages_in_node_modules};

// --- SPDX Expression Parser ---

#[derive(Debug, Clone)]
pub enum SpdxExpr {
    License(String),
    And(Box<SpdxExpr>, Box<SpdxExpr>),
    Or(Box<SpdxExpr>, Box<SpdxExpr>),
    With(String, String),
}

impl SpdxExpr {
    pub fn parse(input: &str) -> Result<Self, String> {
        let input = input.trim();
        if input.is_empty() {
            return Err("empty SPDX expression".to_string());
        }
        let tokens = tokenize(input)?;
        if tokens.is_empty() {
            return Err("empty SPDX expression".to_string());
        }
        let (expr, pos) = parse_expr(&tokens, 0)?;
        if pos < tokens.len() {
            return Err(format!("unexpected token at position {}", pos));
        }
        Ok(expr)
    }

    /// Check if this expression is satisfied by an allow-list.
    /// For OR: at least one branch must be allowed.
    /// For AND: all branches must be allowed.
    pub fn is_allowed(&self, allowed: &HashSet<String>) -> bool {
        match self {
            Self::License(id) => allowed.contains(id) || allowed.contains(&id.to_uppercase()),
            Self::Or(a, b) => a.is_allowed(allowed) || b.is_allowed(allowed),
            Self::And(a, b) => a.is_allowed(allowed) && b.is_allowed(allowed),
            Self::With(license, _) => allowed.contains(license) || allowed.contains(&license.to_uppercase()),
        }
    }

    /// Check if this expression contains any denied license.
    /// For OR: both branches must be denied (since you can choose either).
    /// For AND: any branch denied means the whole thing is denied.
    pub fn is_denied(&self, denied: &HashSet<String>) -> bool {
        match self {
            Self::License(id) => denied.contains(id) || denied.contains(&id.to_uppercase()),
            Self::Or(a, b) => a.is_denied(denied) && b.is_denied(denied),
            Self::And(a, b) => a.is_denied(denied) || b.is_denied(denied),
            Self::With(license, _) => denied.contains(license) || denied.contains(&license.to_uppercase()),
        }
    }

    /// Extract all individual license IDs from the expression.
    pub fn licenses(&self) -> Vec<String> {
        match self {
            Self::License(id) => vec![id.clone()],
            Self::Or(a, b) | Self::And(a, b) => {
                let mut v = a.licenses();
                v.extend(b.licenses());
                v
            }
            Self::With(license, _) => vec![license.clone()],
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    License(String),
    And,
    Or,
    With,
    LParen,
    RParen,
}

fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(&ch) = chars.peek() {
        if ch.is_whitespace() {
            chars.next();
            continue;
        }
        if ch == '(' {
            tokens.push(Token::LParen);
            chars.next();
        } else if ch == ')' {
            tokens.push(Token::RParen);
            chars.next();
        } else {
            let mut word = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() || c == '(' || c == ')' {
                    break;
                }
                word.push(c);
                chars.next();
            }
            match word.as_str() {
                "AND" => tokens.push(Token::And),
                "OR" => tokens.push(Token::Or),
                "WITH" => tokens.push(Token::With),
                _ => tokens.push(Token::License(word)),
            }
        }
    }

    Ok(tokens)
}

fn parse_expr(tokens: &[Token], pos: usize) -> Result<(SpdxExpr, usize), String> {
    let (mut left, mut pos) = parse_primary(tokens, pos)?;

    while pos < tokens.len() {
        match &tokens[pos] {
            Token::And => {
                let (right, new_pos) = parse_primary(tokens, pos + 1)?;
                left = SpdxExpr::And(Box::new(left), Box::new(right));
                pos = new_pos;
            }
            Token::Or => {
                let (right, new_pos) = parse_primary(tokens, pos + 1)?;
                left = SpdxExpr::Or(Box::new(left), Box::new(right));
                pos = new_pos;
            }
            Token::With => {
                if let SpdxExpr::License(license) = left {
                    if pos + 1 >= tokens.len() {
                        return Err("expected exception after WITH".to_string());
                    }
                    if let Token::License(exc) = &tokens[pos + 1] {
                        left = SpdxExpr::With(license, exc.clone());
                        pos = pos + 2;
                    } else {
                        return Err("expected exception identifier after WITH".to_string());
                    }
                } else {
                    return Err("WITH must follow a license identifier".to_string());
                }
            }
            _ => break,
        }
    }

    Ok((left, pos))
}

fn parse_primary(tokens: &[Token], pos: usize) -> Result<(SpdxExpr, usize), String> {
    if pos >= tokens.len() {
        return Err("unexpected end of expression".to_string());
    }
    match &tokens[pos] {
        Token::License(id) => Ok((SpdxExpr::License(id.clone()), pos + 1)),
        Token::LParen => {
            let (expr, new_pos) = parse_expr(tokens, pos + 1)?;
            if new_pos >= tokens.len() || tokens[new_pos] != Token::RParen {
                return Err("missing closing parenthesis".to_string());
            }
            Ok((expr, new_pos + 1))
        }
        other => Err(format!("unexpected token: {:?}", other)),
    }
}

// --- License Policy Config ---

pub struct LicensePolicyConfig {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
    pub overrides: Vec<(String, String)>, // (package_name_or_name@version, license)
    pub unknown_policy: String,           // "warn", "deny", "allow"
}

pub struct LicensePolicyViolation {
    pub package: String,
    pub version: String,
    pub license: String,
    pub reason: String,
}

pub struct LicensePolicyResult {
    pub violations: Vec<LicensePolicyViolation>,
    pub warnings: Vec<LicensePolicyViolation>,
    pub total_checked: u64,
    pub passed: u64,
    pub overridden: u64,
}

/// Load license policy from `.betterlicenserc.json` in the project root.
pub fn load_license_policy(project_root: &Path) -> Result<LicensePolicyConfig, String> {
    let config_path = project_root.join(".betterlicenserc.json");
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read .betterlicenserc.json: {}", e))?;

    let allow = extract_json_array_strings(&content, "allow");
    let deny = extract_json_array_strings(&content, "deny");
    let unknown_policy = extract_json_field(&content, "unknown")
        .unwrap_or_else(|| "warn".to_string());

    // Parse overrides object: {"pkg@1.0": "MIT", ...}
    let overrides = extract_json_object_pairs(&content, "override")
        .unwrap_or_default();

    Ok(LicensePolicyConfig {
        allow,
        deny,
        overrides,
        unknown_policy,
    })
}

/// Check all packages in node_modules against the license policy.
pub fn check_license_policy(
    node_modules: &Path,
    policy: &LicensePolicyConfig,
) -> Result<LicensePolicyResult, String> {
    let pkg_dirs = list_packages_in_node_modules(node_modules)?;

    let allowed_set: HashSet<String> = policy.allow.iter().cloned().collect();
    let denied_set: HashSet<String> = policy.deny.iter().cloned().collect();
    let override_map: std::collections::HashMap<String, String> = policy
        .overrides
        .iter()
        .cloned()
        .collect();

    let mut violations = Vec::new();
    let mut warnings = Vec::new();
    let mut total_checked = 0u64;
    let mut passed = 0u64;
    let mut overridden = 0u64;

    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let name = extract_json_field(&content, "name")
            .unwrap_or_else(|| "unknown".to_string());
        let version = extract_json_field(&content, "version")
            .unwrap_or_else(|| "0.0.0".to_string());
        let license_raw = extract_json_field(&content, "license")
            .unwrap_or_else(|| "UNLICENSED".to_string());

        total_checked += 1;

        // Check overrides first (by name or name@version)
        let name_at_version = format!("{}@{}", name, version);
        if override_map.contains_key(&name) || override_map.contains_key(&name_at_version) {
            overridden += 1;
            passed += 1;
            continue;
        }

        // Handle unknown/unlicensed
        if license_raw == "UNLICENSED" || license_raw.is_empty() {
            match policy.unknown_policy.as_str() {
                "deny" => {
                    violations.push(LicensePolicyViolation {
                        package: name,
                        version,
                        license: license_raw,
                        reason: "Unknown/unlicensed package (policy: deny unknown)".to_string(),
                    });
                }
                "warn" => {
                    warnings.push(LicensePolicyViolation {
                        package: name,
                        version,
                        license: license_raw,
                        reason: "Unknown/unlicensed package".to_string(),
                    });
                    passed += 1;
                }
                _ => {
                    passed += 1;
                }
            }
            continue;
        }

        // Parse SPDX expression
        match SpdxExpr::parse(&license_raw) {
            Ok(expr) => {
                // Check deny list first
                if !denied_set.is_empty() && expr.is_denied(&denied_set) {
                    violations.push(LicensePolicyViolation {
                        package: name,
                        version,
                        license: license_raw,
                        reason: "License is in deny list".to_string(),
                    });
                    continue;
                }

                // Check allow list
                if !allowed_set.is_empty() && !expr.is_allowed(&allowed_set) {
                    violations.push(LicensePolicyViolation {
                        package: name,
                        version,
                        license: license_raw,
                        reason: "License is not in allow list".to_string(),
                    });
                    continue;
                }

                passed += 1;
            }
            Err(_) => {
                // Could not parse SPDX — treat as simple string comparison
                if !denied_set.is_empty() && (denied_set.contains(&license_raw) || denied_set.contains(&license_raw.to_uppercase())) {
                    violations.push(LicensePolicyViolation {
                        package: name,
                        version,
                        license: license_raw,
                        reason: "License is in deny list".to_string(),
                    });
                } else if !allowed_set.is_empty() && !allowed_set.contains(&license_raw) && !allowed_set.contains(&license_raw.to_uppercase()) {
                    violations.push(LicensePolicyViolation {
                        package: name,
                        version,
                        license: license_raw,
                        reason: "License is not in allow list".to_string(),
                    });
                } else {
                    passed += 1;
                }
            }
        }
    }

    Ok(LicensePolicyResult {
        violations,
        warnings,
        total_checked,
        passed,
        overridden,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spdx_simple() {
        let expr = SpdxExpr::parse("MIT").unwrap();
        let allowed: HashSet<String> = ["MIT".to_string()].into_iter().collect();
        assert!(expr.is_allowed(&allowed));
    }

    #[test]
    fn test_spdx_or() {
        let expr = SpdxExpr::parse("MIT OR Apache-2.0").unwrap();
        let allowed: HashSet<String> = ["MIT".to_string()].into_iter().collect();
        assert!(expr.is_allowed(&allowed));

        let denied: HashSet<String> = ["MIT".to_string()].into_iter().collect();
        // OR: both must be denied for the whole to be denied
        assert!(!expr.is_denied(&denied));

        let both_denied: HashSet<String> = ["MIT".to_string(), "Apache-2.0".to_string()].into_iter().collect();
        assert!(expr.is_denied(&both_denied));
    }

    #[test]
    fn test_spdx_and() {
        let expr = SpdxExpr::parse("MIT AND Apache-2.0").unwrap();
        let allowed: HashSet<String> = ["MIT".to_string()].into_iter().collect();
        // AND: all must be allowed
        assert!(!expr.is_allowed(&allowed));

        let both: HashSet<String> = ["MIT".to_string(), "Apache-2.0".to_string()].into_iter().collect();
        assert!(expr.is_allowed(&both));
    }

    #[test]
    fn test_spdx_with() {
        let expr = SpdxExpr::parse("Apache-2.0 WITH LLVM-exception").unwrap();
        let allowed: HashSet<String> = ["Apache-2.0".to_string()].into_iter().collect();
        assert!(expr.is_allowed(&allowed));
    }

    #[test]
    fn test_spdx_parenthesized() {
        let expr = SpdxExpr::parse("(MIT OR Apache-2.0) AND BSD-3-Clause").unwrap();
        let allowed: HashSet<String> = ["MIT".to_string(), "BSD-3-Clause".to_string()].into_iter().collect();
        assert!(expr.is_allowed(&allowed));

        let partial: HashSet<String> = ["MIT".to_string()].into_iter().collect();
        assert!(!expr.is_allowed(&partial));
    }

    #[test]
    fn test_spdx_licenses() {
        let expr = SpdxExpr::parse("MIT OR Apache-2.0").unwrap();
        let lics = expr.licenses();
        assert!(lics.contains(&"MIT".to_string()));
        assert!(lics.contains(&"Apache-2.0".to_string()));
    }

    #[test]
    fn test_spdx_denied_and() {
        let expr = SpdxExpr::parse("MIT AND GPL-3.0").unwrap();
        let denied: HashSet<String> = ["GPL-3.0".to_string()].into_iter().collect();
        // AND: any denied -> whole is denied
        assert!(expr.is_denied(&denied));
    }

    #[test]
    fn test_spdx_parse_error() {
        assert!(SpdxExpr::parse("").is_err());
    }
}
