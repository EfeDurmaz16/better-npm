use std::fs;
use std::path::Path;
use std::time::Instant;

use crate::types::*;
use crate::{extract_json_field, extract_json_object_pairs, read_package_json_scripts, VERSION};
use crate::outdated::{parse_semver, check_semver_range};

// === Phase C: Developer Tool Features ===

// --- C.3: Exec (TypeScript/JS runner) ---

pub fn exec_script(project_root: &Path, script_path: &str, extra_args: &[String]) -> Result<ScriptRunResult, String> {
    let started = Instant::now();
    let bin_dir = project_root.join("node_modules").join(".bin");
    let path_var = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), path_var);

    let is_ts = script_path.ends_with(".ts") || script_path.ends_with(".tsx");

    // Try runners in order of preference: tsx > esbuild-runner > swc-node > ts-node > node --experimental-strip-types
    let (runner, runner_args): (String, Vec<String>) = if is_ts {
        if bin_dir.join("tsx").exists() {
            ("tsx".into(), vec![script_path.to_string()])
        } else if bin_dir.join("esbuild-runner").exists() {
            ("esbuild-runner".into(), vec![script_path.to_string()])
        } else if bin_dir.join("swc-node").exists() {
            ("swc-node".into(), vec![script_path.to_string()])
        } else if bin_dir.join("ts-node").exists() {
            ("ts-node".into(), vec![script_path.to_string()])
        } else {
            ("node".into(), vec!["--experimental-strip-types".to_string(), script_path.to_string()])
        }
    } else {
        ("node".into(), vec![script_path.to_string()])
    };

    let mut cmd_args: Vec<String> = runner_args;
    cmd_args.extend_from_slice(extra_args);

    let status = std::process::Command::new(&runner)
        .args(&cmd_args)
        .current_dir(project_root)
        .env("PATH", &new_path)
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .stdin(std::process::Stdio::inherit())
        .status()
        .map_err(|e| format!("Failed to exec: {}", e))?;

    Ok(ScriptRunResult {
        script_name: script_path.to_string(),
        command: format!("{} {}", runner, cmd_args.join(" ")),
        exit_code: status.code().unwrap_or(-1),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

// --- C.4: Env Info ---

pub fn env_info(project_root: &Path) -> EnvInfo {
    let node_version = std::process::Command::new("node")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_else(|| "not found".to_string())
        .trim().to_string();

    let npm_version = std::process::Command::new("npm")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_else(|| "not found".to_string())
        .trim().to_string();

    let pkg_json = project_root.join("package.json");
    let content = fs::read_to_string(&pkg_json).unwrap_or_default();
    let project_name = extract_json_field(&content, "name");
    let project_version = extract_json_field(&content, "version");
    let engines = extract_json_field(&content, "engines");

    EnvInfo {
        node_version,
        npm_version,
        better_version: VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        project_name,
        project_version,
        engines,
    }
}

pub fn env_check(project_root: &Path) -> Result<EnvCheckResult, String> {
    let info = env_info(project_root);
    let pkg_json = project_root.join("package.json");
    let content = fs::read_to_string(&pkg_json).unwrap_or_default();
    let engines = extract_json_object_pairs(&content, "engines").unwrap_or_default();

    if engines.is_empty() {
        return Ok(EnvCheckResult { checks: Vec::new(), all_ok: true });
    }

    let mut checks = Vec::new();
    for (tool, constraint) in &engines {
        let current_ver = match tool.as_str() {
            "node" => &info.node_version,
            "npm" => &info.npm_version,
            _ => continue,
        };
        let parsed = parse_semver(current_ver);
        let satisfied = match &parsed {
            Some(v) => check_semver_range(v, constraint),
            None => false,
        };
        checks.push(EnvCheckEntry {
            tool: tool.clone(),
            current: current_ver.clone(),
            required: constraint.clone(),
            satisfied,
        });
    }

    let all_ok = checks.iter().all(|c| c.satisfied);
    Ok(EnvCheckResult { checks, all_ok })
}

/// Load environment variables from .env and .env.local files.
/// Later files override earlier ones. Skips comments and blank lines.
pub fn load_dotenv(project_root: &Path) -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = Vec::new();
    for name in &[".env", ".env.local"] {
        let path = project_root.join(name);
        if let Ok(content) = fs::read_to_string(&path) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') { continue; }
                if let Some(eq_pos) = line.find('=') {
                    let key = line[..eq_pos].trim().to_string();
                    let mut val = line[eq_pos + 1..].trim().to_string();
                    // Strip surrounding quotes
                    if (val.starts_with('"') && val.ends_with('"'))
                        || (val.starts_with('\'') && val.ends_with('\''))
                    {
                        val = val[1..val.len() - 1].to_string();
                    }
                    if !key.is_empty() {
                        // Remove existing entry for same key so later file wins
                        vars.retain(|(k, _)| k != &key);
                        vars.push((key, val));
                    }
                }
            }
        }
    }
    vars
}

// --- C.1: Watch Mode ---

/// Like run_script() but returns a Child handle instead of waiting.
fn spawn_script(project_root: &Path, script_name: &str, extra_args: &[String]) -> Result<std::process::Child, String> {
    let scripts = read_package_json_scripts(project_root)?;
    let command = scripts.iter()
        .find(|(n, _)| n == script_name)
        .map(|(_, c)| c.clone())
        .ok_or_else(|| format!("Missing script: \"{}\"", script_name))?;

    let bin_dir = project_root.join("node_modules").join(".bin");
    let path_var = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), path_var);

    let mut full_cmd = command;
    if !extra_args.is_empty() {
        full_cmd.push(' ');
        full_cmd.push_str(&extra_args.join(" "));
    }

    let dotenv_vars = load_dotenv(project_root);
    let mut cmd = std::process::Command::new("sh");
    cmd.args(["-c", &full_cmd])
        .current_dir(project_root)
        .env("PATH", &new_path)
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .stdin(std::process::Stdio::inherit());
    for (k, v) in &dotenv_vars {
        cmd.env(k, v);
    }
    cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))
}

/// Run a script in watch mode: execute once, then re-run on file changes.
pub fn run_script_watch(
    project_root: &Path,
    script_name: &str,
    extra_args: &[String],
    debounce_ms: u64,
) -> Result<(), String> {
    use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
    use std::sync::mpsc;
    use std::time::Duration;

    // Initial run
    eprintln!("[better] starting '{}' in watch mode...", script_name);
    let mut child = spawn_script(project_root, script_name, extra_args)?;

    // Set up file watcher
    let (tx, rx) = mpsc::channel();
    let mut watcher = RecommendedWatcher::new(tx, Config::default())
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

    // Watch common source directories
    for dir in &["src", "lib", "app"] {
        let p = project_root.join(dir);
        if p.exists() {
            let _ = watcher.watch(&p, RecursiveMode::Recursive);
        }
    }

    // Watch root-level source files
    for pattern in &["*.js", "*.ts", "*.json", "*.mjs", "*.mts"] {
        if let Ok(entries) = fs::read_dir(project_root) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.ends_with(&pattern[1..]) && !name.starts_with('.') {
                    let _ = watcher.watch(&entry.path(), RecursiveMode::NonRecursive);
                }
            }
        }
    }

    let debounce = Duration::from_millis(debounce_ms);
    loop {
        match rx.recv() {
            Ok(_event) => {
                // Debounce: drain remaining events within the window
                let deadline = Instant::now() + debounce;
                while Instant::now() < deadline {
                    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(_) => continue,
                        Err(_) => break,
                    }
                }

                eprintln!("[better] restarting '{}'...", script_name);

                // Kill old child
                let _ = child.kill();
                let _ = child.wait();

                // Re-spawn
                match spawn_script(project_root, script_name, extra_args) {
                    Ok(c) => child = c,
                    Err(e) => {
                        eprintln!("[better] error: {}", e);
                        continue;
                    }
                }
            }
            Err(_) => break,
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_dotenv_parses_simple_key_value() {
        let tmp = std::env::temp_dir().join("env-test-dotenv");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join(".env"), "FOO=bar\nBAZ=qux\n").unwrap();
        let vars = load_dotenv(&tmp);
        assert!(vars.iter().any(|(k, v)| k == "FOO" && v == "bar"));
        assert!(vars.iter().any(|(k, v)| k == "BAZ" && v == "qux"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_dotenv_ignores_comments() {
        let tmp = std::env::temp_dir().join("env-test-comments");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join(".env"), "# comment\nKEY=val\n").unwrap();
        let vars = load_dotenv(&tmp);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].0, "KEY");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_dotenv_strips_quotes() {
        let tmp = std::env::temp_dir().join("env-test-quotes");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join(".env"), "KEY=\"quoted value\"\n").unwrap();
        let vars = load_dotenv(&tmp);
        assert_eq!(vars[0].1, "quoted value");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_dotenv_empty_dir_returns_empty() {
        let vars = load_dotenv(std::path::Path::new("/nonexistent-env-project"));
        assert!(vars.is_empty());
    }

    #[test]
    fn env_info_returns_platform() {
        let tmp = std::env::temp_dir().join("env-test-info");
        std::fs::create_dir_all(&tmp).unwrap();
        let info = env_info(&tmp);
        assert!(!info.platform.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_dotenv_local_overrides_base() {
        let tmp = std::env::temp_dir().join("env-test-override");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join(".env"), "KEY=base\n").unwrap();
        std::fs::write(tmp.join(".env.local"), "KEY=override\n").unwrap();
        let vars = load_dotenv(&tmp);
        let val = vars.iter().find(|(k, _)| k == "KEY").map(|(_, v)| v.as_str());
        assert_eq!(val, Some("override"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_dotenv_strips_single_quotes() {
        let tmp = std::env::temp_dir().join("env-test-squotes");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join(".env"), "KEY='single quoted'\n").unwrap();
        let vars = load_dotenv(&tmp);
        assert_eq!(vars[0].1, "single quoted");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_dotenv_skips_blank_lines() {
        let tmp = std::env::temp_dir().join("env-test-blanks");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join(".env"), "\n\nA=1\n\nB=2\n").unwrap();
        let vars = load_dotenv(&tmp);
        assert_eq!(vars.len(), 2);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_dotenv_no_key_before_equals_is_skipped() {
        let tmp = std::env::temp_dir().join("env-test-nokey");
        std::fs::create_dir_all(&tmp).unwrap();
        // "=value" has an empty key; should be skipped
        std::fs::write(tmp.join(".env"), "=value\nVALID=yes\n").unwrap();
        let vars = load_dotenv(&tmp);
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].0, "VALID");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_dotenv_value_with_equals_in_it() {
        let tmp = std::env::temp_dir().join("env-test-equals-in-val");
        std::fs::create_dir_all(&tmp).unwrap();
        // Only the first '=' is the separator
        std::fs::write(tmp.join(".env"), "URL=http://x.com?a=1&b=2\n").unwrap();
        let vars = load_dotenv(&tmp);
        assert_eq!(vars[0].1, "http://x.com?a=1&b=2");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn env_info_contains_better_version() {
        let tmp = std::env::temp_dir().join("env-test-version");
        std::fs::create_dir_all(&tmp).unwrap();
        let info = env_info(&tmp);
        assert!(!info.better_version.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
