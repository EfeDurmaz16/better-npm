use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
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

// --- Core functions ---

pub fn scan_tree(
    root: &Path,
    exclude_dir_names: &HashSet<&'static str>,
    mut seen_identities: Option<&mut HashSet<(u64, u64)>>,
) -> Result<ScanAgg, String> {
    let mut agg = ScanAgg::default();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = match stable_list_dir(&dir) {
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
            if exclude_dir_names.contains(name_str.as_ref()) {
                continue;
            }
            let full = dir.join(&name);
            let ft = ent.file_type().map_err(|e| e.to_string())?;

            if ft.is_dir() || (ft.is_symlink() && fs::metadata(&full).map(|m| m.is_dir()).unwrap_or(false)) {
                if is_package_dir(&full) {
                    agg.package_count += 1;
                }
                stack.push(full);
                continue;
            }

            agg.file_count += 1;
            let md = fs::symlink_metadata(&full).map_err(|e| e.to_string())?;
            let logical_len = md.len();
            let phys_len = physical_len(&md);
            agg.logical += logical_len;

            let (a, b, reliable) = identity_key(&md);
            if !reliable {
                agg.approx = true;
            }

            if let Some(seen) = seen_identities.as_deref_mut() {
                let key = (a, b);
                if a == 0 && b == 0 {
                    agg.approx = true;
                    agg.physical += phys_len;
                } else if seen.insert(key) {
                    agg.physical += phys_len;
                } else {
                    agg.shared += phys_len;
                }
            } else {
                agg.physical += phys_len;
            }
        }
    }

    Ok(agg)
}

pub fn run_materialize_tasks_parallel(
    tasks: Vec<MaterializeTask>,
    strategy: LinkStrategy,
    jobs: usize,
    counters: &MaterializeCounters,
) -> Result<(), String> {
    if tasks.is_empty() {
        return Ok(());
    }
    let queue = Arc::new(Mutex::new(VecDeque::from(tasks)));
    let first_error = Arc::new(Mutex::new(None::<String>));
    let worker_count = jobs.max(1).min(queue.lock().map(|g| g.len()).unwrap_or(1).max(1));

    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let queue = Arc::clone(&queue);
            let first_error = Arc::clone(&first_error);
            scope.spawn(move || {
                loop {
                    if first_error
                        .lock()
                        .ok()
                        .and_then(|g| g.as_ref().cloned())
                        .is_some()
                    {
                        return;
                    }

                    let next_task = match queue.lock() {
                        Ok(mut guard) => guard.pop_front(),
                        Err(_) => return,
                    };
                    let Some(task) = next_task else { return };

                    let task_result = match task {
                        MaterializeTask::File(task) => {
                            counters.files.fetch_add(1, Ordering::Relaxed);
                            match strategy {
                                LinkStrategy::Copy => {
                                    if let Err(err) = copy_file_with_retry(&task.src, &task.dst) {
                                        Err(err)
                                    } else {
                                        counters.files_copied.fetch_add(1, Ordering::Relaxed);
                                        Ok(())
                                    }
                                }
                                LinkStrategy::Hardlink | LinkStrategy::Auto => {
                                    match hardlink_with_retry(&task.src, &task.dst) {
                                        Ok(()) => {
                                            counters.files_linked.fetch_add(1, Ordering::Relaxed);
                                            Ok(())
                                        }
                                        Err(link_err) => {
                                            if link_err.contains("EPERM") || link_err.contains("Operation not permitted") {
                                                counters.fallback_eperm.fetch_add(1, Ordering::Relaxed);
                                            } else if link_err.contains("EXDEV") || link_err.contains("cross-device") {
                                                counters.fallback_exdev.fetch_add(1, Ordering::Relaxed);
                                            } else {
                                                counters.fallback_other.fetch_add(1, Ordering::Relaxed);
                                            }
                                            if let Err(err) = copy_file_with_retry(&task.src, &task.dst) {
                                                Err(err)
                                            } else {
                                                counters.files_copied.fetch_add(1, Ordering::Relaxed);
                                                counters
                                                    .link_fallback_copies
                                                    .fetch_add(1, Ordering::Relaxed);
                                                Ok(())
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        MaterializeTask::Symlink(task) => match create_symlink_with_retry(&task) {
                            Ok(()) => {
                                counters.symlinks.fetch_add(1, Ordering::Relaxed);
                                Ok(())
                            }
                            Err(err) => Err(err),
                        },
                    };

                    if let Err(err) = task_result {
                        if let Ok(mut guard) = first_error.lock() {
                            if guard.is_none() {
                                *guard = Some(err);
                            }
                        }
                        return;
                    }
                }
            });
        }
    });

    let result = match first_error.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(err) => Err(err.clone()),
            None => Ok(()),
        },
        Err(_) => Err("materialize_worker_error_lock_poisoned".to_string()),
    };
    result
}

pub fn materialize_tree(
    src_root: &Path,
    dst_root: &Path,
    strategy: LinkStrategy,
    jobs: usize,
    profile: MaterializeProfile,
) -> Result<MaterializeReport, String> {
    let total_start = Instant::now();
    let mut phases = PhaseDurations::default();

    // Scan phase
    let scan_start = Instant::now();
    let mut directories: Vec<PathBuf> = vec![dst_root.to_path_buf()];
    let mut tasks: Vec<MaterializeTask> = Vec::new();
    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(src_root.to_path_buf(), dst_root.to_path_buf())];

    while let Some((src_dir, dst_dir)) = stack.pop() {
        let entries = stable_list_dir(&src_dir).map_err(|e| e.to_string())?;
        for ent in entries {
            let name = ent.file_name();
            let name_str = name.to_string_lossy();
            if name_str == "node_modules" || name_str == ".better_extracted" {
                continue;
            }

            let src = src_dir.join(&name);
            let dst = dst_dir.join(&name);
            let ft = ent.file_type().map_err(|e| e.to_string())?;

            if ft.is_dir() {
                directories.push(dst.clone());
                stack.push((src, dst));
                continue;
            }
            if ft.is_symlink() {
                let target = fs::read_link(&src).map_err(|e| e.to_string())?;
                tasks.push(MaterializeTask::Symlink(MaterializeSymlinkTask {
                    src,
                    dst,
                    target,
                }));
                continue;
            }
            if ft.is_file() {
                tasks.push(MaterializeTask::File(MaterializeFileTask { src, dst }));
                continue;
            }
        }
    }
    phases.scan_ms = scan_start.elapsed().as_millis() as u64;

    // Mkdir phase
    let mkdir_start = Instant::now();
    directories.sort();
    directories.dedup();
    for dir in &directories {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    phases.mkdir_ms = mkdir_start.elapsed().as_millis() as u64;

    // Adjust jobs based on profile
    let effective_jobs = match profile {
        MaterializeProfile::Auto => jobs,
        MaterializeProfile::IoHeavy => (jobs * 2).max(4),
        MaterializeProfile::SmallFiles => (jobs * 3).max(8),
    };

    // Link/copy phase
    let link_start = Instant::now();
    let counters = MaterializeCounters::default();
    run_materialize_tasks_parallel(tasks, strategy, effective_jobs, &counters)?;
    phases.link_copy_ms = link_start.elapsed().as_millis() as u64;

    phases.total_ms = total_start.elapsed().as_millis() as u64;

    let mut stats = counters.snapshot();
    stats.directories = directories.len().saturating_sub(1) as u64;
    Ok(MaterializeReport { stats, phases })
}

fn ensure_pkg_idx(
    pkg_dir: &PathBuf,
    pkg_dir_to_idx: &mut HashMap<PathBuf, Option<usize>>,
    by_key: &mut HashMap<String, usize>,
    packages: &mut Vec<PackageOut>,
    depths: &mut Vec<u64>,
) -> Option<usize> {
    if let Some(cached) = pkg_dir_to_idx.get(pkg_dir) {
        return *cached;
    }

    let (name, version) = match read_package_identity(pkg_dir) {
        Some(v) => v,
        None => {
            pkg_dir_to_idx.insert(pkg_dir.clone(), None);
            return None;
        }
    };
    let key = format!("{name}@{version}");
    let depth = depth_from_path(pkg_dir);

    let idx = if let Some(&i) = by_key.get(&key) {
        i
    } else {
        let i = packages.len();
        by_key.insert(key.clone(), i);
        packages.push(PackageOut {
            key,
            name,
            version,
            paths: Vec::new(),
            min_depth: depth,
            max_depth: depth,
            logical: 0,
            physical: 0,
            shared: 0,
            file_count: 0,
            approx: false,
        });
        i
    };

    let p = pkg_dir.to_string_lossy().to_string();
    if !packages[idx].paths.contains(&p) {
        packages[idx].paths.push(p);
        packages[idx].min_depth = packages[idx].min_depth.min(depth);
        packages[idx].max_depth = packages[idx].max_depth.max(depth);
        depths.push(depth);
    }

    pkg_dir_to_idx.insert(pkg_dir.clone(), Some(idx));
    Some(idx)
}

pub fn analyze(root: &Path, _include_graph: bool) -> Result<AnalyzeReport, String> {
    let node_modules_dir = root.join("node_modules");
    if !node_modules_dir.exists() {
        return Err("node_modules_not_found".to_string());
    }

    let mut totals = ScanAgg::default();
    let mut seen_global: HashSet<(u64, u64)> = HashSet::new();

    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut packages: Vec<PackageOut> = Vec::new();
    let mut depths: Vec<u64> = Vec::new();
    let mut pkg_dir_to_idx: HashMap<PathBuf, Option<usize>> = HashMap::new();

    let mut stack: Vec<(PathBuf, Option<usize>)> = vec![(node_modules_dir.clone(), None)];
    while let Some((dir, owner_idx)) = stack.pop() {
        let entries = match stable_list_dir(&dir) {
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
            let full = dir.join(&name);
            let ft = ent.file_type().map_err(|e| e.to_string())?;

            if ft.is_dir() || (ft.is_symlink() && fs::metadata(&full).map(|m| m.is_dir()).unwrap_or(false)) {
                let next_owner = if is_package_dir(&full) {
                    ensure_pkg_idx(&full, &mut pkg_dir_to_idx, &mut by_key, &mut packages, &mut depths)
                } else {
                    owner_idx
                };
                stack.push((full, next_owner));
                continue;
            }

            totals.file_count += 1;
            let md = fs::symlink_metadata(&full).map_err(|e| e.to_string())?;
            let logical_len = md.len();
            let phys_len = physical_len(&md);
            totals.logical = totals.logical.saturating_add(logical_len);

            let (a, b, reliable) = identity_key(&md);
            if !reliable {
                totals.approx = true;
            }

            if let Some(idx) = owner_idx {
                let pkg = &mut packages[idx];
                pkg.file_count = pkg.file_count.saturating_add(1);
                pkg.logical = pkg.logical.saturating_add(logical_len);
                if !reliable {
                    pkg.approx = true;
                }
            }

            if a == 0 && b == 0 {
                totals.approx = true;
                totals.physical = totals.physical.saturating_add(phys_len);
                if let Some(idx) = owner_idx {
                    let pkg = &mut packages[idx];
                    pkg.approx = true;
                    pkg.physical = pkg.physical.saturating_add(phys_len);
                }
                continue;
            }

            let first = seen_global.insert((a, b));
            if first {
                totals.physical = totals.physical.saturating_add(phys_len);
                if let Some(idx) = owner_idx {
                    packages[idx].physical = packages[idx].physical.saturating_add(phys_len);
                }
            } else {
                totals.shared = totals.shared.saturating_add(phys_len);
                if let Some(idx) = owner_idx {
                    packages[idx].shared = packages[idx].shared.saturating_add(phys_len);
                }
            }
        }
    }

    // Duplicates.
    let mut by_name: BTreeMap<String, Vec<&PackageOut>> = BTreeMap::new();
    for p in &packages {
        by_name.entry(p.name.clone()).or_default().push(p);
    }
    let mut duplicates: Vec<DuplicateOut> = Vec::new();
    for (name, list) in by_name {
        let mut versions: BTreeSet<String> = BTreeSet::new();
        for p in &list {
            versions.insert(p.version.clone());
        }
        if versions.len() <= 1 {
            continue;
        }
        let versions_vec: Vec<String> = versions.into_iter().collect();
        let majors_set: BTreeSet<String> = versions_vec
            .iter()
            .map(|v| v.split('.').next().unwrap_or("0").parse::<u64>().unwrap_or(0).to_string())
            .collect();
        duplicates.push(DuplicateOut {
            name,
            versions: versions_vec,
            majors: majors_set.into_iter().collect(),
            count: list.len() as u64,
        });
    }

    let max_depth = depths.iter().copied().max().unwrap_or(0);
    let p95_depth = percentile_p95(depths);
    let depth_out = DepthOut {
        max_depth,
        p95_depth,
    };

    Ok(AnalyzeReport {
        totals,
        packages,
        duplicates,
        depth: depth_out,
        node_modules_dir,
    })
}

// --- JSON serialization functions (used by binary) ---

pub fn write_analyze_json(
    project_root: &Path,
    totals: &ScanAgg,
    node_modules_dir: &Path,
    packages: &Vec<PackageOut>,
    duplicates: &Vec<DuplicateOut>,
    depth: &DepthOut,
    include_graph: bool,
) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("ok");
    w.value_bool(true);
    w.key("kind");
    w.value_string("better.analyze.report");
    w.key("schemaVersion");
    w.value_u64(1);
    w.key("projectRoot");
    w.value_string(&project_root.to_string_lossy());

    w.key("nodeModules");
    w.begin_object();
    w.key("path");
    w.value_string(&node_modules_dir.to_string_lossy());
    w.key("logicalBytes");
    w.value_u64(totals.logical);
    w.key("physicalBytes");
    w.value_u64(totals.physical);
    w.key("physicalBytesApprox");
    w.value_bool(totals.approx);
    w.key("fileCount");
    w.value_u64(totals.file_count);
    w.end_object();

    w.key("packages");
    w.begin_array();
    for p in packages {
        w.begin_object();
        w.key("key");
        w.value_string(&p.key);
        w.key("name");
        w.value_string(&p.name);
        w.key("version");
        w.value_string(&p.version);
        w.key("paths");
        w.begin_array();
        for pp in &p.paths {
            w.value_string(pp);
        }
        w.end_array();
        w.key("depthStats");
        w.begin_object();
        w.key("minDepth");
        w.value_u64(p.min_depth);
        w.key("maxDepth");
        w.value_u64(p.max_depth);
        w.end_object();
        w.key("sizes");
        w.begin_object();
        w.key("logicalBytes");
        w.value_u64(p.logical);
        w.key("physicalBytes");
        w.value_u64(p.physical);
        w.key("sharedBytes");
        w.value_u64(p.shared);
        w.key("physicalBytesApprox");
        w.value_bool(p.approx);
        w.key("fileCount");
        w.value_u64(p.file_count);
        w.end_object();
        w.end_object();
    }
    w.end_array();

    w.key("duplicates");
    w.begin_array();
    for d in duplicates {
        w.begin_object();
        w.key("name");
        w.value_string(&d.name);
        w.key("versions");
        w.begin_array();
        for v in &d.versions {
            w.value_string(v);
        }
        w.end_array();
        w.key("majors");
        w.begin_array();
        for m in &d.majors {
            w.value_string(m);
        }
        w.end_array();
        w.key("count");
        w.value_u64(d.count);
        w.end_object();
    }
    w.end_array();

    w.key("depth");
    w.begin_object();
    w.key("maxDepth");
    w.value_u64(depth.max_depth);
    w.key("p95Depth");
    w.value_u64(depth.p95_depth);
    w.end_object();

    w.key("graph");
    if include_graph {
        w.begin_object();
        w.key("nodes");
        w.begin_object();
        let mut nodes: BTreeMap<String, (String, String)> = BTreeMap::new();
        for p in packages {
            nodes.insert(p.key.clone(), (p.name.clone(), p.version.clone()));
        }
        for (k, (name, version)) in nodes {
            w.key(&k);
            w.begin_object();
            w.key("key");
            w.value_string(&k);
            w.key("name");
            w.value_string(&name);
            w.key("version");
            w.value_string(&version);
            w.end_object();
        }
        w.end_object();
        w.key("edges");
        w.begin_array();
        w.end_array();
        w.end_object();
    } else {
        w.value_null();
    }

    w.key("extensions");
    w.begin_object();
    w.key("generatedBy");
    w.begin_object();
    w.key("engine");
    w.value_string("better-core");
    w.key("version");
    w.value_string(VERSION);
    w.end_object();
    w.end_object();

    w.end_object();
    w.out.push('\n');
    w.finish()
}

pub fn write_scan_json(root: &Path, agg: &ScanAgg, ok: bool, reason: Option<String>) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("ok");
    w.value_bool(ok);
    w.key("rootDir");
    w.value_string(&root.to_string_lossy());
    w.key("reason");
    if let Some(r) = reason {
        w.value_string(&r);
    } else {
        w.value_null();
    }
    w.key("logicalBytes");
    w.value_u64(agg.logical);
    w.key("physicalBytes");
    w.value_u64(agg.physical);
    w.key("sharedBytes");
    w.value_u64(agg.shared);
    w.key("physicalBytesApprox");
    w.value_bool(agg.approx);
    w.key("fileCount");
    w.value_u64(agg.file_count);
    w.key("packageCount");
    w.value_u64(agg.package_count);
    w.end_object();
    w.out.push('\n');
    w.finish()
}

pub fn write_materialize_json(
    src: &Path,
    dest: &Path,
    strategy: LinkStrategy,
    jobs: usize,
    profile: MaterializeProfile,
    effective_jobs: usize,
    ok: bool,
    reason: Option<String>,
    duration_ms: u64,
    stats: &MaterializeStats,
    phases: &PhaseDurations,
) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("ok");
    w.value_bool(ok);
    w.key("kind");
    w.value_string("better.core.materialize");
    w.key("schemaVersion");
    w.value_u64(1);
    w.key("srcDir");
    w.value_string(&src.to_string_lossy());
    w.key("destDir");
    w.value_string(&dest.to_string_lossy());
    w.key("strategy");
    w.value_string(strategy.as_str());
    w.key("jobs");
    w.value_u64(jobs as u64);
    w.key("durationMs");
    w.value_u64(duration_ms);
    w.key("reason");
    if let Some(r) = reason {
        w.value_string(&r);
    } else {
        w.value_null();
    }
    w.key("stats");
    w.begin_object();
    w.key("files");
    w.value_u64(stats.files);
    w.key("filesLinked");
    w.value_u64(stats.files_linked);
    w.key("filesCopied");
    w.value_u64(stats.files_copied);
    w.key("linkFallbackCopies");
    w.value_u64(stats.link_fallback_copies);
    w.key("directories");
    w.value_u64(stats.directories);
    w.key("symlinks");
    w.value_u64(stats.symlinks);
    w.end_object();
    w.key("profile");
    w.value_string(profile.as_str());
    w.key("effectiveJobs");
    w.value_u64(effective_jobs as u64);
    w.key("phaseDurations");
    w.begin_object();
    w.key("scanMs");
    w.value_u64(phases.scan_ms);
    w.key("mkdirMs");
    w.value_u64(phases.mkdir_ms);
    w.key("linkCopyMs");
    w.value_u64(phases.link_copy_ms);
    w.end_object();
    w.key("fallbackReasons");
    w.begin_object();
    w.key("eperm");
    w.value_u64(stats.fallback_eperm);
    w.key("exdev");
    w.value_u64(stats.fallback_exdev);
    w.key("other");
    w.value_u64(stats.fallback_other);
    w.end_object();
    w.end_object();
    w.out.push('\n');
    w.finish()
}

// --- Bin links ---

/// Parse the "bin" field from a package.json string.
/// Returns Vec<(bin_name, relative_script_path)>.
fn parse_bin_field(pkg_json: &str, pkg_name: &str) -> Vec<(String, String)> {
    let mut bins = Vec::new();

    // Try "bin": "file.js" (string form)
    if let Some(bin_str) = extract_json_field(pkg_json, "bin") {
        // Check if it's a string (not an object — objects start with {)
        let trimmed = bin_str.trim();
        if !trimmed.starts_with('{') {
            // Use the package name (without scope) as the bin name
            let bin_name = if pkg_name.contains('/') {
                // @scope/name -> name
                pkg_name.rsplit('/').next().unwrap_or(pkg_name)
            } else {
                pkg_name
            };
            bins.push((bin_name.to_string(), trimmed.to_string()));
            return bins;
        }
    }

    // Try "bin": { "name": "file.js", ... } (object form)
    // Find "bin" key and parse the object
    let bin_needle = "\"bin\"";
    if let Some(bin_start) = pkg_json.find(bin_needle) {
        let after_bin = &pkg_json[bin_start + bin_needle.len()..];
        // Find the colon
        if let Some(colon) = after_bin.find(':') {
            let after_colon = after_bin[colon + 1..].trim_start();
            if after_colon.starts_with('{') {
                // Parse the object: find matching }
                let mut depth = 0;
                let mut in_string = false;
                let mut escape = false;
                let mut end_idx = 0;

                for (i, ch) in after_colon.char_indices() {
                    if escape {
                        escape = false;
                        continue;
                    }
                    if ch == '\\' && in_string {
                        escape = true;
                        continue;
                    }
                    if ch == '"' {
                        in_string = !in_string;
                        continue;
                    }
                    if in_string {
                        continue;
                    }
                    if ch == '{' {
                        depth += 1;
                    } else if ch == '}' {
                        depth -= 1;
                        if depth == 0 {
                            end_idx = i + 1;
                            break;
                        }
                    }
                }

                if end_idx > 0 {
                    let bin_obj = &after_colon[1..end_idx - 1]; // contents inside {}
                    // Parse key-value pairs
                    let mut key = String::new();
                    let mut val = String::new();
                    let mut reading_key = false;
                    let mut reading_val = false;
                    let mut in_str = false;
                    let mut esc = false;
                    let mut after_key_colon = false;

                    for ch in bin_obj.chars() {
                        if esc {
                            if reading_key {
                                key.push(ch);
                            } else if reading_val {
                                val.push(ch);
                            }
                            esc = false;
                            continue;
                        }
                        if ch == '\\' && in_str {
                            esc = true;
                            if reading_key {
                                key.push(ch);
                            } else if reading_val {
                                val.push(ch);
                            }
                            continue;
                        }
                        if ch == '"' {
                            if !in_str {
                                in_str = true;
                                if after_key_colon {
                                    reading_val = true;
                                } else {
                                    reading_key = true;
                                }
                            } else {
                                in_str = false;
                                if reading_val {
                                    reading_val = false;
                                    after_key_colon = false;
                                    if !key.is_empty() && !val.is_empty() {
                                        bins.push((key.clone(), val.clone()));
                                    }
                                    key.clear();
                                    val.clear();
                                } else if reading_key {
                                    reading_key = false;
                                }
                            }
                            continue;
                        }
                        if !in_str && ch == ':' {
                            after_key_colon = true;
                            continue;
                        }
                        if !in_str && (ch == ',' || ch.is_whitespace()) {
                            continue;
                        }
                        if reading_key {
                            key.push(ch);
                        } else if reading_val {
                            val.push(ch);
                        }
                    }
                }
            }
        }
    }

    // Try "directories.bin" field (less common)
    // Skip for now — covers 99%+ of packages

    bins
}

/// Create bin links in node_modules/.bin/ for all installed packages.
/// Scans each package's package.json for "bin" entries and creates symlinks.
pub fn create_bin_links(
    node_modules_dir: &Path,
    packages: &[ResolvedPackage],
) -> Result<BinLinkResult, String> {
    let bin_dir = node_modules_dir.join(".bin");
    fs::create_dir_all(&bin_dir).map_err(|e| format!("Failed to create .bin dir: {}", e))?;

    let mut result = BinLinkResult::default();

    for pkg in packages {
        // Determine package directory
        let pkg_dir = if pkg.rel_path.starts_with("node_modules/") {
            node_modules_dir.join(&pkg.rel_path[13..])
        } else {
            node_modules_dir.join(&pkg.rel_path)
        };

        let pkg_json_path = pkg_dir.join("package.json");
        let pkg_json = match fs::read_to_string(&pkg_json_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let bins = parse_bin_field(&pkg_json, &pkg.name);
        if bins.is_empty() {
            continue;
        }

        for (bin_name, bin_script) in &bins {
            let bin_target = pkg_dir.join(bin_script);
            let bin_link = bin_dir.join(bin_name);

            // Remove existing link/file
            let _ = fs::remove_file(&bin_link);

            #[cfg(unix)]
            {
                // Make the target executable
                if let Ok(md) = fs::metadata(&bin_target) {
                    use std::os::unix::fs::PermissionsExt;
                    let mut perms = md.permissions();
                    let mode = perms.mode() | 0o111;
                    perms.set_mode(mode);
                    let _ = fs::set_permissions(&bin_target, perms);
                }

                // Create relative symlink from .bin/name -> ../pkg/script
                let rel_target = pathdiff_relative(&bin_dir, &bin_target);
                match std::os::unix::fs::symlink(&rel_target, &bin_link) {
                    Ok(()) => result.links_created += 1,
                    Err(_) => result.links_failed += 1,
                }
            }

            #[cfg(windows)]
            {
                // On Windows, create a .cmd shim
                let cmd_link = bin_dir.join(format!("{}.cmd", bin_name));
                let rel_target = pathdiff_relative(&bin_dir, &bin_target);
                let shim_content = format!(
                    "@ECHO off\r\n\"%~dp0\\{}\" %*\r\n",
                    rel_target.to_string_lossy().replace('/', "\\")
                );
                match fs::write(&cmd_link, shim_content) {
                    Ok(()) => result.links_created += 1,
                    Err(_) => result.links_failed += 1,
                }
            }

            #[cfg(not(any(unix, windows)))]
            {
                result.links_failed += 1;
            }
        }
    }

    Ok(result)
}

/// Compute a relative path from `base` to `target`.
fn pathdiff_relative(base: &Path, target: &Path) -> PathBuf {
    // Canonicalize both paths for reliable relative path computation
    let base_abs = fs::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
    let target_abs = fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());

    let base_components: Vec<_> = base_abs.components().collect();
    let target_components: Vec<_> = target_abs.components().collect();

    // Find common prefix length
    let common_len = base_components
        .iter()
        .zip(target_components.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let mut rel = PathBuf::new();
    // Go up from base
    for _ in common_len..base_components.len() {
        rel.push("..");
    }
    // Go down to target
    for comp in &target_components[common_len..] {
        rel.push(comp.as_os_str());
    }

    if rel.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        rel
    }
}

// --- Lifecycle scripts ---

/// Detect lifecycle scripts (install, preinstall, postinstall) and binding.gyp
/// across all installed packages.
pub fn detect_lifecycle_scripts(
    node_modules_dir: &Path,
    packages: &[ResolvedPackage],
) -> LifecycleDetectionResult {
    let mut result = LifecycleDetectionResult::default();
    let lifecycle_names = ["preinstall", "install", "postinstall"];

    for pkg in packages {
        let pkg_dir = if pkg.rel_path.starts_with("node_modules/") {
            node_modules_dir.join(&pkg.rel_path[13..])
        } else {
            node_modules_dir.join(&pkg.rel_path)
        };

        let pkg_json_path = pkg_dir.join("package.json");
        let pkg_json = match fs::read_to_string(&pkg_json_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        // Check for binding.gyp
        if pkg_dir.join("binding.gyp").exists() {
            result.has_native_addons = true;
            result
                .packages_with_binding_gyp
                .push(pkg.name.clone());
        }

        // Check for gypfile field
        if pkg_json.contains("\"gypfile\"") && pkg_json.contains("true") {
            result.has_native_addons = true;
        }

        // Check for lifecycle scripts
        for script_name in &lifecycle_names {
            // Look for "scripts": { ... "install": "command" ... }
            if let Some(pos) = pkg_json.find("\"scripts\"") {
                let after_scripts = &pkg_json[pos..];
                if let Some(obj_start) = after_scripts.find('{') {
                    let scripts_section = &after_scripts[obj_start..];
                    if let Some(script_val) = extract_json_field(scripts_section, script_name) {
                        if !script_val.is_empty() {
                            result.has_native_addons = true;
                            result.scripts.push(LifecycleScriptInfo {
                                package_name: pkg.name.clone(),
                                package_dir: pkg_dir.clone(),
                                script_name: script_name.to_string(),
                                script_command: script_val,
                            });
                        }
                    }
                }
            }
        }
    }

    result
}

/// Run lifecycle scripts by delegating to `npm rebuild`.
/// Only runs if native addons were detected, saving ~600ms on projects without them.
pub fn run_lifecycle_scripts(
    project_root: &Path,
    detection: &LifecycleDetectionResult,
) -> LifecycleRunResult {
    if !detection.has_native_addons {
        return LifecycleRunResult {
            skipped_reason: Some("no_native_addons".to_string()),
            ..Default::default()
        };
    }

    // Delegate to npm rebuild for maximum compatibility
    let output = std::process::Command::new("npm")
        .args(["rebuild", "--no-audit", "--no-fund"])
        .current_dir(project_root)
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .status();

    match output {
        Ok(status) => {
            let code = status.code().unwrap_or(-1);
            LifecycleRunResult {
                scripts_run: 1,
                scripts_succeeded: if code == 0 { 1 } else { 0 },
                scripts_failed: if code != 0 { 1 } else { 0 },
                skipped_reason: None,
                rebuild_exit_code: Some(code),
            }
        }
        Err(e) => LifecycleRunResult {
            scripts_run: 0,
            scripts_succeeded: 0,
            scripts_failed: 1,
            skipped_reason: Some(format!("npm_not_found: {}", e)),
            rebuild_exit_code: None,
        },
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

