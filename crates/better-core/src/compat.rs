// crates/better-core/src/compat.rs
// Node.js version compatibility checking

use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct CompatResult {
    pub name: String,
    pub version: String,
    pub node_range: Option<String>,
    pub compatible: bool,
    pub no_engines: bool,
}

/// Check if a semver version satisfies a range string (simplified).
/// Supports: >=X.Y.Z, >X, <=X, <X, ^X, ~X, exact, *, ||
pub fn satisfies(node_version: &str, range: &str) -> bool {
    if range.is_empty() || range == "*" {
        return true;
    }

    let clean_ver = node_version.trim_start_matches('v');
    let ver_num = parse_semver(clean_ver);

    // Handle OR ranges
    for or_part in range.split("||") {
        let part = or_part.trim();
        if satisfies_and(ver_num, part) {
            return true;
        }
    }
    false
}

fn satisfies_and(ver: (u64, u64, u64), range: &str) -> bool {
    for part in range.split_whitespace() {
        if !satisfies_single(ver, part) {
            return false;
        }
    }
    true
}

fn satisfies_single(ver: (u64, u64, u64), part: &str) -> bool {
    if part.is_empty() || part == "*" {
        return true;
    }

    let (op_len, op) = extract_op(part);
    let ver_str = &part[op_len..];
    let req = parse_semver(ver_str);

    let (vMaj, vMin, vPat) = ver;
    let (rMaj, rMin, rPat) = req;

    match op {
        ">=" => ver >= req,
        ">"  => ver > req,
        "<=" => ver <= req,
        "<"  => ver < req,
        "!=" => ver != req,
        "^"  => vMaj == rMaj && ver >= req,
        "~"  => vMaj == rMaj && vMin == rMin && ver >= req,
        _    => vMaj == rMaj, // exact major match for unspecified
    }
}

fn extract_op(s: &str) -> (usize, &str) {
    if s.starts_with(">=") { return (2, ">="); }
    if s.starts_with("<=") { return (2, "<="); }
    if s.starts_with("!=") { return (2, "!="); }
    if s.starts_with('>') { return (1, ">"); }
    if s.starts_with('<') { return (1, "<"); }
    if s.starts_with('^') { return (1, "^"); }
    if s.starts_with('~') { return (1, "~"); }
    if s.starts_with('=') { return (1, "="); }
    (0, "")
}

fn parse_semver(v: &str) -> (u64, u64, u64) {
    let clean = v.split('-').next().unwrap_or(v); // strip pre-release
    let parts: Vec<u64> = clean.split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    (
        parts.get(0).copied().unwrap_or(0),
        parts.get(1).copied().unwrap_or(0),
        parts.get(2).copied().unwrap_or(0),
    )
}

/// Check all installed packages against a target Node.js version.
pub fn check_compat(project_root: &Path, target_version: &str) -> Result<Vec<CompatResult>, String> {
    let nm_path = project_root.join("node_modules");
    if !nm_path.exists() {
        return Err("node_modules not found. Run 'better install' first.".to_string());
    }

    let entries = fs::read_dir(&nm_path)
        .map_err(|e| format!("Cannot read node_modules: {}", e))?;

    let mut results = Vec::new();

    for entry in entries.flatten() {
        let entry_name = entry.file_name().to_string_lossy().to_string();
        if entry_name.starts_with('.') { continue; }

        let packages = if entry_name.starts_with('@') {
            // Scoped package directory
            match fs::read_dir(entry.path()) {
                Ok(scoped) => scoped.flatten()
                    .map(|e| {
                        let n = format!("{}/{}", entry_name, e.file_name().to_string_lossy());
                        (n, e.path())
                    })
                    .collect::<Vec<_>>(),
                Err(_) => vec![],
            }
        } else {
            vec![(entry_name.clone(), entry.path())]
        };

        for (name, pkg_dir) in packages {
            let pkg_json_path = pkg_dir.join("package.json");
            if let Ok(content) = fs::read_to_string(&pkg_json_path) {
                let version = extract_field(&content, "version").unwrap_or("?".to_string());
                let node_range = extract_engines_node(&content);

                let compatible = match &node_range {
                    Some(range) => satisfies(target_version, range),
                    None => true, // assume compatible if no engines field
                };

                results.push(CompatResult {
                    name,
                    version,
                    node_range,
                    compatible,
                    no_engines: false,
                });
            }
        }
    }

    Ok(results)
}

fn extract_field(json: &str, field: &str) -> Option<String> {
    let key = format!("\"{}\"", field);
    let pos = json.find(&key)?;
    let after = &json[pos + key.len()..];
    let colon = after.find(':')?;
    let val = after[colon + 1..].trim_start();
    if val.starts_with('"') {
        let inner = &val[1..];
        let end = inner.find('"')?;
        Some(inner[..end].to_string())
    } else {
        None
    }
}

fn extract_engines_node(json: &str) -> Option<String> {
    let engines_pos = json.find("\"engines\"")?;
    let after_engines = &json[engines_pos..];
    let brace = after_engines.find('{')?;
    let inner = &after_engines[brace + 1..];
    let close = inner.find('}')?;
    let engines_body = &inner[..close];

    extract_field(&format!("{{{}}}", engines_body), "node")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn satisfies_wildcard_always_true() {
        assert!(satisfies("20.0.0", "*"));
        assert!(satisfies("18.0.0", ""));
    }

    #[test]
    fn satisfies_gte_operator() {
        assert!(satisfies("20.0.0", ">=18"));
        assert!(!satisfies("16.0.0", ">=18"));
    }

    #[test]
    fn satisfies_gt_operator() {
        assert!(satisfies("20.0.0", ">18"));
        assert!(!satisfies("18.0.0", ">18"));
    }

    #[test]
    fn satisfies_exact_major_match() {
        // Without an operator, only major version must match
        assert!(satisfies("18.5.0", "18.0.0"));
        assert!(!satisfies("20.0.0", "18.0.0"));
    }

    #[test]
    fn satisfies_or_range() {
        assert!(satisfies("16.0.0", ">=16 || >=18"));
        assert!(satisfies("20.0.0", ">=16 || >=18"));
        assert!(!satisfies("14.0.0", ">=16 || >=18"));
    }

    #[test]
    fn satisfies_caret_range() {
        assert!(satisfies("18.5.0", "^18.0.0"));
        assert!(!satisfies("19.0.0", "^18.0.0"));
    }
}
