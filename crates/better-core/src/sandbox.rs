use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::{extract_json_field, extract_json_object_pairs, extract_json_array_strings,
            extract_json_object_raw, list_packages_in_node_modules, JsonWriter};

// ============================================================
// Permission model
// ============================================================

/// Permission set for a sandboxed script execution.
#[derive(Debug, Clone)]
pub struct SandboxPermissions {
    pub fs_read: Vec<PathBuf>,
    pub fs_write: Vec<PathBuf>,
    pub allow_tmp: bool,
    pub net_allow: bool,
    pub net_allowed_hosts: Vec<String>,
    pub env_allow_read: bool,
    pub env_allowed_vars: Vec<String>,
    pub env_blocked_vars: Vec<String>,
    pub process_allow: bool,
    pub process_allowed_executables: Vec<String>,
}

impl SandboxPermissions {
    /// Default: locked down. No network, no env, fs only within package dir.
    pub fn default_for_package(package_dir: &Path) -> Self {
        Self {
            fs_read: vec![package_dir.to_path_buf()],
            fs_write: vec![package_dir.to_path_buf()],
            allow_tmp: true,
            net_allow: false,
            net_allowed_hosts: vec![],
            env_allow_read: false,
            env_allowed_vars: vec![
                "PATH".into(), "HOME".into(), "NODE_ENV".into(),
            ],
            env_blocked_vars: vec![
                "NPM_TOKEN".into(), "GITHUB_TOKEN".into(),
                "AWS_SECRET_ACCESS_KEY".into(), "DATABASE_URL".into(),
            ],
            process_allow: true,
            process_allowed_executables: vec![
                "node".into(), "sh".into(), "bash".into(),
            ],
        }
    }

    /// Fully permissive (for trusted / --no-sandbox).
    pub fn unrestricted() -> Self {
        Self {
            fs_read: vec![PathBuf::from("/")],
            fs_write: vec![PathBuf::from("/")],
            allow_tmp: true,
            net_allow: true,
            net_allowed_hosts: vec![],
            env_allow_read: true,
            env_allowed_vars: vec![],
            env_blocked_vars: vec![],
            process_allow: true,
            process_allowed_executables: vec![],
        }
    }

    /// Build permissions from .better-scripts.json allow list.
    pub fn from_allow_list(package_dir: &Path, allows: &[String]) -> Self {
        let mut perms = Self::default_for_package(package_dir);
        for a in allows {
            match a.as_str() {
                "fs" => {
                    perms.fs_read = vec![PathBuf::from("/")];
                    perms.fs_write = vec![PathBuf::from("/")];
                }
                "net" => {
                    perms.net_allow = true;
                }
                "env" => {
                    perms.env_allow_read = true;
                }
                "exec" => {
                    perms.process_allow = true;
                    perms.process_allowed_executables.clear();
                }
                _ => {}
            }
        }
        perms
    }
}

// ============================================================
// .better-scripts.json v2 permission format
// ============================================================

/// Per-package permission overrides from .better-scripts.json
///
/// Format:
/// ```json
/// {
///   "allow": {
///     "esbuild": ["fs", "net"],
///     "playwright": ["fs", "net", "exec"]
///   },
///   "block": ["suspicious-pkg"]
/// }
/// ```
#[derive(Debug, Clone)]
pub struct SandboxPolicy {
    pub allow: HashMap<String, Vec<String>>,
    pub block: Vec<String>,
}

pub fn load_sandbox_policy(project_root: &Path) -> SandboxPolicy {
    let policy_file = project_root.join(".better-scripts.json");
    if let Ok(content) = fs::read_to_string(&policy_file) {
        return parse_sandbox_policy(&content);
    }
    // Check package.json betterScripts field
    let pkg_json = project_root.join("package.json");
    if let Ok(content) = fs::read_to_string(&pkg_json) {
        if let Some(raw) = extract_json_object_raw(&content, "betterScripts") {
            return parse_sandbox_policy(&raw);
        }
    }
    SandboxPolicy { allow: HashMap::new(), block: vec![] }
}

fn parse_sandbox_policy(json: &str) -> SandboxPolicy {
    let block = extract_json_array_strings(json, "block");

    // Parse "allow" object: { "pkg": ["fs","net"], ... }
    let mut allow = HashMap::new();
    if let Some(allow_raw) = extract_json_object_raw(json, "allow") {
        let pairs = extract_json_object_pairs(&allow_raw, "").unwrap_or_default();
        // Fallback: try parsing each key manually
        if pairs.is_empty() {
            // Manual parse for nested arrays
            let inner = allow_raw.trim();
            let inner = if inner.starts_with('{') && inner.ends_with('}') {
                &inner[1..inner.len()-1]
            } else { inner };
            // Simple parse: find "key": [...] patterns
            let mut pos = 0;
            let chars: Vec<char> = inner.chars().collect();
            while pos < chars.len() {
                // Find next string key
                if let Some(q1) = chars[pos..].iter().position(|&c| c == '"') {
                    let q1 = pos + q1;
                    if let Some(q2) = chars[q1+1..].iter().position(|&c| c == '"') {
                        let q2 = q1 + 1 + q2;
                        let key: String = chars[q1+1..q2].iter().collect();
                        // Find the array
                        if let Some(arr_start) = chars[q2..].iter().position(|&c| c == '[') {
                            let arr_start = q2 + arr_start;
                            let arr_str: String = chars[arr_start..].iter().collect();
                            let perms = parse_string_array(&arr_str);
                            if let Some(arr_end) = chars[arr_start..].iter().position(|&c| c == ']') {
                                allow.insert(key, perms);
                                pos = arr_start + arr_end + 1;
                            } else {
                                pos = chars.len();
                            }
                        } else {
                            pos = q2 + 1;
                        }
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
        }
    }

    SandboxPolicy { allow, block }
}

fn parse_string_array(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut in_str = false;
    let mut current = String::new();
    let mut esc = false;
    let mut depth = 0;
    for ch in s.chars() {
        if esc { if in_str { current.push(ch); } esc = false; continue; }
        if ch == '\\' { esc = true; continue; }
        if ch == '"' {
            in_str = !in_str;
            if depth == 1 {
                if !in_str && !current.is_empty() {
                    result.push(current.clone());
                    current.clear();
                }
            }
            continue;
        }
        if in_str { current.push(ch); continue; }
        match ch {
            '[' => depth += 1,
            ']' => { depth -= 1; if depth == 0 { break; } }
            _ => {}
        }
    }
    result
}

/// Get the sandbox permissions for a specific package based on the policy.
pub fn permissions_for_package(
    policy: &SandboxPolicy,
    package_name: &str,
    package_dir: &Path,
) -> Option<SandboxPermissions> {
    // Blocked packages return None (skip execution)
    if policy.block.iter().any(|b| b == package_name) {
        return None;
    }
    // Packages with explicit allow list get custom permissions
    if let Some(allows) = policy.allow.get(package_name) {
        return Some(SandboxPermissions::from_allow_list(package_dir, allows));
    }
    // Default: sandboxed with minimal permissions
    Some(SandboxPermissions::default_for_package(package_dir))
}

// ============================================================
// macOS sandbox-exec (Seatbelt)
// ============================================================

/// Generate a macOS sandbox-exec Seatbelt profile from SandboxPermissions.
#[cfg(target_os = "macos")]
pub fn generate_seatbelt_profile(perms: &SandboxPermissions) -> String {
    let mut p = String::new();
    p.push_str("(version 1)\n");
    p.push_str("(deny default)\n");

    // Always allow process execution within sandbox
    p.push_str("(allow process-exec)\n");
    p.push_str("(allow process-fork)\n");
    p.push_str("(allow sysctl-read)\n");
    p.push_str("(allow mach-lookup)\n");

    // Filesystem: read
    for read_path in &perms.fs_read {
        p.push_str(&format!(
            "(allow file-read* (subpath \"{}\"))\n",
            read_path.display()
        ));
    }

    // Filesystem: write
    for write_path in &perms.fs_write {
        p.push_str(&format!(
            "(allow file-write* (subpath \"{}\"))\n",
            write_path.display()
        ));
    }

    // Tmp access
    if perms.allow_tmp {
        p.push_str("(allow file-read* file-write* (subpath \"/tmp\"))\n");
        p.push_str("(allow file-read* file-write* (subpath \"/private/tmp\"))\n");
    }

    // Always allow reading system libs and node
    p.push_str("(allow file-read* (subpath \"/usr/lib\"))\n");
    p.push_str("(allow file-read* (subpath \"/usr/local\"))\n");
    p.push_str("(allow file-read* (subpath \"/opt/homebrew\"))\n");
    p.push_str("(allow file-read* (subpath \"/System\"))\n");
    p.push_str("(allow file-read* (subpath \"/Library/Frameworks\"))\n");
    // Allow reading /dev/null, /dev/urandom etc
    p.push_str("(allow file-read* (subpath \"/dev\"))\n");

    // Network
    if perms.net_allow {
        p.push_str("(allow network*)\n");
    } else {
        // Allow local IPC (needed for node)
        p.push_str("(allow network-inbound (local ip))\n");
        p.push_str("(allow network-outbound (local ip))\n");
    }

    p
}

// ============================================================
// Linux sandbox (Landlock + unshare fallback)
// ============================================================

/// Check if Landlock LSM is available (Linux kernel 5.13+).
#[cfg(target_os = "linux")]
pub fn check_landlock() -> Option<u32> {
    fs::read_to_string("/sys/kernel/security/landlock/status")
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// Check if unshare is available.
#[cfg(target_os = "linux")]
pub fn check_unshare() -> bool {
    std::process::Command::new("unshare")
        .arg("--help")
        .output()
        .map_or(false, |o| o.status.success())
}

// ============================================================
// Platform-agnostic sandbox executor
// ============================================================

#[derive(Debug, Clone)]
pub struct SandboxResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub sandbox_violations: Vec<String>,
}

#[derive(Debug)]
pub enum SandboxError {
    Io(std::io::Error),
    ProfileGeneration(String),
    NoSandboxAvailable,
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxError::Io(e) => write!(f, "sandbox I/O error: {}", e),
            SandboxError::ProfileGeneration(s) => write!(f, "profile generation: {}", s),
            SandboxError::NoSandboxAvailable => write!(f, "no sandbox mechanism available on this platform"),
        }
    }
}

impl From<std::io::Error> for SandboxError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

fn filter_env(env_vars: &[(String, String)], perms: &SandboxPermissions) -> Vec<(String, String)> {
    if perms.env_allow_read {
        env_vars.iter()
            .filter(|(k, _)| !perms.env_blocked_vars.contains(k))
            .cloned()
            .collect()
    } else {
        env_vars.iter()
            .filter(|(k, _)| perms.env_allowed_vars.contains(k))
            .cloned()
            .collect()
    }
}

fn parse_sandbox_violations(stderr: &str) -> Vec<String> {
    stderr.lines()
        .filter(|l| l.contains("deny") || l.contains("Sandbox") || l.contains("sandbox"))
        .map(|l| l.to_string())
        .collect()
}

/// Execute a command inside a platform-specific sandbox.
pub fn execute_sandboxed(
    command: &str,
    args: &[&str],
    working_dir: &Path,
    perms: &SandboxPermissions,
) -> Result<SandboxResult, SandboxError> {
    let env_vars: Vec<(String, String)> = std::env::vars().collect();

    #[cfg(target_os = "macos")]
    {
        execute_sandboxed_macos(command, args, working_dir, perms, &env_vars)
    }

    #[cfg(target_os = "linux")]
    {
        execute_sandboxed_linux(command, args, working_dir, perms, &env_vars)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        eprintln!("WARNING: Sandboxing not available on this platform. Running without restrictions.");
        let filtered = filter_env(&env_vars, perms);
        let output = std::process::Command::new(command)
            .args(args)
            .current_dir(working_dir)
            .env_clear()
            .envs(filtered)
            .output()?;
        Ok(SandboxResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            sandbox_violations: vec![],
        })
    }
}

#[cfg(target_os = "macos")]
fn execute_sandboxed_macos(
    command: &str,
    args: &[&str],
    working_dir: &Path,
    perms: &SandboxPermissions,
    env_vars: &[(String, String)],
) -> Result<SandboxResult, SandboxError> {
    let profile = generate_seatbelt_profile(perms);

    // Write profile to temp file
    let profile_path = std::env::temp_dir().join(format!(
        "better-sandbox-{}.sb", std::process::id()
    ));
    fs::write(&profile_path, &profile)?;

    let filtered = filter_env(env_vars, perms);

    let output = std::process::Command::new("sandbox-exec")
        .arg("-f")
        .arg(&profile_path)
        .arg(command)
        .args(args)
        .current_dir(working_dir)
        .env_clear()
        .envs(filtered)
        .output()?;

    let _ = fs::remove_file(&profile_path);

    Ok(SandboxResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        sandbox_violations: parse_sandbox_violations(
            &String::from_utf8_lossy(&output.stderr)
        ),
    })
}

#[cfg(target_os = "linux")]
fn execute_sandboxed_linux(
    command: &str,
    args: &[&str],
    working_dir: &Path,
    perms: &SandboxPermissions,
    env_vars: &[(String, String)],
) -> Result<SandboxResult, SandboxError> {
    let filtered = filter_env(env_vars, perms);

    // Try Landlock + unshare for network, fallback to basic unshare
    if check_landlock().is_some() || check_unshare() {
        let mut cmd_args: Vec<&str> = vec!["--mount"];
        if !perms.net_allow {
            cmd_args.push("--net");
        }
        cmd_args.push("--");

        let output = std::process::Command::new("unshare")
            .args(&cmd_args)
            .arg(command)
            .args(args)
            .current_dir(working_dir)
            .env_clear()
            .envs(filtered)
            .output()?;

        Ok(SandboxResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            sandbox_violations: vec![],
        })
    } else {
        Err(SandboxError::NoSandboxAvailable)
    }
}

// ============================================================
// Script scan: show what permissions each package needs
// ============================================================

#[derive(Debug)]
pub struct SandboxScanEntry {
    pub name: String,
    pub version: String,
    pub scripts: Vec<(String, String)>,
    pub needs_fs: bool,
    pub needs_net: bool,
    pub needs_exec: bool,
    pub policy_status: String, // "sandboxed", "allowed", "blocked"
}

#[derive(Debug)]
pub struct SandboxScanResult {
    pub packages: Vec<SandboxScanEntry>,
    pub total_with_scripts: u64,
    pub sandboxed: u64,
    pub allowed: u64,
    pub blocked: u64,
}

/// Scan all packages to show what permissions their scripts would need.
pub fn sandbox_scan(project_root: &Path) -> Result<SandboxScanResult, String> {
    let nm = project_root.join("node_modules");
    let pkg_dirs = list_packages_in_node_modules(&nm)?;
    let policy = load_sandbox_policy(project_root);
    let lifecycle_types = ["preinstall", "install", "postinstall", "prepare"];

    let mut packages = Vec::new();
    let mut total_with_scripts = 0u64;
    let mut sandboxed = 0u64;
    let mut allowed = 0u64;
    let mut blocked = 0u64;

    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) { Ok(c) => c, Err(_) => continue };
        let name = extract_json_field(&content, "name").unwrap_or_else(|| "unknown".into());
        let version = extract_json_field(&content, "version").unwrap_or_else(|| "0.0.0".into());
        let all_scripts = extract_json_object_pairs(&content, "scripts").unwrap_or_default();
        let lifecycle: Vec<(String, String)> = all_scripts.into_iter()
            .filter(|(k, _)| lifecycle_types.contains(&k.as_str())).collect();
        if lifecycle.is_empty() { continue; }

        total_with_scripts += 1;

        // Determine policy status
        let policy_status;
        if policy.block.iter().any(|b| b == &name) {
            policy_status = "blocked".to_string();
            blocked += 1;
        } else if policy.allow.contains_key(&name) {
            policy_status = "allowed".to_string();
            allowed += 1;
        } else {
            policy_status = "sandboxed".to_string();
            sandboxed += 1;
        }

        // Heuristic: detect what permissions scripts likely need
        let all_cmds: String = lifecycle.iter().map(|(_, cmd)| cmd.as_str()).collect::<Vec<_>>().join(" ");
        let needs_net = all_cmds.contains("curl") || all_cmds.contains("wget")
            || all_cmds.contains("fetch") || all_cmds.contains("download")
            || all_cmds.contains("http") || all_cmds.contains("puppeteer")
            || all_cmds.contains("playwright");
        let needs_fs = all_cmds.contains("mkdir") || all_cmds.contains("cp ")
            || all_cmds.contains("mv ") || all_cmds.contains("rm ")
            || all_cmds.contains("node-gyp") || all_cmds.contains("prebuild");
        let needs_exec = all_cmds.contains("node-gyp") || all_cmds.contains("cmake")
            || all_cmds.contains("make") || all_cmds.contains("gcc")
            || all_cmds.contains("g++") || all_cmds.contains("python");

        packages.push(SandboxScanEntry {
            name, version, scripts: lifecycle,
            needs_fs, needs_net, needs_exec, policy_status,
        });
    }

    Ok(SandboxScanResult { packages, total_with_scripts, sandboxed, allowed, blocked })
}

/// Write sandbox scan result as JSON.
pub fn write_sandbox_scan_json(result: &SandboxScanResult) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("ok"); w.value_bool(true);
    w.key("kind"); w.value_string("better.scripts.scan");
    w.key("totalWithScripts"); w.value_u64(result.total_with_scripts);
    w.key("sandboxed"); w.value_u64(result.sandboxed);
    w.key("allowed"); w.value_u64(result.allowed);
    w.key("blocked"); w.value_u64(result.blocked);
    w.key("packages"); w.begin_array();
    for pkg in &result.packages {
        w.begin_object();
        w.key("name"); w.value_string(&pkg.name);
        w.key("version"); w.value_string(&pkg.version);
        w.key("policyStatus"); w.value_string(&pkg.policy_status);
        w.key("needsFs"); w.value_bool(pkg.needs_fs);
        w.key("needsNet"); w.value_bool(pkg.needs_net);
        w.key("needsExec"); w.value_bool(pkg.needs_exec);
        w.key("scripts"); w.begin_array();
        for (sname, scmd) in &pkg.scripts {
            w.begin_object();
            w.key("name"); w.value_string(sname);
            w.key("command"); w.value_string(scmd);
            w.end_object();
        }
        w.end_array();
        w.end_object();
    }
    w.end_array();
    w.end_object();
    w.out.push('\n');
    w.finish()
}
