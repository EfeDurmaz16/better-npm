pub mod install;
pub mod coordinator;
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

pub mod audit_config;
pub use audit_config::*;

pub mod approval;
pub use approval::*;

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

pub mod platform_selection;
pub use platform_selection::*;

pub mod integrity;
pub mod artifact_cache;
mod artifact_inventory;
mod archive_materialize;
pub mod fetch;
pub mod fetch_pipeline;
pub mod fetch_scheduler;
mod transport;
pub use fetch::*;

pub mod analyze;
pub use analyze::*;

pub mod engine;
pub use engine::{cross_ecosystem_audit, CrossSeverity, UnifiedAuditReport, UnifiedVulnerability};

pub mod binlinks;
pub use binlinks::*;

pub mod progress;
pub use progress::*;

pub mod strict;
pub use strict::*;

pub mod materialize;
pub use materialize::*;

pub mod delta;
pub use delta::*;

pub mod dedupe_fix;
pub use dedupe_fix::*;

pub mod lazy;
pub use lazy::*;

pub mod offline;
pub use offline::*;

pub mod ci;
pub use ci::*;

pub mod diff;
pub use diff::*;

pub mod env_manager;
pub use env_manager::*;

pub mod costs;
pub use costs::*;

pub mod exit_codes;
pub use exit_codes::*;

pub mod upgrade;
pub use upgrade::*;

pub mod cid;
pub use cid::*;

pub mod federation;
pub use federation::*;

pub mod unused;
pub use unused::*;

pub mod license_policy;
pub use license_policy::*;

pub mod registry;
pub use registry::*;

pub mod sandbox;
pub use sandbox::*;

pub mod provenance;
pub use provenance::*;

pub mod receipt;
pub use receipt::*;

pub mod firewall;
pub use firewall::*;

pub mod venv;
pub use venv::*;

pub mod migrate;
pub use migrate::*;

pub mod suggest;
pub use suggest::*;

pub mod output;
pub use output::{OutputMode, GlobalFlags, CommandOutput, BetterError, ErrorCode};

pub mod agent;
pub mod context;
pub mod mcp;
pub mod search;
pub mod osp;
pub mod sardis;
pub mod monetize;
pub mod plugin;
pub mod reputation;
pub use reputation::run_reputation;

pub mod signing;
pub mod reproducible;
pub mod decentralized_registry;
pub mod content_publish;
pub mod cross_project;
pub mod ai;

pub mod deploy;
pub mod intelligence;

pub mod ci_pack;
pub use ci_pack::*;

pub mod mirror;
pub use mirror::{probe_mirrors, select_and_save, load_best_mirror, effective_registry, MirrorProbeResult, MirrorSelectResult};

pub mod schema;
pub mod cli_compat;
pub mod telemetry;
pub mod stats;
pub mod doctor_v2;
pub mod services;
pub mod cross_ecosystem;
pub mod graph;
pub mod pin;
pub mod compat;

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

/// Publish an independent inode without truncating an existing hardlink or following
/// a destination symlink. Staging stays on the destination filesystem for rename.
/// Auto may use copy-on-write; explicit Copy still uses the platform copy primitive.
pub fn copy_file_with_retry(src: &Path, dst: &Path) -> Result<(), String> {
    copy_file_with_mode(src, dst, None)
}

pub fn copy_file_with_mode(src: &Path, dst: &Path, mode: Option<u32>) -> Result<(), String> {
    MaterializeStaging::default().copy(src, dst, mode)
}

/// Invocation-local staging arenas, reused per destination directory. Every
/// published file still owns an independent inode. No paths survive the batch.
#[derive(Default)]
pub(crate) struct MaterializeStaging {
    directories: std::collections::HashMap<PathBuf, PathBuf>,
    #[cfg(unix)]
    comparison_buffers: Option<(Vec<u8>, Vec<u8>)>,
}

impl MaterializeStaging {
    fn publish<T>(
        &mut self,
        dst: &Path,
        write: impl FnOnce(&Path) -> std::io::Result<()>,
        publish: impl FnOnce(&Path) -> std::io::Result<T>,
    ) -> Result<T, String> {
        let parent = dst
            .parent()
            .ok_or("materialize destination has no parent")?;
        if !self.directories.contains_key(parent) {
            self.directories
                .insert(parent.to_path_buf(), create_staging_directory(parent)?);
        }
        let staged = self.directories[parent].join("file");
        let result = write(&staged).and_then(|()| publish(&staged));
        // Rename normally consumes the source; no-replace CAS publication does not.
        // Always remove leftovers before the arena is reused after a failed write.
        match fs::remove_file(&staged) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("clean staging for {}: {}", dst.display(), error)),
        }
        result.map_err(|error| format!("materialize {}: {}", dst.display(), error))
    }

    /// Return true only for an independently owned destination whose complete
    /// contents were compared this invocation. Timestamps alone never imply reuse.
    pub(crate) fn copy_if_changed(
        &mut self,
        src: &Path,
        dst: &Path,
        mode: Option<u32>,
    ) -> Result<bool, String> {
        if self.matches_independent_file(src, dst, mode) {
            return Ok(true);
        }
        self.copy(src, dst, mode)?;
        Ok(false)
    }

    /// Materialize verified, invocation-owned bytes without reopening an expanded
    /// source file. Mutable destination contents are still compared in full.
    pub(crate) fn copy_bytes_if_changed(
        &mut self,
        expected: &[u8],
        dst: &Path,
        mode: u32,
    ) -> Result<bool, String> {
        if self.matches_independent_bytes(expected, dst, mode) {
            return Ok(true);
        }
        self.publish(
            dst,
            |staged| {
                use std::io::Write;
                let mut file = fs::OpenOptions::new().write(true).create_new(true).open(staged)?;
                file.write_all(expected)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    file.set_permissions(fs::Permissions::from_mode(mode & 0o7777))?;
                }
                Ok(())
            },
            |staged| fs::rename(staged, dst),
        )?;
        Ok(false)
    }

    #[cfg(not(unix))]
    fn matches_independent_bytes(&mut self, _expected: &[u8], _dst: &Path, _mode: u32) -> bool {
        false
    }

    #[cfg(unix)]
    fn matches_independent_bytes(&mut self, expected: &[u8], dst: &Path, mode: u32) -> bool {
        use std::io::Read;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let mut compare = || -> std::io::Result<bool> {
            let mut file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(dst)?;
            let before = file.metadata()?;
            if !before.is_file()
                || before.nlink() != 1
                || before.len() != expected.len() as u64
                || before.mode() & 0o7777 != mode & 0o7777
            {
                return Ok(false);
            }
            let (_, buffer) = self
                .comparison_buffers
                .get_or_insert_with(|| (vec![0; 64 * 1024], vec![0; 64 * 1024]));
            for chunk in expected.chunks(buffer.len()) {
                file.read_exact(&mut buffer[..chunk.len()])?;
                if buffer[..chunk.len()] != *chunk {
                    return Ok(false);
                }
            }
            Ok(same_file_observation(&before, &fs::symlink_metadata(dst)?))
        };
        compare().unwrap_or(false)
    }

    #[cfg(not(unix))]
    fn matches_independent_file(&mut self, _src: &Path, _dst: &Path, _mode: Option<u32>) -> bool {
        // Do not infer independence on platforms without the inode/link checks below.
        false
    }

    #[cfg(unix)]
    fn matches_independent_file(&mut self, src: &Path, dst: &Path, mode: Option<u32>) -> bool {
        use std::io::Read;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let mut compare = || -> std::io::Result<bool> {
            // Fresh installations stop here, before opening or reading the source.
            // Open without following the final symlink. Nonblocking is necessary
            // because a mutable destination can have been replaced with a FIFO.
            let open = |path: &Path| {
                fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(path)
            };
            let mut destination_file = open(dst)?;
            let destination = destination_file.metadata()?;
            if !destination.is_file() || destination.nlink() != 1 {
                return Ok(false);
            }
            let mut source_file = open(src)?;
            let source = source_file.metadata()?;
            if !source.is_file()
                || source.len() != destination.len()
                || (source.dev(), source.ino()) == (destination.dev(), destination.ino())
                || destination.mode() & 0o7777 != mode.unwrap_or(source.mode()) & 0o7777
            {
                return Ok(false);
            }
            let (source_buffer, destination_buffer) = self
                .comparison_buffers
                .get_or_insert_with(|| (vec![0; 64 * 1024], vec![0; 64 * 1024]));
            let mut remaining = source.len();
            while remaining > 0 {
                let count = remaining.min(source_buffer.len() as u64) as usize;
                source_file.read_exact(&mut source_buffer[..count])?;
                destination_file.read_exact(&mut destination_buffer[..count])?;
                if source_buffer[..count] != destination_buffer[..count] {
                    return Ok(false);
                }
                remaining -= count as u64;
            }
            // Path observations must still identify the opened inodes, including
            // their link counts and change times. Comparing the initial handle
            // metadata to these final observations detects replacements and edits
            // without separately repeating fstat on those same inodes.
            Ok(same_file_observation(&source, &fs::symlink_metadata(src)?)
                && same_file_observation(&destination, &fs::symlink_metadata(dst)?))
        };
        compare().unwrap_or(false)
    }

    pub(crate) fn symlink_if_changed(
        &mut self,
        task: &MaterializeSymlinkTask,
    ) -> Result<bool, String> {
        if fs::read_link(&task.dst).is_ok_and(|target| target == task.target) {
            return Ok(true);
        }
        self.symlink(task)?;
        Ok(false)
    }

    pub(crate) fn copy(&mut self, src: &Path, dst: &Path, mode: Option<u32>) -> Result<(), String> {
        self.publish(
            dst,
            |staged| {
                if !try_clonefile(src, staged) {
                    fs::copy(src, staged)?;
                }
                #[cfg(unix)]
                if let Some(mode) = mode {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(staged, fs::Permissions::from_mode(mode & 0o7777))?;
                }
                #[cfg(not(unix))]
                let _ = mode;
                Ok(())
            },
            |staged| fs::rename(staged, dst),
        )
    }

    pub(crate) fn symlink(&mut self, task: &MaterializeSymlinkTask) -> Result<(), String> {
        self.publish(
            &task.dst,
            |staged| create_symlink(&task.target, staged, &task.src),
            |staged| fs::rename(staged, &task.dst),
        )
    }
}

#[cfg(unix)]
fn same_file_observation(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    before.is_file()
        && after.is_file()
        && before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.nlink() == after.nlink()
        && before.len() == after.len()
        && before.mode() == after.mode()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

impl Drop for MaterializeStaging {
    fn drop(&mut self) {
        for directory in self.directories.values() {
            let _ = fs::remove_file(directory.join("file"));
            let _ = fs::remove_dir(directory);
        }
    }
}

fn create_staging_directory(parent: &Path) -> Result<PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let path = parent.join(format!(
            ".better-copy-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create staging in {}: {}", parent.display(), error)),
        }
    }
}

/// Per-file publication, not a whole-package transaction or power-loss guarantee.
pub(crate) fn publish_file(dst: &Path, write: impl FnOnce(&Path) -> std::io::Result<()>) -> Result<(), String> {
    with_staged_file(dst, write, |staged| fs::rename(staged, dst))
}

/// Atomic no-replace publication inside CAS only. The staging inode is never
/// installed into a worktree. Unsupported filesystems return an error so callers
/// can fall back to tree materialization without claiming successful CAS ingest.
pub(crate) fn publish_cas_file(src: &Path, dst: &Path) -> Result<bool, String> {
    with_staged_file(dst, |staged| {
        if !try_clonefile(src, staged) { fs::copy(src, staged)?; }
        Ok(())
    }, |staged| match fs::hard_link(staged, dst) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    })
}

fn with_staged_file<T>(dst: &Path, write: impl FnOnce(&Path) -> std::io::Result<()>,
    publish: impl FnOnce(&Path) -> std::io::Result<T>) -> Result<T, String> {
    MaterializeStaging::default().publish(dst, write, publish)
}

/// Validate lockfile paths before joining them to the installation root.
pub fn validate_package_paths(packages: &[ResolvedPackage]) -> Result<(), String> {
    for package in packages {
        let valid_relative = |value: &str| !value.is_empty()
            && !value.contains('\\')
            && Path::new(value).components().all(|part| matches!(part, std::path::Component::Normal(_)));
        if !package.rel_path.starts_with("node_modules/") || !valid_relative(&package.rel_path)
            || !valid_relative(&package.name) || !valid_relative(&package.version)
            || package.version.contains('/') {
            return Err(format!("Invalid materialization path for {}", package.rel_path));
        }
    }
    Ok(())
}

/// Package symlinks may resolve within the package, never outside it.
pub fn validate_materialize_symlink(root: &Path, dst: &Path, target: &Path) -> Result<(), String> {
    let parent = dst.parent().ok_or("symlink missing parent")?;
    let mut depth = parent.strip_prefix(root).map_err(|e| e.to_string())?.components().count();
    for component in target.components() {
        match component {
            std::path::Component::Normal(_) => depth += 1,
            std::path::Component::CurDir => {},
            std::path::Component::ParentDir if depth > 0 => depth -= 1,
            _ => return Err(format!("Package symlink escapes destination: {}", dst.display())),
        }
    }
    Ok(())
}

/// Refuse destination directory symlinks rather than writing through them.
pub fn create_materialize_dir(root: &Path, dir: &Path) -> Result<(), String> {
    let relative = dir.strip_prefix(root).map_err(|e| e.to_string())?;
    let mut current = root.to_path_buf();
    let mut paths = vec![current.clone()];
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("invalid materialization directory".into());
        }
        current.push(component);
        paths.push(current.clone());
    }
    for path in paths {
        match fs::symlink_metadata(&path) {
            Ok(md) if !md.is_dir() || md.file_type().is_symlink() => return Err(format!("materialization directory is not a real directory: {}", path.display())),
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::create_dir_all(&path).map_err(|e| e.to_string())?,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

pub fn hardlink_with_retry(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::hard_link(src, dst) {
        Ok(()) => Ok(()),
        Err(err) => {
            if err.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(err.to_string());
            }
            fs::remove_file(dst).map_err(|e| e.to_string())?;
            fs::hard_link(src, dst).map_err(|e| e.to_string())
        }
    }
}

pub fn create_symlink_with_retry(task: &MaterializeSymlinkTask) -> Result<(), String> {
    publish_file(&task.dst, |staged| create_symlink(&task.target, staged, &task.src))
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

/// Validate links before a whole-directory clone, which bypasses per-file scanning.
pub fn validate_clone_source(src: &Path) -> Result<(), String> {
    let mut stack = vec![src.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                let target = fs::read_link(entry.path()).map_err(|e| e.to_string())?;
                validate_materialize_symlink(src, &entry.path(), &target)?;
            } else if kind.is_dir() {
                // Tree materialization excludes nested installation state.
                if entry.file_name() == "node_modules" { return Err("nested node_modules requires tree materialization".into()); }
                stack.push(entry.path());
            }
        }
    }
    Ok(())
}

/// Unsupported platforms decline before scanning or modifying the destination.
#[cfg(not(target_os = "macos"))]
pub fn try_clonefile_dir(_src: &Path, _dst: &Path) -> bool { false }

/// Clone only into an absent or empty destination. Existing installation state
/// must be reconciled per file, never recursively deleted by a failed fast path.
#[cfg(target_os = "macos")]
pub fn try_clonefile_dir(src: &Path, dst: &Path) -> bool {
    if validate_clone_source(src).is_err() { return false; }
    match fs::symlink_metadata(dst) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            if fs::remove_dir(dst).is_err() { return false; }
            if try_clonefile(src, dst) { return true; }
            // Keep the caller's pre-created directory when cloning is unsupported.
            let _ = fs::create_dir(dst);
            false
        }
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => try_clonefile(src, dst),
        Err(_) => false,
    }
}

#[cfg(test)]
mod staging_reuse_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn unchanged_file_reuse_checks_contents_modes_and_inode_independence() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::write(&source, "original").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o644)).unwrap();
        let mut arena = MaterializeStaging::default();
        assert!(!arena.copy_if_changed(&source, &target, None).unwrap());
        assert!(arena.comparison_buffers.is_none(), "fresh destination must not read source for comparison");
        let inode = fs::metadata(&target).unwrap().ino();
        assert!(arena.copy_if_changed(&source, &target, None).unwrap());
        assert_eq!(fs::metadata(&target).unwrap().ino(), inode);
        fs::write(&target, "modified").unwrap(); // Same length, different contents.
        assert!(!arena.copy_if_changed(&source, &target, None).unwrap());
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!arena.copy_if_changed(&source, &target, None).unwrap());
        assert_eq!(fs::metadata(&target).unwrap().mode() & 0o7777, 0o644);
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(arena.copy_if_changed(&source, &target, Some(0o644)).unwrap());

        // Sharing with either the cache source or another worktree requires splitting.
        fs::remove_file(&target).unwrap();
        fs::hard_link(&source, &target).unwrap();
        assert!(!arena.copy_if_changed(&source, &target, None).unwrap());
        assert_ne!(fs::metadata(&target).unwrap().ino(), fs::metadata(&source).unwrap().ino());
        let other = temp.path().join("other");
        fs::hard_link(&target, &other).unwrap();
        assert!(!arena.copy_if_changed(&source, &target, None).unwrap());
        fs::write(&target, "local edit").unwrap();
        assert_eq!(fs::read_to_string(&source).unwrap(), "original");
        assert_eq!(fs::read_to_string(&other).unwrap(), "original");

        fs::remove_file(&target).unwrap();
        std::os::unix::fs::symlink(&source, &target).unwrap();
        assert!(!arena.copy_if_changed(&source, &target, None).unwrap());
        assert!(fs::symlink_metadata(&target).unwrap().is_file());
        fs::write(&target, "another edit").unwrap();
        assert_eq!(fs::read_to_string(&source).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn reuse_compares_past_buffer_boundaries_and_rejects_special_files() {
        use std::ffi::CString;
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let contents = vec![42; 2 * 64 * 1024 + 1];
        fs::write(&source, &contents).unwrap();
        fs::write(&target, &contents).unwrap();
        let mut arena = MaterializeStaging::default();
        assert!(arena.matches_independent_file(&source, &target, None));
        let mut modified = contents.clone();
        *modified.last_mut().unwrap() = 43;
        fs::write(&target, modified).unwrap();
        assert!(!arena.matches_independent_file(&source, &target, None));
        fs::write(&target, &contents).unwrap();

        let link = temp.path().join("source-link");
        symlink(&source, &link).unwrap();
        assert!(!arena.matches_independent_file(&link, &target, None));
        assert!(!arena.matches_independent_file(&source, &link, None));

        let fifo = temp.path().join("fifo");
        let fifo_name = CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        // No writer is opened. A blocking open would hang instead of declining.
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
        assert!(!arena.matches_independent_file(&source, &fifo, None));
        assert!(!arena.matches_independent_file(&fifo, &target, None));
    }

    #[cfg(unix)]
    #[test]
    fn owned_bytes_reuse_repairs_mutations_modes_links_and_special_files() {
        use std::ffi::CString;
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let other = temp.path().join("other");
        let expected = vec![42; 2 * 64 * 1024 + 1];
        let mut arena = MaterializeStaging::default();
        assert!(!arena.copy_bytes_if_changed(&expected, &target, 0o644).unwrap());
        let inode = fs::metadata(&target).unwrap().ino();
        assert!(arena.copy_bytes_if_changed(&expected, &target, 0o644).unwrap());
        assert_eq!(fs::metadata(&target).unwrap().ino(), inode);
        let mut modified = expected.clone();
        *modified.last_mut().unwrap() = 43;
        fs::write(&target, &modified).unwrap();
        assert!(!arena.copy_bytes_if_changed(&expected, &target, 0o644).unwrap());
        assert_eq!(fs::read(&target).unwrap(), expected);
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!arena.copy_bytes_if_changed(&expected, &target, 0o644).unwrap());
        assert_eq!(fs::metadata(&target).unwrap().mode() & 0o7777, 0o644);

        fs::hard_link(&target, &other).unwrap();
        assert!(!arena.copy_bytes_if_changed(&expected, &target, 0o644).unwrap());
        assert_ne!(fs::metadata(&target).unwrap().ino(), fs::metadata(&other).unwrap().ino());
        fs::write(&target, &modified).unwrap();
        assert_eq!(fs::read(&other).unwrap(), expected);
        fs::remove_file(&target).unwrap();
        symlink(&other, &target).unwrap();
        assert!(!arena.copy_bytes_if_changed(&expected, &target, 0o644).unwrap());
        assert!(fs::symlink_metadata(&target).unwrap().is_file());
        assert_eq!(fs::read(&other).unwrap(), expected);

        fs::remove_file(&target).unwrap();
        let name = CString::new(target.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(!arena.copy_bytes_if_changed(&expected, &target, 0o644).unwrap());
        assert_eq!(fs::read(&target).unwrap(), expected);
        assert!(!arena.copy_bytes_if_changed(&[], &target, 0o644).unwrap());
        assert!(arena.copy_bytes_if_changed(&[], &target, 0o644).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_reuse_preserves_matching_inode_and_repairs_wrong_target() {
        use std::os::unix::fs::MetadataExt;
        let temp = tempfile::tempdir().unwrap();
        let task = MaterializeSymlinkTask {
            src: temp.path().join("source"), dst: temp.path().join("link"), target: PathBuf::from("correct"),
        };
        let mut arena = MaterializeStaging::default();
        assert!(!arena.symlink_if_changed(&task).unwrap());
        let inode = fs::symlink_metadata(&task.dst).unwrap().ino();
        assert!(arena.symlink_if_changed(&task).unwrap());
        assert_eq!(fs::symlink_metadata(&task.dst).unwrap().ino(), inode);
        fs::remove_file(&task.dst).unwrap();
        std::os::unix::fs::symlink("wrong", &task.dst).unwrap();
        assert!(!arena.symlink_if_changed(&task).unwrap());
        assert_eq!(fs::read_link(&task.dst).unwrap(), task.target);
    }

    #[test]
    fn arena_reuses_directory_and_cleans_failed_publication() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::write(&source, "original").unwrap();
        let target = temp.path().join("target");
        fs::create_dir(&target).unwrap();
        let mut arena = MaterializeStaging::default();
        arena.copy(&source, &target.join("first"), None).unwrap();
        let staging = arena.directories[&target].clone();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&staging).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let conflict = target.join("conflict");
        fs::create_dir(&conflict).unwrap();
        fs::write(conflict.join("keep"), "preserved").unwrap();
        assert!(arena.copy(&source, &conflict, None).is_err());
        assert!(!staging.join("file").exists());
        assert_eq!(fs::read_to_string(conflict.join("keep")).unwrap(), "preserved");
        arena.copy(&source, &target.join("second"), None).unwrap();
        assert_eq!(arena.directories.len(), 1);
        assert_eq!(arena.directories[&target], staging);
        drop(arena);
        assert!(!staging.exists());
        fs::write(target.join("first"), "changed").unwrap();
        assert_eq!(fs::read_to_string(&source).unwrap(), "original");
        assert_eq!(fs::read_to_string(target.join("second")).unwrap(), "original");
    }

    #[test]
    fn clone_fastpath_preserves_nonempty_destination() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("new"), "new").unwrap();
        fs::write(target.join("keep"), "existing state").unwrap();
        assert!(!try_clonefile_dir(&source, &target));
        assert_eq!(fs::read_to_string(target.join("keep")).unwrap(), "existing state");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn clone_fastpath_validates_source_before_removing_empty_destination() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink("../../outside", source.join("escape")).unwrap();
        assert!(!try_clonefile_dir(&source, &target));
        assert!(target.is_dir());
        assert!(fs::read_dir(&target).unwrap().next().is_none());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn unavailable_clone_keeps_empty_destination() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        fs::create_dir(&target).unwrap();
        assert!(!try_clonefile_dir(&temp.path().join("missing"), &target));
        assert!(target.is_dir());
    }
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
    let mut new_path = format!("{}:{}", bin_dir.display(), path_var);

    // If this is a Python project with a venv, prepend .venv/bin to PATH
    let venv_env = venv::venv_run_env(project_root);
    if let Some(venv_path) = venv_env.get("PATH") {
        new_path = format!("{}:{}", venv_path.split(':').next().unwrap_or(""), new_path);
    }

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
    // Set VIRTUAL_ENV if venv exists
    if let Some(venv_dir) = venv_env.get("VIRTUAL_ENV") {
        cmd.env("VIRTUAL_ENV", venv_dir);
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
    if let Some(idx) = parts.iter().rposition(|&p| p == "node_modules") {
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


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_field_basic() {
        let json = r#"{"name":"lodash","version":"4.17.21"}"#;
        assert_eq!(extract_json_field(json, "name"), Some("lodash".to_string()));
        assert_eq!(extract_json_field(json, "version"), Some("4.17.21".to_string()));
    }

    #[test]
    fn extract_json_field_missing_returns_none() {
        let json = r#"{"name":"lodash"}"#;
        assert_eq!(extract_json_field(json, "nonexistent"), None);
    }

    #[test]
    fn package_name_from_path_simple() {
        assert_eq!(package_name_from_path("node_modules/lodash"), "lodash");
    }

    #[test]
    fn package_name_from_path_scoped() {
        assert_eq!(package_name_from_path("node_modules/@types/node"), "@types/node");
    }

    #[test]
    fn depth_from_path_zero() {
        let p = std::path::Path::new("/project/src/index.js");
        assert_eq!(depth_from_path(p), 0);
    }

    #[test]
    fn depth_from_path_one() {
        let p = std::path::Path::new("/project/node_modules/lodash/index.js");
        assert_eq!(depth_from_path(p), 1);
    }

    #[test]
    fn percentile_p95_empty_returns_zero() {
        assert_eq!(percentile_p95(vec![]), 0);
    }

    #[test]
    fn percentile_p95_sorted() {
        let vals: Vec<u64> = (1..=100).collect();
        let p95 = percentile_p95(vals);
        assert_eq!(p95, 95);
    }

    #[test]
    fn is_scope_dir_detects_at_sign() {
        let p = std::path::Path::new("/node_modules/@types");
        assert!(is_scope_dir(p));
        let p2 = std::path::Path::new("/node_modules/lodash");
        assert!(!is_scope_dir(p2));
    }

    #[test]
    fn chrono_now_returns_nonempty_string() {
        let now = chrono_now();
        assert!(!now.is_empty());
    }
}

pub mod selection;
pub use selection::*;
