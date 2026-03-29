use super::*;
use std::path::Path;

/// Extract context from a JS/TS package
pub fn extract_js_context(
    package_root: &Path,
    name: &str,
    version: &str,
) -> Result<PackageContext, String> {
    let mut exports = Vec::new();
    let mut patterns = Vec::new();
    let mut gotchas = Vec::new();
    let mut description = String::new();
    let mut types_summary = None;

    // 1. Parse .d.ts files for exported type signatures
    let dts_candidates = [
        package_root.join("index.d.ts"),
        package_root.join("dist/index.d.ts"),
        package_root.join("types/index.d.ts"),
        package_root.join("lib/index.d.ts"),
    ];
    for dts_path in &dts_candidates {
        if dts_path.exists() {
            if let Ok(dts_exports) = parse_dts(dts_path) {
                exports.extend(dts_exports);
            }
            break;
        }
    }

    // 2. Parse README for quick_start, patterns, gotchas
    let readme = find_readme(package_root);
    let (quick_start, readme_patterns, readme_gotchas) = if let Some(readme_path) = readme {
        extract_from_readme(&readme_path)
    } else {
        (String::new(), Vec::new(), Vec::new())
    };
    patterns.extend(readme_patterns);
    gotchas.extend(readme_gotchas);

    // 3. Parse CHANGELOG.md for breaking changes
    let changelog_path = package_root.join("CHANGELOG.md");
    if changelog_path.exists() {
        if let Ok(breaking) = extract_breaking_changes(&changelog_path) {
            gotchas.extend(breaking);
        }
    }

    // 4. Generate types summary
    if !exports.is_empty() {
        types_summary = Some(generate_types_summary(&exports));
    }

    // 5. Read description from package.json
    let pkg_json_path = package_root.join("package.json");
    let mut deps = Vec::new();
    if pkg_json_path.exists() {
        let content = std::fs::read_to_string(&pkg_json_path).unwrap_or_default();
        if let Some(desc) = crate::extract_json_field(&content, "description") {
            description = desc;
        }
        // Extract dependency names
        if let Ok(dep_pairs) = crate::extract_json_object_pairs(&content, "dependencies") {
            for (dep_name, _) in dep_pairs {
                deps.push(dep_name);
            }
        }
    }

    let ctx = PackageContext {
        name: name.to_string(),
        version: version.to_string(),
        ecosystem: "npm".to_string(),
        description,
        exports,
        quick_start,
        patterns,
        gotchas,
        types_summary,
        dependencies: deps,
        generated_at: crate::chrono_now(),
        markdown: String::new(),
    };

    let markdown = template::render_context(&ctx);
    Ok(PackageContext { markdown, ..ctx })
}

/// Parse .d.ts file for exported symbols
fn parse_dts(path: &Path) -> Result<Vec<ExportedSymbol>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;

    let mut symbols = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if !line.starts_with("export ") {
            continue;
        }

        let rest = &line["export ".len()..];

        if rest.starts_with("function ") {
            if let Some(sym) = parse_function_export(rest) {
                symbols.push(sym);
            }
        } else if rest.starts_with("class ") {
            if let Some(sym) = parse_class_export(rest) {
                symbols.push(sym);
            }
        } else if rest.starts_with("interface ") {
            if let Some(sym) = parse_interface_export(rest) {
                symbols.push(sym);
            }
        } else if rest.starts_with("const ") || rest.starts_with("let ") || rest.starts_with("var ") {
            if let Some(sym) = parse_variable_export(rest) {
                symbols.push(sym);
            }
        } else if rest.starts_with("type ") {
            if let Some(sym) = parse_type_export(rest) {
                symbols.push(sym);
            }
        } else if rest.starts_with("enum ") {
            if let Some(sym) = parse_enum_export(rest) {
                symbols.push(sym);
            }
        } else if rest.starts_with("default ") {
            let inner = &rest["default ".len()..];
            if inner.starts_with("function ") {
                if let Some(mut sym) = parse_function_export(inner) {
                    if sym.name.is_empty() {
                        sym.name = "default".to_string();
                    }
                    symbols.push(sym);
                }
            } else if inner.starts_with("class ") {
                if let Some(mut sym) = parse_class_export(inner) {
                    if sym.name.is_empty() {
                        sym.name = "default".to_string();
                    }
                    symbols.push(sym);
                }
            }
        }
    }

    Ok(symbols)
}

fn parse_function_export(line: &str) -> Option<ExportedSymbol> {
    // "function foo(bar: string, baz?: number): Promise<Result>"
    let rest = line.strip_prefix("function ")?;
    let paren = rest.find('(')?;
    let name = rest[..paren].trim().to_string();

    // Extract the full signature up to semicolon or end of line
    let signature = line.trim_end_matches(';').to_string();

    // Extract return type after last ):
    let return_type = extract_return_type(rest);

    // Extract params between parens
    let params = extract_params(rest);

    Some(ExportedSymbol {
        name,
        kind: SymbolKind::Function,
        signature: Some(signature),
        description: None,
        params,
        return_type,
    })
}

fn parse_class_export(line: &str) -> Option<ExportedSymbol> {
    let rest = line.strip_prefix("class ")?;
    let name_end = rest.find(|c: char| c == '{' || c == ' ' || c == '<')?;
    let name = rest[..name_end].trim().to_string();
    Some(ExportedSymbol {
        name,
        kind: SymbolKind::Class,
        signature: Some(line.trim_end_matches('{').trim().to_string()),
        description: None,
        params: Vec::new(),
        return_type: None,
    })
}

fn parse_interface_export(line: &str) -> Option<ExportedSymbol> {
    let rest = line.strip_prefix("interface ")?;
    let name_end = rest.find(|c: char| c == '{' || c == ' ' || c == '<')?;
    let name = rest[..name_end].trim().to_string();
    Some(ExportedSymbol {
        name,
        kind: SymbolKind::Interface,
        signature: Some(line.trim_end_matches('{').trim().to_string()),
        description: None,
        params: Vec::new(),
        return_type: None,
    })
}

fn parse_variable_export(line: &str) -> Option<ExportedSymbol> {
    // "const FOO: string = ..." or "const FOO: Type;"
    let rest = if line.starts_with("const ") {
        &line["const ".len()..]
    } else if line.starts_with("let ") {
        &line["let ".len()..]
    } else {
        &line["var ".len()..]
    };

    let name_end = rest.find(|c: char| c == ':' || c == '=' || c == ';')?;
    let name = rest[..name_end].trim().to_string();

    let return_type = if let Some(colon_pos) = rest.find(':') {
        let after = &rest[colon_pos + 1..];
        let end = after.find(|c: char| c == '=' || c == ';').unwrap_or(after.len());
        Some(after[..end].trim().to_string())
    } else {
        None
    };

    Some(ExportedSymbol {
        name,
        kind: SymbolKind::Constant,
        signature: Some(line.trim_end_matches(';').to_string()),
        description: None,
        params: Vec::new(),
        return_type,
    })
}

fn parse_type_export(line: &str) -> Option<ExportedSymbol> {
    let rest = line.strip_prefix("type ")?;
    let name_end = rest.find(|c: char| c == '=' || c == '<' || c == ' ')?;
    let name = rest[..name_end].trim().to_string();
    Some(ExportedSymbol {
        name,
        kind: SymbolKind::Type,
        signature: Some(line.trim_end_matches(';').to_string()),
        description: None,
        params: Vec::new(),
        return_type: None,
    })
}

fn parse_enum_export(line: &str) -> Option<ExportedSymbol> {
    let rest = line.strip_prefix("enum ")?;
    let name_end = rest.find(|c: char| c == '{' || c == ' ')?;
    let name = rest[..name_end].trim().to_string();
    Some(ExportedSymbol {
        name,
        kind: SymbolKind::Enum,
        signature: Some(line.trim_end_matches('{').trim().to_string()),
        description: None,
        params: Vec::new(),
        return_type: None,
    })
}

fn extract_return_type(sig: &str) -> Option<String> {
    // Find the last "):" pattern
    let mut depth = 0i32;
    let mut last_close = None;
    for (i, ch) in sig.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    last_close = Some(i);
                }
            }
            _ => {}
        }
    }
    let close = last_close?;
    let after = &sig[close + 1..];
    let colon = after.find(':')?;
    let ret = after[colon + 1..].trim().trim_end_matches(';').trim();
    if ret.is_empty() {
        None
    } else {
        Some(ret.to_string())
    }
}

fn extract_params(sig: &str) -> Vec<ParamInfo> {
    let open = match sig.find('(') {
        Some(i) => i,
        None => return Vec::new(),
    };
    // Find matching close paren
    let mut depth = 0i32;
    let mut close = sig.len();
    for (i, ch) in sig[open..].char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    close = open + i;
                    break;
                }
            }
            _ => {}
        }
    }
    let params_str = &sig[open + 1..close];
    if params_str.trim().is_empty() {
        return Vec::new();
    }

    // Split by commas (respecting angle brackets and parens)
    let mut params = Vec::new();
    let mut current = String::new();
    let mut angle = 0i32;
    let mut paren = 0i32;
    for ch in params_str.chars() {
        match ch {
            '<' => { angle += 1; current.push(ch); }
            '>' => { angle -= 1; current.push(ch); }
            '(' => { paren += 1; current.push(ch); }
            ')' => { paren -= 1; current.push(ch); }
            ',' if angle == 0 && paren == 0 => {
                params.push(parse_single_param(current.trim()));
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        params.push(parse_single_param(current.trim()));
    }
    params
}

fn parse_single_param(param: &str) -> ParamInfo {
    let optional = param.contains('?');
    let cleaned = param.replace('?', "");
    let parts: Vec<&str> = cleaned.splitn(2, ':').collect();
    let name = parts[0].trim().to_string();
    let type_str = parts.get(1).map(|t| t.trim().to_string());
    ParamInfo {
        name,
        type_str,
        optional,
        default: None,
        description: None,
    }
}

fn find_readme(package_root: &Path) -> Option<std::path::PathBuf> {
    let candidates = ["README.md", "readme.md", "Readme.md", "README.MD", "README"];
    for name in &candidates {
        let p = package_root.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn extract_from_readme(
    readme_path: &Path,
) -> (String, Vec<UsagePattern>, Vec<String>) {
    let content = match std::fs::read_to_string(readme_path) {
        Ok(c) => c,
        Err(_) => return (String::new(), Vec::new(), Vec::new()),
    };

    let mut quick_start = String::new();
    let mut patterns = Vec::new();
    let mut gotchas = Vec::new();

    // Extract code blocks
    let mut in_code_block = false;
    let mut code_lang = String::new();
    let mut code_buf = String::new();
    let mut last_heading = String::new();
    let mut first_code_found = false;

    for line in content.lines() {
        if line.starts_with("```") {
            if in_code_block {
                // End of code block
                in_code_block = false;
                if !code_buf.trim().is_empty() {
                    let lang = if code_lang.is_empty() {
                        "javascript".to_string()
                    } else {
                        code_lang.clone()
                    };

                    if !first_code_found {
                        quick_start = code_buf.trim().to_string();
                        first_code_found = true;
                    }

                    let heading_lower = last_heading.to_lowercase();
                    if heading_lower.contains("usage")
                        || heading_lower.contains("example")
                        || heading_lower.contains("quick start")
                        || heading_lower.contains("getting started")
                    {
                        patterns.push(UsagePattern {
                            title: last_heading.clone(),
                            code: code_buf.trim().to_string(),
                            language: lang,
                        });
                    }
                }
                code_buf.clear();
                code_lang.clear();
            } else {
                // Start of code block
                in_code_block = true;
                code_lang = line.trim_start_matches('`').to_string();
                if code_lang.contains(' ') {
                    code_lang = code_lang.split_whitespace().next().unwrap_or("").to_string();
                }
            }
        } else if in_code_block {
            if !code_buf.is_empty() {
                code_buf.push('\n');
            }
            code_buf.push_str(line);
        } else if line.starts_with('#') {
            last_heading = line.trim_start_matches('#').trim().to_string();
        } else {
            // Look for gotcha/warning patterns
            let lower = line.to_lowercase();
            if lower.contains("breaking change")
                || lower.contains("deprecat")
                || lower.contains("⚠")
                || lower.contains("warning:")
                || lower.contains("note:")
                || lower.contains("important:")
            {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() && trimmed.len() > 10 {
                    gotchas.push(trimmed);
                }
            }
        }
    }

    // Limit patterns to first 5
    patterns.truncate(5);
    gotchas.truncate(10);

    (quick_start, patterns, gotchas)
}

fn extract_breaking_changes(changelog_path: &Path) -> Result<Vec<String>, String> {
    let content = std::fs::read_to_string(changelog_path)
        .map_err(|e| format!("failed to read CHANGELOG: {}", e))?;

    let mut breaking = Vec::new();
    let mut in_latest_version = false;
    let mut found_first_version = false;

    for line in content.lines() {
        // Detect version headings (## x.y.z or ## [x.y.z])
        if line.starts_with("## ") {
            if !found_first_version {
                found_first_version = true;
                in_latest_version = true;
                continue;
            } else {
                // Second version heading = stop
                break;
            }
        }

        if in_latest_version {
            let lower = line.to_lowercase();
            if lower.contains("breaking") || lower.contains("BREAKING") {
                let trimmed = line.trim().trim_start_matches('-').trim().to_string();
                if !trimmed.is_empty() {
                    breaking.push(trimmed);
                }
            }
        }
    }

    Ok(breaking)
}

fn generate_types_summary(exports: &[ExportedSymbol]) -> String {
    let mut summary = String::new();
    for sym in exports {
        if let Some(ref sig) = sym.signature {
            summary.push_str("- `");
            summary.push_str(sig);
            summary.push_str("`\n");
        } else {
            summary.push_str(&format!("- {} `{}`\n", sym.kind, sym.name));
        }
    }
    summary
}
