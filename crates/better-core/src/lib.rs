use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub mod types;
pub use types::*;

pub mod license;
pub use license::*;

pub mod doctor;
pub use doctor::*;

pub mod benchmark;
pub use benchmark::*;

pub mod hooks;
pub use hooks::*;

pub mod init;
pub use init::*;

pub mod sbom;
pub use sbom::*;

pub mod policy;
pub use policy::*;

pub mod workspace;
pub use workspace::*;

pub mod audit;
pub use audit::*;

pub mod scripts;
pub use scripts::*;

pub mod lock;
pub use lock::*;

pub mod lockfile;
pub use lockfile::*;

pub mod lock_merge;
pub use lock_merge::*;

pub mod npmrc;
pub use npmrc::*;

pub mod outdated;
pub use outdated::*;

pub mod cache;
pub use cache::*;

pub mod why;
pub use why::*;

pub mod dedupe;
pub use dedupe::*;

pub mod env;
pub use env::*;

pub mod cas;
pub use cas::*;

pub mod fetch;
pub use fetch::*;

pub mod analyze;
pub use analyze::*;

pub mod engine;

pub mod binlinks;
pub use binlinks::*;

pub mod progress;
pub use progress::*;

pub mod strict;
pub use strict::*;


pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// --- JSON writer (no dependencies) ---

pub struct JsonWriter {
    pub out: String,
    stack_first: Vec<bool>,
    after_key: bool,
}

impl JsonWriter {
    pub fn new() -> Self {
        Self {
            out: String::new(),
            stack_first: Vec::new(),
            after_key: false,
        }
    }

    pub fn finish(self) -> String {
        self.out
    }

    fn push_comma_if_needed(&mut self) {
        if let Some(top) = self.stack_first.last_mut() {
            if !*top {
                self.out.push(',');
            } else {
                *top = false;
            }
        }
    }

    pub fn begin_object(&mut self) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push('{');
        self.stack_first.push(true);
    }

    pub fn end_object(&mut self) {
        self.out.push('}');
        self.stack_first.pop();
    }

    pub fn begin_array(&mut self) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push('[');
        self.stack_first.push(true);
    }

    pub fn end_array(&mut self) {
        self.out.push(']');
        self.stack_first.pop();
    }

    pub fn key(&mut self, k: &str) {
        self.push_comma_if_needed();
        self.string(k);
        self.out.push(':');
        self.after_key = true;
    }

    fn raw_string_escaped(&mut self, s: &str) {
        for ch in s.chars() {
            match ch {
                '"' => self.out.push_str("\\\""),
                '\\' => self.out.push_str("\\\\"),
                '\n' => self.out.push_str("\\n"),
                '\r' => self.out.push_str("\\r"),
                '\t' => self.out.push_str("\\t"),
                c if c.is_control() => {
                    use std::fmt::Write;
                    write!(&mut self.out, "\\u{:04x}", c as u32).ok();
                }
                c => self.out.push(c),
            }
        }
    }

    fn string(&mut self, s: &str) {
        self.out.push('"');
        self.raw_string_escaped(s);
        self.out.push('"');
    }

    pub fn value_string(&mut self, s: &str) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.string(s);
    }

    pub fn value_bool(&mut self, v: bool) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push_str(if v { "true" } else { "false" });
    }

    pub fn value_null(&mut self) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push_str("null");
    }

    pub fn value_u64(&mut self, v: u64) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push_str(&v.to_string());
    }

    pub fn value_i64(&mut self, v: i64) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push_str(&v.to_string());
    }

    pub fn value_f64(&mut self, v: f64) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        if v.is_finite() {
            self.out.push_str(&v.to_string());
        } else {
            self.out.push_str("null");
        }
    }
}

// --- Filesystem helpers ---

#[cfg(unix)]
pub fn identity_key(md: &fs::Metadata) -> (u64, u64, bool) {
    use std::os::unix::fs::MetadataExt;
    let dev = md.dev();
    let ino = md.ino();
    let reliable = dev != 0 && ino != 0;
    (dev, ino, reliable)
}

#[cfg(windows)]
pub fn identity_key(md: &fs::Metadata) -> (u64, u64, bool) {
    use std::os::windows::fs::MetadataExt;
    let vol = md.volume_serial_number().unwrap_or(0) as u64;
    let idx = md.file_index().unwrap_or(0);
    let reliable = vol != 0 && idx != 0;
    (vol, idx, reliable)
}

#[cfg(not(any(unix, windows)))]
pub fn identity_key(_md: &fs::Metadata) -> (u64, u64, bool) {
    (0, 0, false)
}

pub fn stable_list_dir(dir: &Path) -> std::io::Result<Vec<fs::DirEntry>> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    Ok(entries)
}

pub fn physical_len(md: &fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let blocks = md.blocks();
        if blocks > 0 {
            return blocks.saturating_mul(512);
        }
        return md.len();
    }
    #[cfg(windows)]
    {
        return md.len();
    }
    #[cfg(not(any(unix, windows)))]
    {
        return md.len();
    }
}

pub fn is_dir_or_symlink_to_dir(path: &Path, entry: &fs::DirEntry) -> bool {
    if let Ok(ft) = entry.file_type() {
        if ft.is_dir() {
            return true;
        }
        if ft.is_symlink() {
            return fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
        }
    }
    false
}

pub fn read_package_identity(pkg_dir: &Path) -> Option<(String, String)> {
    let pkg_json = pkg_dir.join("package.json");
    let raw = fs::read_to_string(pkg_json).ok()?;
    fn extract_str(raw: &str, key: &str) -> Option<String> {
        let needle = format!("\"{key}\"");
        let start = raw.find(&needle)?;
        let after = &raw[start + needle.len()..];
        let colon = after.find(':')?;
        let mut s = after[colon + 1..].trim_start();
        if !s.starts_with('"') {
            return None;
        }
        s = &s[1..];
        let mut out = String::new();
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => break,
                '\\' => {
                    if let Some(esc) = chars.next() {
                        out.push(match esc {
                            '"' => '"',
                            '\\' => '\\',
                            'n' => '\n',
                            'r' => '\r',
                            't' => '\t',
                            other => other,
                        });
                    }
                }
                other => out.push(other),
            }
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }
    let name = extract_str(&raw, "name")?;
    let version = extract_str(&raw, "version")?;
    Some((name, version))
}

pub fn depth_from_path(p: &Path) -> u64 {
    p.components()
        .filter(|c| matches!(c, std::path::Component::Normal(s) if *s == std::ffi::OsStr::new("node_modules")))
        .count() as u64
}

pub fn is_scope_dir(dir: &Path) -> bool {
    dir.file_name()
        .map(|n| n.to_string_lossy().starts_with('@'))
        .unwrap_or(false)
}

pub fn is_package_dir(dir: &Path) -> bool {
    let name = match dir.file_name() {
        Some(n) => n.to_string_lossy(),
        None => return false,
    };
    if name == ".bin" || name.starts_with('.') {
        return false;
    }

    let parent = match dir.parent() {
        Some(p) => p,
        None => return false,
    };
    let parent_name = parent.file_name().map(|n| n.to_string_lossy());

    if parent_name.as_deref() == Some("node_modules") {
        return !name.starts_with('@');
    }

    let grand = match parent.parent() {
        Some(g) => g,
        None => return false,
    };
    let grand_name = grand.file_name().map(|n| n.to_string_lossy());
    if grand_name.as_deref() == Some("node_modules") && is_scope_dir(parent) {
        return true;
    }

    false
}

pub fn percentile_p95(mut values: Vec<u64>) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    let idx = ((values.len() - 1) as f64 * 0.95).floor() as usize;
    values[idx]
}

pub fn list_packages_in_node_modules(node_modules_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut packages: Vec<PathBuf> = Vec::new();
    let mut queue: VecDeque<PathBuf> = VecDeque::new();
    let mut visited_nm: HashSet<PathBuf> = HashSet::new();

    queue.push_back(node_modules_dir.to_path_buf());

    while let Some(nm) = queue.pop_front() {
        let canon = fs::canonicalize(&nm).unwrap_or(nm.clone());
        if !visited_nm.insert(canon) {
            continue;
        }

        let entries = match stable_list_dir(&nm) {
            Ok(v) => v,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::NotADirectory {
                    continue;
                }
                return Err(e.to_string());
            }
        };

        for ent in entries {
            let name = ent.file_name();
            let name_str = name.to_string_lossy();
            if name_str == ".bin" || name_str.starts_with('.') {
                continue;
            }

            let full_ent = nm.join(&name);
            if !is_dir_or_symlink_to_dir(&full_ent, &ent) {
                continue;
            }

            if name_str.starts_with('@') {
                let scope_entries = match stable_list_dir(&full_ent) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                for sc in scope_entries {
                    let scoped_name = sc.file_name();
                    let scoped_path = full_ent.join(scoped_name);
                    if !is_dir_or_symlink_to_dir(&scoped_path, &sc) {
                        continue;
                    }
                    packages.push(scoped_path.clone());
                    let nested = scoped_path.join("node_modules");
                    if nested.exists() {
                        queue.push_back(nested);
                    }
                }
                continue;
            }

            packages.push(full_ent.clone());
            let nested = full_ent.join("node_modules");
            if nested.exists() {
                queue.push_back(nested);
            }
        }
    }

    packages.sort();
    Ok(packages)
}

// --- Symlink / file helpers ---

pub fn remove_path_if_exists(p: &Path) -> Result<(), String> {
    match fs::symlink_metadata(p) {
        Ok(md) => {
            if md.is_dir() {
                fs::remove_dir_all(p).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(p).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(e.to_string())
            }
        }
    }
}

#[cfg(unix)]
pub fn create_symlink(target: &Path, dst: &Path, _src_path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::symlink;
    symlink(target, dst)
}

#[cfg(windows)]
pub fn create_symlink(target: &Path, dst: &Path, src_path: &Path) -> std::io::Result<()> {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let resolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        src_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(target)
    };
    let target_is_dir = fs::metadata(&resolved).map(|m| m.is_dir()).unwrap_or(false);
    if target_is_dir {
        symlink_dir(target, dst)
    } else {
        symlink_file(target, dst)
    }
}

#[cfg(not(any(unix, windows)))]
pub fn create_symlink(target: &Path, dst: &Path, _src_path: &Path) -> std::io::Result<()> {
    fs::copy(target, dst).map(|_| ())
}

pub fn copy_file_with_retry(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::copy(src, dst) {
        Ok(_) => Ok(()),
        Err(err) => {
            if err.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(err.to_string());
            }
            remove_path_if_exists(dst)?;
            fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())
        }
    }
}

pub fn hardlink_with_retry(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::hard_link(src, dst) {
        Ok(()) => Ok(()),
        Err(err) => {
            if err.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(err.to_string());
            }
            remove_path_if_exists(dst)?;
            fs::hard_link(src, dst).map_err(|e| e.to_string())
        }
    }
}

pub fn create_symlink_with_retry(task: &MaterializeSymlinkTask) -> Result<(), String> {
    match create_symlink(&task.target, &task.dst, &task.src) {
        Ok(()) => Ok(()),
        Err(_) => {
            remove_path_if_exists(&task.dst)?;
            create_symlink(&task.target, &task.dst, &task.src).map_err(|e| e.to_string())
        }
    }
}

// --- clonefile (macOS APFS copy-on-write) ---

/// Try macOS clonefile(2) for near-instant APFS copy-on-write directory cloning.
/// Returns true if the clone succeeded, false otherwise.
#[cfg(target_os = "macos")]
pub fn try_clonefile(src: &Path, dst: &Path) -> bool {
    use std::ffi::CString;
    extern "C" {
        fn clonefile(
            src: *const std::os::raw::c_char,
            dst: *const std::os::raw::c_char,
            flags: u32,
        ) -> std::os::raw::c_int;
    }
    let src_c = match CString::new(src.as_os_str().as_encoded_bytes()) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let dst_c = match CString::new(dst.as_os_str().as_encoded_bytes()) {
        Ok(c) => c,
        Err(_) => return false,
    };
    unsafe { clonefile(src_c.as_ptr(), dst_c.as_ptr(), 0) == 0 }
}

#[cfg(not(target_os = "macos"))]
pub fn try_clonefile(_src: &Path, _dst: &Path) -> bool {
    false
}

/// Try to clone a directory using clonefile. If clonefile fails (e.g. dest exists),
/// remove dest first and retry once.
pub fn try_clonefile_dir(src: &Path, dst: &Path) -> bool {
    if try_clonefile(src, dst) {
        return true;
    }
    // Retry after removing destination (clonefile fails if dst exists)
    if dst.exists() {
        if fs::remove_dir_all(dst).is_err() {
            return false;
        }
        return try_clonefile(src, dst);
    }
    false
}

// Helper function to get file mode (Unix permissions)
#[cfg(unix)]
pub fn get_file_mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode()
}

#[cfg(not(unix))]
pub fn get_file_mode(_metadata: &fs::Metadata) -> u32 {
    0o644 // Default mode for non-Unix systems
}

// Helper function to get current timestamp in ISO format
pub fn chrono_now() -> String {
    use std::time::SystemTime;

    match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => {
            let secs = duration.as_secs();
            let nanos = duration.subsec_nanos();

            // Simple ISO 8601 formatting
            let days_since_epoch = secs / 86400;
            let year = 1970 + (days_since_epoch / 365); // Rough approximation
            let month = ((days_since_epoch % 365) / 30) + 1;
            let day = ((days_since_epoch % 365) % 30) + 1;

            let time_of_day = secs % 86400;
            let hour = time_of_day / 3600;
            let minute = (time_of_day % 3600) / 60;
            let second = time_of_day % 60;
            let millis = nanos / 1_000_000;

            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                year, month, day, hour, minute, second, millis
            )
        }
        Err(_) => "1970-01-01T00:00:00.000Z".to_string(),
    }
}

// === Phase B: High-Value Commands ===

// --- B.1: Script Runner ---

pub fn read_package_json_scripts(project_root: &Path) -> Result<Vec<(String, String)>, String> {
    let pkg_json = project_root.join("package.json");
    let content = fs::read_to_string(&pkg_json)
        .map_err(|e| format!("Failed to read package.json: {}", e))?;
    extract_json_object_pairs(&content, "scripts")
}

/// Extract all key-value string pairs from a named JSON object field.
/// E.g. for "scripts": {"test": "jest", "build": "tsc"} returns [("test","jest"), ("build","tsc")]
pub fn extract_json_object_pairs(json: &str, object_name: &str) -> Result<Vec<(String, String)>, String> {
    let needle = format!("\"{}\"", object_name);
    let start = match json.find(&needle) {
        Some(pos) => pos,
        None => return Ok(Vec::new()),
    };
    let after = &json[start + needle.len()..];
    let obj_start = match after.find('{') {
        Some(pos) => pos,
        None => return Ok(Vec::new()),
    };
    let section = &after[obj_start..];

    let mut pairs = Vec::new();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut key = String::new();
    let mut val = String::new();
    let mut reading_key = false;
    let mut reading_val = false;
    let mut key_done = false;
    let mut after_colon = false;

    for ch in section.chars() {
        if esc {
            if reading_key { key.push(ch); }
            else if reading_val { val.push(ch); }
            esc = false;
            continue;
        }
        if ch == '\\' && in_str { esc = true; continue; }
        if ch == '"' {
            in_str = !in_str;
            if depth == 1 {
                if !key_done && !after_colon && in_str {
                    reading_key = true; key.clear();
                } else if reading_key && !in_str {
                    reading_key = false; key_done = true;
                } else if key_done && after_colon && in_str {
                    reading_val = true; val.clear();
                } else if reading_val && !in_str {
                    reading_val = false; key_done = false; after_colon = false;
                    if !key.is_empty() { pairs.push((key.clone(), val.clone())); }
                    key.clear(); val.clear();
                }
            }
            continue;
        }
        if in_str {
            if reading_key { key.push(ch); }
            else if reading_val { val.push(ch); }
            continue;
        }
        match ch {
            '{' => { depth += 1; }
            '}' => { depth -= 1; if depth == 0 { break; } }
            ':' if depth == 1 && key_done => { after_colon = true; }
            ',' if depth == 1 => { key_done = false; after_colon = false; }
            _ => {}
        }
    }
    Ok(pairs)
}

/// Extract the raw JSON substring for a nested object field by name.
/// E.g. for `"better": {"hooks": {"pre-commit": "lint"}}` with field_name="better"
/// returns `{"hooks": {"pre-commit": "lint"}}`.
pub fn extract_json_object_raw(json: &str, field_name: &str) -> Option<String> {
    let needle = format!("\"{}\"", field_name);
    let start = json.find(&needle)?;
    let after = &json[start + needle.len()..];
    let obj_start = after.find('{')?;
    let section = &after[obj_start..];
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut end_pos = 0usize;
    for (i, ch) in section.char_indices() {
        if esc { esc = false; continue; }
        if ch == '\\' && in_str { esc = true; continue; }
        if ch == '"' { in_str = !in_str; continue; }
        if in_str { continue; }
        match ch {
            '{' => depth += 1,
            '}' => { depth -= 1; if depth == 0 { end_pos = i + 1; break; } }
            _ => {}
        }
    }
    if end_pos == 0 { return None; }
    Some(section[..end_pos].to_string())
}

pub fn run_script(project_root: &Path, script_name: &str, extra_args: &[String]) -> Result<ScriptRunResult, String> {
    let scripts = read_package_json_scripts(project_root)?;
    let command = scripts.iter()
        .find(|(n, _)| n == script_name)
        .map(|(_, c)| c.clone())
        .ok_or_else(|| format!("Missing script: \"{}\"", script_name))?;

    let started = Instant::now();
    let bin_dir = project_root.join("node_modules").join(".bin");
    let path_var = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), path_var);

    let mut full_cmd = command.clone();
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
    let status = cmd.status()
        .map_err(|e| format!("Failed to run: {}", e))?;

    Ok(ScriptRunResult {
        script_name: script_name.to_string(),
        command: full_cmd,
        exit_code: status.code().unwrap_or(-1),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

pub fn run_scripts_parallel(project_root: &Path, script_names: &[String]) -> Vec<Result<ScriptRunResult, String>> {
    let handles: Vec<_> = script_names.iter().map(|name| {
        let root = project_root.to_path_buf();
        let n = name.clone();
        std::thread::spawn(move || run_script(&root, &n, &[]))
    }).collect();
    handles.into_iter()
        .map(|h| h.join().unwrap_or_else(|_| Err("Thread panicked".to_string())))
        .collect()
}

// --- Helper: extract JSON array of strings ---

pub fn extract_json_array_strings(json: &str, field_name: &str) -> Vec<String> {
    let needle = format!("\"{}\"", field_name);
    let start = match json.find(&needle) {
        Some(pos) => pos,
        None => return Vec::new(),
    };
    let after = &json[start + needle.len()..];
    let colon = match after.find(':') {
        Some(pos) => pos,
        None => return Vec::new(),
    };
    let rest = after[colon + 1..].trim_start();
    if !rest.starts_with('[') {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut depth = 0;
    let mut in_str = false;
    let mut esc = false;
    let mut current = String::new();
    let mut reading = false;
    for ch in rest.chars() {
        if esc { if reading { current.push(ch); } esc = false; continue; }
        if ch == '\\' && in_str { esc = true; continue; }
        if ch == '"' {
            in_str = !in_str;
            if depth == 1 {
                if in_str { reading = true; current.clear(); }
                else { reading = false; result.push(current.clone()); current.clear(); }
            }
            continue;
        }
        if in_str { if reading { current.push(ch); } continue; }
        match ch {
            '[' => depth += 1,
            ']' => { depth -= 1; if depth == 0 { break; } }
            _ => {}
        }
    }
    result
}

pub fn extract_json_number(json: &str, field_name: &str) -> Option<u64> {
    let needle = format!("\"{}\"", field_name);
    let start = json.find(&needle)?;
    let after = &json[start + needle.len()..];
    let colon = after.find(':')?;
    let rest = after[colon + 1..].trim_start();
    let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if num_str.is_empty() { return None; }
    num_str.parse().ok()
}

pub fn extract_json_field(json: &str, field_name: &str) -> Option<String> {
    let needle = format!("\"{}\"", field_name);
    let start = json.find(&needle)?;
    let after = &json[start + needle.len()..];
    let colon = after.find(':')?;
    let mut rest = after[colon + 1..].trim_start();

    if !rest.starts_with('"') {
        return None;
    }

    rest = &rest[1..];
    let mut result = String::new();
    let mut chars = rest.chars();

    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => {
                if let Some(esc) = chars.next() {
                    result.push(match esc {
                        '"' => '"',
                        '\\' => '\\',
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        '/' => '/',
                        other => other,
                    });
                }
            }
            other => result.push(other),
        }
    }

    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

pub fn package_name_from_path(rel_path: &str) -> String {
    let parts: Vec<&str> = rel_path.split('/').collect();
    if let Some(idx) = parts.iter().position(|&p| p == "node_modules") {
        if idx + 1 < parts.len() {
            let first = parts[idx + 1];
            if first.starts_with('@') && idx + 2 < parts.len() {
                return format!("{}/{}", first, parts[idx + 2]);
            }
            return first.to_string();
        }
    }
    "unknown".to_string()
}

