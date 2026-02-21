use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read as _, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// --- Types ---

#[derive(Debug, Clone, Copy)]
pub enum LinkStrategy {
    Auto,
    Hardlink,
    Copy,
}

impl LinkStrategy {
    pub fn from_arg(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "hardlink" => Some(Self::Hardlink),
            "copy" => Some(Self::Copy),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Hardlink => "hardlink",
            Self::Copy => "copy",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum MaterializeProfile {
    Auto,
    IoHeavy,
    SmallFiles,
}

impl MaterializeProfile {
    pub fn from_arg(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "io-heavy" => Some(Self::IoHeavy),
            "small-files" => Some(Self::SmallFiles),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::IoHeavy => "io-heavy",
            Self::SmallFiles => "small-files",
        }
    }
}

#[derive(Default, Clone)]
pub struct ScanAgg {
    pub logical: u64,
    pub physical: u64,
    pub shared: u64,
    pub file_count: u64,
    pub package_count: u64,
    pub approx: bool,
}

#[derive(Default, Clone)]
pub struct MaterializeStats {
    pub files: u64,
    pub files_linked: u64,
    pub files_copied: u64,
    pub link_fallback_copies: u64,
    pub directories: u64,
    pub symlinks: u64,
    pub fallback_eperm: u64,
    pub fallback_exdev: u64,
    pub fallback_other: u64,
}

#[derive(Default)]
pub struct PhaseDurations {
    pub scan_ms: u64,
    pub mkdir_ms: u64,
    pub link_copy_ms: u64,
    pub total_ms: u64,
}

#[derive(Default)]
pub struct MaterializeCounters {
    pub files: AtomicU64,
    pub files_linked: AtomicU64,
    pub files_copied: AtomicU64,
    pub link_fallback_copies: AtomicU64,
    pub symlinks: AtomicU64,
    pub fallback_eperm: AtomicU64,
    pub fallback_exdev: AtomicU64,
    pub fallback_other: AtomicU64,
}

impl MaterializeCounters {
    pub fn snapshot(&self) -> MaterializeStats {
        MaterializeStats {
            files: self.files.load(Ordering::Relaxed),
            files_linked: self.files_linked.load(Ordering::Relaxed),
            files_copied: self.files_copied.load(Ordering::Relaxed),
            link_fallback_copies: self.link_fallback_copies.load(Ordering::Relaxed),
            directories: 0,
            symlinks: self.symlinks.load(Ordering::Relaxed),
            fallback_eperm: self.fallback_eperm.load(Ordering::Relaxed),
            fallback_exdev: self.fallback_exdev.load(Ordering::Relaxed),
            fallback_other: self.fallback_other.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone)]
pub struct PackageOut {
    pub key: String,
    pub name: String,
    pub version: String,
    pub paths: Vec<String>,
    pub min_depth: u64,
    pub max_depth: u64,
    pub logical: u64,
    pub physical: u64,
    pub shared: u64,
    pub file_count: u64,
    pub approx: bool,
}

pub struct DuplicateOut {
    pub name: String,
    pub versions: Vec<String>,
    pub majors: Vec<String>,
    pub count: u64,
}

pub struct DepthOut {
    pub max_depth: u64,
    pub p95_depth: u64,
}

/// Aggregate return type for analyze()
pub struct AnalyzeReport {
    pub totals: ScanAgg,
    pub packages: Vec<PackageOut>,
    pub duplicates: Vec<DuplicateOut>,
    pub depth: DepthOut,
    pub node_modules_dir: PathBuf,
}

/// Aggregate return type for materialize_tree()
#[derive(Default)]
pub struct MaterializeReport {
    pub stats: MaterializeStats,
    pub phases: PhaseDurations,
}

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

#[derive(Clone)]
pub struct MaterializeFileTask {
    pub src: PathBuf,
    pub dst: PathBuf,
}

#[derive(Clone)]
pub struct MaterializeSymlinkTask {
    pub src: PathBuf,
    pub dst: PathBuf,
    pub target: PathBuf,
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

pub enum MaterializeTask {
    File(MaterializeFileTask),
    Symlink(MaterializeSymlinkTask),
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

// --- Install engine: resolve and fetch ---

#[derive(Clone)]
pub struct ResolvedPackage {
    pub name: String,
    pub version: String,
    pub rel_path: String,
    pub resolved_url: String,
    pub integrity: String,
}

#[derive(Clone)]
pub struct ResolveResult {
    pub packages: Vec<ResolvedPackage>,
    pub lockfile_version: u64,
}

/// Parse package-lock.json and extract packages to install
pub fn resolve_from_lockfile(lockfile_path: &Path) -> Result<ResolveResult, String> {
    let content = fs::read_to_string(lockfile_path).map_err(|e| e.to_string())?;

    // Simple JSON parsing without serde
    let packages = parse_npm_lockfile(&content)?;

    Ok(ResolveResult {
        packages,
        lockfile_version: 3,
    })
}

fn parse_npm_lockfile(json: &str) -> Result<Vec<ResolvedPackage>, String> {
    let mut packages = Vec::new();

    // Find the "packages" object
    let packages_start = json
        .find(r#""packages""#)
        .ok_or_else(|| "Missing 'packages' field in lockfile".to_string())?;

    let after_packages = &json[packages_start..];
    let obj_start = after_packages
        .find('{')
        .ok_or_else(|| "Malformed packages object".to_string())?;

    // Simple state machine to parse package entries
    let packages_str = &after_packages[obj_start..];
    let mut current_key = String::new();
    let mut in_string = false;
    let mut escape_next = false;
    let mut brace_depth = 0i32;
    let mut collecting_entry = false;
    let mut entry_data = String::new();
    // State for key tracking at depth 1:
    // 0 = waiting for opening quote, 1 = reading key, 2 = key done (waiting for ':' then value)
    let mut key_state = 0u8;

    for ch in packages_str.chars() {
        if escape_next {
            if key_state == 1 {
                current_key.push(ch);
            } else if collecting_entry {
                entry_data.push(ch);
            }
            escape_next = false;
            continue;
        }

        if ch == '\\' && in_string {
            escape_next = true;
            if key_state == 1 {
                current_key.push(ch);
            } else if collecting_entry {
                entry_data.push(ch);
            }
            continue;
        }

        if ch == '"' {
            in_string = !in_string;

            if brace_depth == 1 && !collecting_entry {
                // Key tracking at depth 1
                if key_state == 0 && in_string {
                    // Opening quote of a key
                    key_state = 1;
                    current_key.clear();
                } else if key_state == 1 && !in_string {
                    // Closing quote of a key
                    key_state = 2;
                } else if key_state == 2 && in_string {
                    // Opening quote of a string value at depth 1 — skip
                } else if key_state == 2 && !in_string {
                    // Closing quote of a string value at depth 1
                }
            } else if collecting_entry {
                entry_data.push(ch);
            }
            continue;
        }

        if in_string {
            if key_state == 1 {
                current_key.push(ch);
            } else if collecting_entry {
                entry_data.push(ch);
            }
            continue;
        }

        // Not in string
        if ch == '{' {
            brace_depth += 1;
            if brace_depth == 2 {
                if !current_key.is_empty()
                    && current_key.starts_with("node_modules/")
                {
                    collecting_entry = true;
                    entry_data.clear();
                }
                key_state = 0;
            }
            if collecting_entry && brace_depth > 2 {
                entry_data.push(ch);
            }
        } else if ch == '}' {
            if collecting_entry && brace_depth == 2 {
                // Parse this entry
                if let Ok(pkg) = parse_package_entry(&current_key, &entry_data) {
                    packages.push(pkg);
                }
                collecting_entry = false;
                entry_data.clear();
            } else if collecting_entry {
                entry_data.push(ch);
            }
            brace_depth -= 1;
            if brace_depth == 0 {
                break;
            }
            if brace_depth == 1 {
                key_state = 0; // Ready for next key
            }
        } else if ch == ',' && brace_depth == 1 && !collecting_entry {
            key_state = 0; // Ready for next key after comma
        } else if collecting_entry {
            entry_data.push(ch);
        }
    }

    Ok(packages)
}

fn parse_package_entry(rel_path: &str, entry_json: &str) -> Result<ResolvedPackage, String> {
    let name = extract_json_field(entry_json, "name")
        .unwrap_or_else(|| package_name_from_path(rel_path));
    let version = extract_json_field(entry_json, "version")
        .ok_or_else(|| format!("Missing version for {}", rel_path))?;
    let resolved = extract_json_field(entry_json, "resolved")
        .ok_or_else(|| format!("Missing resolved URL for {}", rel_path))?;
    let integrity = extract_json_field(entry_json, "integrity")
        .ok_or_else(|| format!("Missing integrity for {}", rel_path))?;

    Ok(ResolvedPackage {
        name,
        version,
        rel_path: rel_path.to_string(),
        resolved_url: resolved,
        integrity,
    })
}

fn extract_json_field(json: &str, field_name: &str) -> Option<String> {
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

fn package_name_from_path(rel_path: &str) -> String {
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

#[derive(Clone)]
pub struct FetchResult {
    pub packages_fetched: u64,
    pub packages_cached: u64,
    pub bytes_downloaded: u64,
}

/// Content-addressed store layout
pub struct CasLayout {
    pub tarballs_dir: PathBuf,
    pub unpacked_dir: PathBuf,
    pub tmp_dir: PathBuf,
}

impl CasLayout {
    pub fn new(cache_dir: &Path) -> Self {
        Self {
            tarballs_dir: cache_dir.join("store").join("tarballs"),
            unpacked_dir: cache_dir.join("store").join("unpacked"),
            tmp_dir: cache_dir.join("tmp"),
        }
    }
}

/// Parse integrity string (e.g., "sha512-base64...") into (algorithm, hex_string)
pub fn cas_key_from_integrity(integrity: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = integrity.splitn(2, '-').collect();
    if parts.len() != 2 {
        return None;
    }

    let algo = parts[0];
    let base64_hash = parts[1];

    // Decode base64 to bytes
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, base64_hash).ok()?;

    // Convert to hex string
    let hex = bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>();

    Some((algo.to_string(), hex))
}

/// Get tarball path in CAS layout: tarballs_dir/algo/aa/bb/hex.tgz
pub fn tarball_path(layout: &CasLayout, algo: &str, hex: &str) -> PathBuf {
    let aa = &hex[0..2.min(hex.len())];
    let bb = &hex[2..4.min(hex.len())];
    layout.tarballs_dir.join(algo).join(aa).join(bb).join(format!("{}.tgz", hex))
}

/// Get unpacked path in CAS layout: unpacked_dir/algo/aa/bb/hex
pub fn unpacked_path(layout: &CasLayout, algo: &str, hex: &str) -> PathBuf {
    let aa = &hex[0..2.min(hex.len())];
    let bb = &hex[2..4.min(hex.len())];
    layout.unpacked_dir.join(algo).join(aa).join(bb).join(hex)
}

/// Fetch tarballs for resolved packages with parallel downloads and CAS storage
pub fn fetch_packages(
    packages: &[ResolvedPackage],
    cache_dir: &Path,
) -> Result<FetchResult, String> {
    use rayon::prelude::*;
    use sha2::{Digest, Sha512};

    let layout = CasLayout::new(cache_dir);

    // Ensure directories exist
    fs::create_dir_all(&layout.tarballs_dir).map_err(|e| format!("Failed to create tarballs dir: {}", e))?;
    fs::create_dir_all(&layout.unpacked_dir).map_err(|e| format!("Failed to create unpacked dir: {}", e))?;
    fs::create_dir_all(&layout.tmp_dir).map_err(|e| format!("Failed to create tmp dir: {}", e))?;

    // Shared statistics
    let packages_fetched = AtomicU64::new(0);
    let packages_cached = AtomicU64::new(0);
    let bytes_downloaded = AtomicU64::new(0);

    // Process packages in parallel
    packages.par_iter().try_for_each(|pkg| -> Result<(), String> {
        // Parse integrity
        let (algo, hex) = cas_key_from_integrity(&pkg.integrity)
            .ok_or_else(|| format!("Invalid integrity format: {}", pkg.integrity))?;

        let tarball = tarball_path(&layout, &algo, &hex);
        let unpacked = unpacked_path(&layout, &algo, &hex);
        let verified_marker = tarball.with_extension("tgz.verified");
        let extracted_marker = unpacked.join(".better_extracted");

        // Check if already cached and verified
        if verified_marker.exists() && extracted_marker.exists() {
            packages_cached.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }

        // Download if needed
        if !tarball.exists() || !verified_marker.exists() {
            // Ensure parent directory exists
            if let Some(parent) = tarball.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("Failed to create tarball parent dir: {}", e))?;
            }

            // Download to temporary file
            let tmp_file = layout.tmp_dir.join(format!("{}.tgz.tmp", hex));
            let agent = ureq::AgentBuilder::new().build();

            let response = agent.get(&pkg.resolved_url)
                .call()
                .map_err(|e| format!("Failed to download {}: {}", pkg.name, e))?;

            let mut file = fs::File::create(&tmp_file)
                .map_err(|e| format!("Failed to create tmp file: {}", e))?;

            let mut bytes_written = 0u64;
            let mut buffer = vec![0u8; 8192];
            let mut reader = response.into_reader();

            loop {
                let n = reader.read(&mut buffer)
                    .map_err(|e| format!("Failed to read download: {}", e))?;
                if n == 0 {
                    break;
                }
                file.write_all(&buffer[..n])
                    .map_err(|e| format!("Failed to write to tmp file: {}", e))?;
                bytes_written += n as u64;
            }

            bytes_downloaded.fetch_add(bytes_written, Ordering::Relaxed);

            // Verify integrity
            let mut file = fs::File::open(&tmp_file)
                .map_err(|e| format!("Failed to open tmp file for verification: {}", e))?;
            let mut hasher = Sha512::new();
            let mut buffer = vec![0u8; 8192];

            loop {
                let n = file.read(&mut buffer)
                    .map_err(|e| format!("Failed to read for hash: {}", e))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buffer[..n]);
            }

            let computed_hex = format!("{:x}", hasher.finalize());

            if algo == "sha512" && computed_hex != hex {
                return Err(format!("Integrity mismatch for {}: expected {}, got {}", pkg.name, hex, computed_hex));
            }

            // Move to final location
            fs::rename(&tmp_file, &tarball)
                .map_err(|e| format!("Failed to move tarball to CAS: {}", e))?;

            // Write verified marker
            fs::write(&verified_marker, "")
                .map_err(|e| format!("Failed to write verified marker: {}", e))?;

            packages_fetched.fetch_add(1, Ordering::Relaxed);
        } else {
            packages_cached.fetch_add(1, Ordering::Relaxed);
        }

        // Extract if needed
        if !extracted_marker.exists() {
            // Ensure unpacked directory exists
            fs::create_dir_all(&unpacked)
                .map_err(|e| format!("Failed to create unpacked dir: {}", e))?;

            let file = fs::File::open(&tarball)
                .map_err(|e| format!("Failed to open tarball for extraction: {}", e))?;

            let gz = flate2::read::GzDecoder::new(file);
            let mut archive = tar::Archive::new(gz);

            archive.unpack(&unpacked)
                .map_err(|e| format!("Failed to extract tarball: {}", e))?;

            // Write extracted marker
            fs::write(&extracted_marker, "")
                .map_err(|e| format!("Failed to write extracted marker: {}", e))?;
        }

        Ok(())
    })?;

    Ok(FetchResult {
        packages_fetched: packages_fetched.load(Ordering::Relaxed),
        packages_cached: packages_cached.load(Ordering::Relaxed),
        bytes_downloaded: bytes_downloaded.load(Ordering::Relaxed),
    })
}

// --- File-level CAS (Content Addressable Store) ---

#[derive(Debug, Clone)]
pub struct FileCasIngestResult {
    pub total_files: u64,
    pub new_files: u64,
    pub existing_files: u64,
    pub total_bytes: u64,
    pub reused: bool,
}

#[derive(Debug, Clone)]
pub struct FileCasMaterializeResult {
    pub ok: bool,
    pub files: u64,
    pub linked: u64,
    pub copied: u64,
    pub symlinks: u64,
}

/// Get the store path for a file by its SHA-256 content hash.
fn file_store_path(store_root: &Path, hex: &str) -> PathBuf {
    let a = &hex[0..2];
    let b = &hex[2..4];
    store_root
        .join("files")
        .join("sha256")
        .join(a)
        .join(b)
        .join(hex)
}

/// Get the manifest directory for a package.
fn package_manifest_dir(store_root: &Path, algorithm: &str, pkg_hex: &str) -> PathBuf {
    let a = &pkg_hex[0..2];
    let b = &pkg_hex[2..4];
    store_root
        .join("packages")
        .join(algorithm)
        .join(a)
        .join(b)
        .join(pkg_hex)
}

/// Get the manifest path for a package.
fn package_manifest_path(store_root: &Path, algorithm: &str, pkg_hex: &str) -> PathBuf {
    package_manifest_dir(store_root, algorithm, pkg_hex).join("manifest.json")
}

/// Compute SHA-256 hash of a file, return hex string.
fn hash_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let mut file = fs::File::open(path)
        .map_err(|e| format!("Failed to open file for hashing: {}", e))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let n = file.read(&mut buffer)
            .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// Ingest an unpacked package directory into the file-level CAS.
/// Hashes each file with SHA-256, stores unique files in the global store,
/// and writes a package manifest mapping relative paths -> file hashes.
pub fn ingest_to_file_cas(
    store_root: &Path,
    pkg_algorithm: &str,
    pkg_hex: &str,
    unpacked_dir: &Path,
) -> Result<FileCasIngestResult, String> {
    let manifest_path = package_manifest_path(store_root, pkg_algorithm, pkg_hex);

    // If manifest already exists, return early with reused flag
    if manifest_path.exists() {
        // Count files in existing manifest
        let content = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read existing manifest: {}", e))?;

        // Simple count of "type":"file" occurrences
        let file_count = content.matches(r#""type":"file""#).count() as u64;

        return Ok(FileCasIngestResult {
            total_files: file_count,
            new_files: 0,
            existing_files: file_count,
            total_bytes: 0,
            reused: true,
        });
    }

    // Collect all files to process
    let mut files_to_process = Vec::new();

    fn walk_dir(
        dir: &Path,
        rel_prefix: &str,
        files: &mut Vec<(PathBuf, String)>,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir)
            .map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();

            // Skip node_modules and .better_extracted
            if name == "node_modules" || name == ".better_extracted" {
                continue;
            }

            let full_path = entry.path();
            let rel_path = if rel_prefix.is_empty() {
                name.to_string()
            } else {
                format!("{}/{}", rel_prefix, name)
            };

            let metadata = entry.metadata()
                .map_err(|e| format!("Failed to read metadata: {}", e))?;

            if metadata.is_dir() {
                walk_dir(&full_path, &rel_path, files)?;
            } else if metadata.is_file() {
                files.push((full_path, rel_path));
            }
            // Symlinks will be handled separately
        }

        Ok(())
    }

    walk_dir(unpacked_dir, "", &mut files_to_process)?;

    // Process files in parallel using rayon
    use rayon::prelude::*;

    let results: Vec<Result<(String, String, u64, u32, bool), String>> = files_to_process
        .par_iter()
        .map(|(full_path, rel_path)| -> Result<(String, String, u64, u32, bool), String> {
            let hex = hash_file(full_path)?;
            let store_path = file_store_path(store_root, &hex);

            let metadata = fs::metadata(full_path)
                .map_err(|e| format!("Failed to read file metadata: {}", e))?;

            let size = metadata.len();
            let mode = get_file_mode(&metadata);

            let is_new = if !store_path.exists() {
                // Create parent directories
                if let Some(parent) = store_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create store directory: {}", e))?;
                }

                // Atomic write: write to tmp, then rename
                let tmp_path = format!("{}.tmp-{}", store_path.display(), std::process::id());
                fs::copy(full_path, &tmp_path)
                    .map_err(|e| format!("Failed to copy file to store: {}", e))?;

                match fs::rename(&tmp_path, &store_path) {
                    Ok(_) => true,
                    Err(_) => {
                        // Another process may have created it - that's fine
                        let _ = fs::remove_file(&tmp_path);
                        false
                    }
                }
            } else {
                false
            };

            Ok((rel_path.clone(), hex, size, mode, is_new))
        })
        .collect();

    // Collect statistics and file entries
    let mut total_files = 0u64;
    let mut new_files = 0u64;
    let mut existing_files = 0u64;
    let mut total_bytes = 0u64;
    let mut file_entries = Vec::new();

    for result in results {
        let (rel_path, hex, size, mode, is_new) = result?;
        total_files += 1;
        total_bytes += size;

        if is_new {
            new_files += 1;
        } else {
            existing_files += 1;
        }

        file_entries.push((rel_path, hex, size, mode));
    }

    // Handle symlinks (can't be parallelized safely)
    let mut symlink_entries = Vec::new();

    fn collect_symlinks(
        dir: &Path,
        rel_prefix: &str,
        symlinks: &mut Vec<(String, String)>,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir)
            .map_err(|e| format!("Failed to read directory for symlinks: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();

            if name == "node_modules" || name == ".better_extracted" {
                continue;
            }

            let full_path = entry.path();
            let rel_path = if rel_prefix.is_empty() {
                name.to_string()
            } else {
                format!("{}/{}", rel_prefix, name)
            };

            let metadata = entry.metadata()
                .map_err(|e| format!("Failed to read metadata: {}", e))?;

            if metadata.is_dir() {
                collect_symlinks(&full_path, &rel_path, symlinks)?;
            } else if metadata.file_type().is_symlink() {
                let target = fs::read_link(&full_path)
                    .map_err(|e| format!("Failed to read symlink: {}", e))?;
                symlinks.push((rel_path, target.to_string_lossy().to_string()));
            }
        }

        Ok(())
    }

    collect_symlinks(unpacked_dir, "", &mut symlink_entries)?;

    // Build manifest JSON using JsonWriter
    let mut jw = JsonWriter::new();
    jw.begin_object();

    jw.key("version");
    jw.value_u64(1);

    jw.key("pkgAlgorithm");
    jw.value_string(pkg_algorithm);

    jw.key("pkgHex");
    jw.value_string(pkg_hex);

    jw.key("files");
    jw.begin_object();

    // Add file entries
    for (rel_path, hex, size, mode) in file_entries {
        jw.key(&rel_path);
        jw.begin_object();
        jw.key("type");
        jw.value_string("file");
        jw.key("hash");
        jw.value_string(&hex);
        jw.key("size");
        jw.value_u64(size);
        jw.key("mode");
        jw.value_u64(mode as u64);
        jw.end_object();
    }

    // Add symlink entries
    for (rel_path, target) in symlink_entries {
        jw.key(&rel_path);
        jw.begin_object();
        jw.key("type");
        jw.value_string("symlink");
        jw.key("target");
        jw.value_string(&target);
        jw.end_object();
    }

    jw.end_object(); // files

    jw.key("createdAt");
    jw.value_string(&chrono_now());

    jw.key("fileCount");
    jw.value_u64(total_files);

    jw.end_object();

    let manifest_json = jw.finish();

    // Write manifest atomically
    let manifest_dir = package_manifest_dir(store_root, pkg_algorithm, pkg_hex);
    fs::create_dir_all(&manifest_dir)
        .map_err(|e| format!("Failed to create manifest directory: {}", e))?;

    let tmp_manifest = format!("{}.tmp-{}", manifest_path.display(), std::process::id());
    fs::write(&tmp_manifest, manifest_json)
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    fs::rename(&tmp_manifest, &manifest_path)
        .map_err(|e| format!("Failed to rename manifest: {}", e))?;

    Ok(FileCasIngestResult {
        total_files,
        new_files,
        existing_files,
        total_bytes,
        reused: false,
    })
}

/// Materialize a package from file CAS to a destination directory.
/// Creates hardlinks from the global store, falling back to copy.
pub fn materialize_from_file_cas(
    store_root: &Path,
    pkg_algorithm: &str,
    pkg_hex: &str,
    dest_dir: &Path,
    link_strategy: LinkStrategy,
) -> Result<FileCasMaterializeResult, String> {
    let manifest_path = package_manifest_path(store_root, pkg_algorithm, pkg_hex);

    // Read manifest
    let manifest_content = match fs::read_to_string(&manifest_path) {
        Ok(content) => content,
        Err(_) => {
            return Ok(FileCasMaterializeResult {
                ok: false,
                files: 0,
                linked: 0,
                copied: 0,
                symlinks: 0,
            });
        }
    };

    // Parse manifest to extract file entries from the "files" object.
    // Works with single-line JSON (produced by JsonWriter).
    // Format: {"version":1,...,"files":{"rel/path":{"type":"file","hash":"abc","size":1,"mode":420},...}}

    let mut file_entries = Vec::new();
    let mut symlink_entries = Vec::new();

    // Find the "files" object
    if let Some(files_start) = manifest_content.find("\"files\"") {
        let after_files = &manifest_content[files_start + 7..]; // skip "files"
        if let Some(obj_start) = after_files.find('{') {
            let files_section = &after_files[obj_start..];

            // State machine to extract entries from the files object
            let mut depth = 0i32;
            let mut in_string = false;
            let mut escape_next = false;
            let mut current_key = String::new();
            let mut current_entry = String::new();
            let mut reading_key = false;
            let mut collecting_entry = false;
            let mut key_done = false;

            for ch in files_section.chars() {
                if escape_next {
                    if reading_key {
                        current_key.push(ch);
                    } else if collecting_entry {
                        current_entry.push(ch);
                    }
                    escape_next = false;
                    continue;
                }

                if ch == '\\' && in_string {
                    escape_next = true;
                    if reading_key {
                        current_key.push(ch);
                    } else if collecting_entry {
                        current_entry.push(ch);
                    }
                    continue;
                }

                if ch == '"' {
                    in_string = !in_string;
                    if depth == 1 && !collecting_entry {
                        if !key_done && in_string {
                            reading_key = true;
                            current_key.clear();
                        } else if !key_done && !in_string {
                            reading_key = false;
                            key_done = true;
                        }
                    } else if collecting_entry {
                        current_entry.push(ch);
                    }
                    continue;
                }

                if in_string {
                    if reading_key {
                        current_key.push(ch);
                    } else if collecting_entry {
                        current_entry.push(ch);
                    }
                    continue;
                }

                // Outside string
                if ch == '{' {
                    depth += 1;
                    if depth == 2 && key_done {
                        collecting_entry = true;
                        current_entry.clear();
                    } else if depth > 2 && collecting_entry {
                        current_entry.push(ch);
                    }
                } else if ch == '}' {
                    if depth == 2 && collecting_entry {
                        // Parse this entry
                        let entry_type = if current_entry.contains("\"type\":\"file\"") {
                            "file"
                        } else if current_entry.contains("\"type\":\"symlink\"") {
                            "symlink"
                        } else {
                            ""
                        };

                        if entry_type == "file" {
                            if let Some(hash) =
                                extract_json_field(&current_entry, "hash")
                            {
                                file_entries
                                    .push((current_key.clone(), hash));
                            }
                        } else if entry_type == "symlink" {
                            if let Some(tgt) =
                                extract_json_field(&current_entry, "target")
                            {
                                symlink_entries
                                    .push((current_key.clone(), tgt));
                            }
                        }

                        collecting_entry = false;
                        current_entry.clear();
                        key_done = false;
                    } else if depth > 2 && collecting_entry {
                        current_entry.push(ch);
                    }
                    depth -= 1;
                    if depth == 0 {
                        break; // End of "files" object
                    }
                } else if ch == ',' && depth == 1 {
                    key_done = false;
                } else if collecting_entry {
                    current_entry.push(ch);
                }
            }
        }
    }

    // Collect all directories needed (sorted shortest-first)
    let mut dirs_needed = HashSet::new();
    dirs_needed.insert(dest_dir.to_path_buf());

    for (rel_path, _) in &file_entries {
        if let Some(parent_str) = Path::new(rel_path).parent() {
            if parent_str.as_os_str().len() > 0 {
                dirs_needed.insert(dest_dir.join(parent_str));
            }
        }
    }

    for (rel_path, _) in &symlink_entries {
        if let Some(parent_str) = Path::new(rel_path).parent() {
            if parent_str.as_os_str().len() > 0 {
                dirs_needed.insert(dest_dir.join(parent_str));
            }
        }
    }

    let mut sorted_dirs: Vec<PathBuf> = dirs_needed.into_iter().collect();
    sorted_dirs.sort_by_key(|p| p.as_os_str().len());

    // Create all directories
    for dir in sorted_dirs {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // Materialize files in parallel using rayon
    use rayon::prelude::*;

    let file_count = AtomicU64::new(0);
    let linked_count = AtomicU64::new(0);
    let copied_count = AtomicU64::new(0);

    file_entries
        .par_iter()
        .for_each(|(rel_path, hash)| {
            let store_path = file_store_path(store_root, hash);
            let dest_path = dest_dir.join(rel_path);

            file_count.fetch_add(1, Ordering::Relaxed);

            match link_strategy {
                LinkStrategy::Copy => {
                    if fs::copy(&store_path, &dest_path).is_ok() {
                        copied_count.fetch_add(1, Ordering::Relaxed);
                    }
                }
                LinkStrategy::Hardlink | LinkStrategy::Auto => {
                    match fs::hard_link(&store_path, &dest_path) {
                        Ok(_) => {
                            linked_count.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(_) => {
                            if fs::copy(&store_path, &dest_path).is_ok() {
                                copied_count.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                }
            }
        });

    let mut stats = FileCasMaterializeResult {
        ok: true,
        files: file_count.load(Ordering::Relaxed),
        linked: linked_count.load(Ordering::Relaxed),
        copied: copied_count.load(Ordering::Relaxed),
        symlinks: 0,
    };

    // Create symlinks
    for (rel_path, target) in symlink_entries {
        let dest_path = dest_dir.join(&rel_path);

        // Remove existing file/link if present
        let _ = fs::remove_file(&dest_path);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &dest_path)
                .map_err(|e| format!("Failed to create symlink: {}", e))?;
        }

        #[cfg(windows)]
        {
            // On Windows, try to determine if target is a directory
            let target_path = if Path::new(&target).is_absolute() {
                PathBuf::from(&target)
            } else {
                dest_path.parent().unwrap_or(dest_dir).join(&target)
            };

            if target_path.is_dir() {
                std::os::windows::fs::symlink_dir(&target, &dest_path)
                    .map_err(|e| format!("Failed to create directory symlink: {}", e))?;
            } else {
                std::os::windows::fs::symlink_file(&target, &dest_path)
                    .map_err(|e| format!("Failed to create file symlink: {}", e))?;
            }
        }

        stats.symlinks += 1;
    }

    Ok(stats)
}

// --- Bin links ---

#[derive(Debug, Clone, Default)]
pub struct BinLinkResult {
    pub links_created: u64,
    pub links_failed: u64,
}

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

#[derive(Debug, Clone)]
pub struct LifecycleScriptInfo {
    pub package_name: String,
    pub package_dir: PathBuf,
    pub script_name: String,
    pub script_command: String,
}

#[derive(Debug, Clone, Default)]
pub struct LifecycleDetectionResult {
    pub has_native_addons: bool,
    pub scripts: Vec<LifecycleScriptInfo>,
    pub packages_with_binding_gyp: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct LifecycleRunResult {
    pub scripts_run: u64,
    pub scripts_succeeded: u64,
    pub scripts_failed: u64,
    pub skipped_reason: Option<String>,
    pub rebuild_exit_code: Option<i32>,
}

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
fn get_file_mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode()
}

#[cfg(not(unix))]
fn get_file_mode(_metadata: &fs::Metadata) -> u32 {
    0o644 // Default mode for non-Unix systems
}

// Helper function to get current timestamp in ISO format
fn chrono_now() -> String {
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

#[derive(Debug)]
pub struct ScriptRunResult {
    pub script_name: String,
    pub command: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

pub fn read_package_json_scripts(project_root: &Path) -> Result<Vec<(String, String)>, String> {
    let pkg_json = project_root.join("package.json");
    let content = fs::read_to_string(&pkg_json)
        .map_err(|e| format!("Failed to read package.json: {}", e))?;
    extract_json_object_pairs(&content, "scripts")
}

/// Extract all key-value string pairs from a named JSON object field.
/// E.g. for "scripts": {"test": "jest", "build": "tsc"} returns [("test","jest"), ("build","tsc")]
fn extract_json_object_pairs(json: &str, object_name: &str) -> Result<Vec<(String, String)>, String> {
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
fn extract_json_object_raw(json: &str, field_name: &str) -> Option<String> {
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

// --- B.2: License Scanner ---

#[derive(Debug, Clone)]
pub struct LicenseInfo {
    pub name: String,
    pub version: String,
    pub license: String,
}

#[derive(Debug)]
pub struct LicenseReport {
    pub packages: Vec<LicenseInfo>,
    pub by_license: BTreeMap<String, u64>,
    pub total_packages: u64,
    pub violations: Vec<LicenseInfo>,
}

pub fn scan_licenses(node_modules: &Path, allow: &[String], deny: &[String]) -> Result<LicenseReport, String> {
    let pkg_dirs = list_packages_in_node_modules(node_modules)?;
    let mut packages = Vec::new();
    let mut by_license: BTreeMap<String, u64> = BTreeMap::new();
    let mut violations = Vec::new();

    for pkg_dir in &pkg_dirs {
        let pkg_json = pkg_dir.join("package.json");
        let content = match fs::read_to_string(&pkg_json) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let name = extract_json_field(&content, "name").unwrap_or_else(|| "unknown".to_string());
        let version = extract_json_field(&content, "version").unwrap_or_else(|| "0.0.0".to_string());
        let license = extract_json_field(&content, "license").unwrap_or_else(|| "UNLICENSED".to_string());

        *by_license.entry(license.clone()).or_insert(0) += 1;

        let info = LicenseInfo { name, version, license: license.clone() };

        let is_violation = if !deny.is_empty() {
            deny.iter().any(|d| d.eq_ignore_ascii_case(&license))
        } else if !allow.is_empty() {
            !allow.iter().any(|a| a.eq_ignore_ascii_case(&license))
        } else {
            false
        };
        if is_violation {
            violations.push(info.clone());
        }

        packages.push(info);
    }

    let total = packages.len() as u64;
    Ok(LicenseReport { packages, by_license, total_packages: total, violations })
}

// --- B.3: Dedupe Checker ---

#[derive(Debug)]
pub struct DedupeEntry {
    pub name: String,
    pub versions: Vec<String>,
    pub instances: u64,
    pub can_dedupe: bool,
    pub saved_instances: u64,
}

#[derive(Debug)]
pub struct DedupeReport {
    pub duplicates: Vec<DedupeEntry>,
    pub total_duplicates: u64,
    pub deduplicatable: u64,
    pub estimated_saved: u64,
}

pub fn check_dedupe(root: &Path) -> Result<DedupeReport, String> {
    let report = analyze(root, false)?;
    let mut entries = Vec::new();
    let mut total_dup = 0u64;
    let mut dedup_count = 0u64;
    let mut estimated_saved = 0u64;

    for d in &report.duplicates {
        let can_dedupe = d.majors.len() == 1;
        let saved = if can_dedupe { d.count.saturating_sub(1) } else { 0 };

        total_dup += 1;
        if can_dedupe { dedup_count += 1; }
        estimated_saved += saved;

        entries.push(DedupeEntry {
            name: d.name.clone(),
            versions: d.versions.clone(),
            instances: d.count,
            can_dedupe,
            saved_instances: saved,
        });
    }

    Ok(DedupeReport {
        duplicates: entries,
        total_duplicates: total_dup,
        deduplicatable: dedup_count,
        estimated_saved,
    })
}

// --- B.4: Dependency Tracer (why) ---

#[derive(Debug)]
pub struct WhyReport {
    pub package: String,
    pub version: Option<String>,
    pub is_direct: bool,
    pub dependency_paths: Vec<Vec<String>>,
    pub depended_on_by: Vec<(String, String)>,
    pub total_paths: u64,
}

pub fn trace_dependency(project_root: &Path, lockfile: &Path, target: &str) -> Result<WhyReport, String> {
    let content = fs::read_to_string(lockfile)
        .map_err(|e| format!("Failed to read lockfile: {}", e))?;

    // Check if direct dependency
    let pkg_json_path = project_root.join("package.json");
    let pkg_json = fs::read_to_string(&pkg_json_path).unwrap_or_default();

    // Look in dependencies and devDependencies
    let is_direct = {
        let dep_check = format!("\"{}\"", target);
        let in_deps = if let Some(pos) = pkg_json.find("\"dependencies\"") {
            let section = &pkg_json[pos..];
            let end = section.find('}').unwrap_or(section.len());
            section[..end].contains(&dep_check)
        } else { false };
        let in_dev = if let Some(pos) = pkg_json.find("\"devDependencies\"") {
            let section = &pkg_json[pos..];
            let end = section.find('}').unwrap_or(section.len());
            section[..end].contains(&dep_check)
        } else { false };
        in_deps || in_dev
    };

    // Parse lockfile to build dependency graph
    let graph = parse_lockfile_graph(&content)?;

    // Find target version
    let target_version = graph.iter()
        .find(|(_, (name, _, _))| name == target)
        .map(|(_, (_, ver, _))| ver.clone());

    // Find all packages that depend on target
    let mut depended_on_by = Vec::new();
    for (_, (name, version, deps)) in &graph {
        if deps.iter().any(|d| d == target) {
            depended_on_by.push((name.clone(), version.clone()));
        }
    }

    // Build adjacency map: name -> [dep_names]
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    let mut root_deps: Vec<String> = Vec::new();
    for (path, (name, _, deps)) in &graph {
        // Direct deps: paths like "node_modules/foo" (no nested node_modules)
        let segments: Vec<&str> = path.split("node_modules/").filter(|s| !s.is_empty()).collect();
        if segments.len() == 1 {
            root_deps.push(name.clone());
        }
        adj.entry(name.clone()).or_default().extend(deps.clone());
    }
    adj.insert("(root)".to_string(), root_deps);

    // BFS to find paths from root to target (limit to 10)
    let mut paths: Vec<Vec<String>> = Vec::new();
    let mut queue: VecDeque<Vec<String>> = VecDeque::new();
    queue.push_back(vec!["(root)".to_string()]);

    while let Some(path) = queue.pop_front() {
        if paths.len() >= 10 { break; }
        if path.len() > 10 { continue; }

        let current = path.last().unwrap().clone();
        if let Some(deps) = adj.get(&current) {
            for dep in deps {
                let mut new_path = path.clone();
                new_path.push(dep.clone());
                if dep == target {
                    paths.push(new_path);
                } else if !path.contains(dep) {
                    queue.push_back(new_path);
                }
            }
        }
    }

    let total = paths.len() as u64;
    Ok(WhyReport {
        package: target.to_string(),
        version: target_version,
        is_direct,
        dependency_paths: paths,
        depended_on_by,
        total_paths: total,
    })
}

fn parse_lockfile_graph(json: &str) -> Result<HashMap<String, (String, String, Vec<String>)>, String> {
    let mut graph = HashMap::new();

    let packages_start = json.find("\"packages\"")
        .ok_or_else(|| "Missing packages in lockfile".to_string())?;
    let after = &json[packages_start..];
    let obj_start = after.find('{').ok_or_else(|| "Malformed lockfile".to_string())?;
    let packages_str = &after[obj_start..];

    let mut current_key = String::new();
    let mut in_string = false;
    let mut escape_next = false;
    let mut brace_depth = 0i32;
    let mut collecting_entry = false;
    let mut entry_data = String::new();
    let mut key_state = 0u8;

    for ch in packages_str.chars() {
        if escape_next {
            if key_state == 1 { current_key.push(ch); }
            else if collecting_entry { entry_data.push(ch); }
            escape_next = false;
            continue;
        }
        if ch == '\\' && in_string {
            escape_next = true;
            if key_state == 1 { current_key.push(ch); }
            else if collecting_entry { entry_data.push(ch); }
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            if brace_depth == 1 && !collecting_entry {
                if key_state == 0 && in_string { key_state = 1; current_key.clear(); }
                else if key_state == 1 && !in_string { key_state = 2; }
            } else if collecting_entry { entry_data.push(ch); }
            continue;
        }
        if in_string {
            if key_state == 1 { current_key.push(ch); }
            else if collecting_entry { entry_data.push(ch); }
            continue;
        }
        if ch == '{' {
            brace_depth += 1;
            if brace_depth == 2 && !current_key.is_empty() {
                collecting_entry = true;
                entry_data.clear();
                key_state = 0;
            }
            if collecting_entry && brace_depth > 2 { entry_data.push(ch); }
        } else if ch == '}' {
            if collecting_entry && brace_depth == 2 {
                let name = extract_json_field(&entry_data, "name")
                    .unwrap_or_else(|| package_name_from_path(&current_key));
                let version = extract_json_field(&entry_data, "version").unwrap_or_default();
                let deps = extract_dep_names(&entry_data);

                if !current_key.is_empty() {
                    graph.insert(current_key.clone(), (name, version, deps));
                }

                collecting_entry = false;
                entry_data.clear();
            } else if collecting_entry { entry_data.push(ch); }
            brace_depth -= 1;
            if brace_depth == 0 { break; }
            if brace_depth == 1 { key_state = 0; }
        } else if ch == ',' && brace_depth == 1 && !collecting_entry {
            key_state = 0;
        } else if collecting_entry {
            entry_data.push(ch);
        }
    }

    Ok(graph)
}

fn extract_dep_names(entry_json: &str) -> Vec<String> {
    let needle = "\"dependencies\"";
    let start = match entry_json.find(needle) {
        Some(pos) => pos,
        None => return Vec::new(),
    };
    let after = &entry_json[start + needle.len()..];
    let obj_start = match after.find('{') {
        Some(pos) => pos,
        None => return Vec::new(),
    };
    let section = &after[obj_start..];

    let mut names = Vec::new();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut current = String::new();
    let mut reading_key = false;
    let mut key_done = false;

    for ch in section.chars() {
        if esc { if reading_key { current.push(ch); } esc = false; continue; }
        if ch == '\\' && in_str { esc = true; continue; }
        if ch == '"' {
            in_str = !in_str;
            if depth == 1 {
                if !key_done && in_str { reading_key = true; current.clear(); }
                else if reading_key && !in_str {
                    reading_key = false; key_done = true;
                    if !current.is_empty() { names.push(current.clone()); }
                    current.clear();
                }
                else if key_done && !in_str { key_done = false; }
            }
            continue;
        }
        if in_str { if reading_key { current.push(ch); } continue; }
        match ch {
            '{' => depth += 1,
            '}' => { depth -= 1; if depth == 0 { break; } }
            ',' if depth == 1 => { key_done = false; }
            _ => {}
        }
    }
    names
}

// --- B.5: Outdated Checker ---

#[derive(Debug, Clone)]
struct SemVer {
    major: u64,
    minor: u64,
    patch: u64,
}

fn parse_semver(v: &str) -> Option<SemVer> {
    let v = v.trim_start_matches('v');
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() < 3 { return None; }
    Some(SemVer {
        major: parts[0].parse().ok()?,
        minor: parts[1].parse().ok()?,
        patch: parts[2].split('-').next()?.parse().ok()?,
    })
}

/// Check if a version satisfies a semver constraint string.
/// Supports: >=X.Y.Z, >X.Y.Z, <=X.Y.Z, <X.Y.Z, ^X.Y.Z (same major), ~X.Y.Z (same major.minor), exact.
fn check_semver_range(version: &SemVer, constraint: &str) -> bool {
    let constraint = constraint.trim();
    if constraint.is_empty() { return true; }
    // Handle || (OR) ranges
    if constraint.contains("||") {
        return constraint.split("||").any(|part| check_semver_range(version, part.trim()));
    }
    // Handle space-separated (AND) ranges
    if constraint.contains(' ') && !constraint.starts_with('>') && !constraint.starts_with('<') && !constraint.starts_with('^') && !constraint.starts_with('~') {
        let parts: Vec<&str> = constraint.split_whitespace().collect();
        if parts.len() >= 2 { return parts.iter().all(|p| check_semver_range(version, p)); }
    }
    if let Some(rest) = constraint.strip_prefix(">=") {
        if let Some(req) = parse_semver(rest.trim()) {
            return (version.major, version.minor, version.patch) >= (req.major, req.minor, req.patch);
        }
    } else if let Some(rest) = constraint.strip_prefix('>') {
        if let Some(req) = parse_semver(rest.trim()) {
            return (version.major, version.minor, version.patch) > (req.major, req.minor, req.patch);
        }
    } else if let Some(rest) = constraint.strip_prefix("<=") {
        if let Some(req) = parse_semver(rest.trim()) {
            return (version.major, version.minor, version.patch) <= (req.major, req.minor, req.patch);
        }
    } else if let Some(rest) = constraint.strip_prefix('<') {
        if let Some(req) = parse_semver(rest.trim()) {
            return (version.major, version.minor, version.patch) < (req.major, req.minor, req.patch);
        }
    } else if let Some(rest) = constraint.strip_prefix('^') {
        if let Some(req) = parse_semver(rest.trim()) {
            return version.major == req.major
                && (version.major, version.minor, version.patch) >= (req.major, req.minor, req.patch);
        }
    } else if let Some(rest) = constraint.strip_prefix('~') {
        if let Some(req) = parse_semver(rest.trim()) {
            return version.major == req.major && version.minor == req.minor && version.patch >= req.patch;
        }
    } else if let Some(req) = parse_semver(constraint) {
        return version.major == req.major && version.minor == req.minor && version.patch == req.patch;
    }
    true // unparseable constraint → pass
}

fn classify_update(current: &SemVer, latest: &SemVer) -> &'static str {
    if latest.major > current.major { "major" }
    else if latest.minor > current.minor { "minor" }
    else if latest.patch > current.patch { "patch" }
    else { "current" }
}

#[derive(Debug, Clone)]
pub struct OutdatedEntry {
    pub name: String,
    pub current: String,
    pub latest: String,
    pub update_type: String,
}

#[derive(Debug)]
pub struct OutdatedReport {
    pub packages: Vec<OutdatedEntry>,
    pub total_checked: u64,
    pub outdated: u64,
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

pub fn check_outdated(_project_root: &Path, lockfile: &Path) -> Result<OutdatedReport, String> {
    use rayon::prelude::*;

    // Get packages from lockfile
    let resolve_result = resolve_from_lockfile(lockfile)?;

    // Deduplicate by name (only check each package once)
    let mut unique: HashMap<String, String> = HashMap::new();
    for pkg in &resolve_result.packages {
        unique.entry(pkg.name.clone()).or_insert_with(|| pkg.version.clone());
    }
    let pkg_list: Vec<(String, String)> = unique.into_iter().collect();

    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();

    // Fetch latest versions in parallel
    let results: Vec<Option<OutdatedEntry>> = pkg_list.par_iter().map(|(name, current_version)| {
        let url = if name.starts_with('@') {
            format!("https://registry.npmjs.org/{}", name.replace('/', "%2F"))
        } else {
            format!("https://registry.npmjs.org/{}", name)
        };

        let resp = match agent.get(&url).call() {
            Ok(r) => r,
            Err(_) => return None,
        };
        let body = match resp.into_string() {
            Ok(b) => b,
            Err(_) => return None,
        };

        // Extract dist-tags.latest
        let dist_tags_pos = match body.find("\"dist-tags\"") {
            Some(p) => p,
            None => return None,
        };
        let dist_section = &body[dist_tags_pos..];
        let latest = match extract_json_field(dist_section, "latest") {
            Some(v) => v,
            None => return None,
        };

        if latest == *current_version {
            return None;
        }

        let current_sv = parse_semver(current_version);
        let latest_sv = parse_semver(&latest);
        let update_type = match (current_sv.as_ref(), latest_sv.as_ref()) {
            (Some(c), Some(l)) => classify_update(c, l).to_string(),
            _ => "unknown".to_string(),
        };

        if update_type == "current" { return None; }

        Some(OutdatedEntry {
            name: name.clone(),
            current: current_version.clone(),
            latest,
            update_type,
        })
    }).collect();

    let mut packages: Vec<OutdatedEntry> = results.into_iter().flatten().collect();
    packages.sort_by(|a, b| a.name.cmp(&b.name));

    let total_checked = pkg_list.len() as u64;
    let outdated = packages.len() as u64;
    let major = packages.iter().filter(|p| p.update_type == "major").count() as u64;
    let minor = packages.iter().filter(|p| p.update_type == "minor").count() as u64;
    let patch = packages.iter().filter(|p| p.update_type == "patch").count() as u64;

    Ok(OutdatedReport { packages, total_checked, outdated, major, minor, patch })
}

// --- B.6: Doctor ---

#[derive(Debug, Clone)]
pub struct DoctorFinding {
    pub id: String,
    pub title: String,
    pub severity: String,
    pub impact: i32,
    pub recommendation: String,
}

#[derive(Debug)]
pub struct DoctorReport {
    pub score: i32,
    pub threshold: i32,
    pub findings: Vec<DoctorFinding>,
}

pub fn run_doctor(project_root: &Path, threshold: i32) -> Result<DoctorReport, String> {
    let mut findings = Vec::new();
    let mut deductions = 0i32;

    // Check 1: Duplicates
    let node_modules = project_root.join("node_modules");
    if node_modules.exists() {
        if let Ok(report) = analyze(project_root, false) {
            for d in &report.duplicates {
                deductions += 2;
                findings.push(DoctorFinding {
                    id: format!("dup-{}", d.name),
                    title: format!("Duplicate package: {} ({} versions)", d.name, d.versions.len()),
                    severity: "warning".to_string(),
                    impact: -2,
                    recommendation: format!("Run `npm dedupe` to reduce {} instances", d.count),
                });
            }

            // Check deep nesting
            if report.depth.max_depth > 5 {
                deductions += 3;
                findings.push(DoctorFinding {
                    id: "deep-nesting".to_string(),
                    title: format!("Deep nesting detected (max depth: {})", report.depth.max_depth),
                    severity: "warning".to_string(),
                    impact: -3,
                    recommendation: "Consider flattening dependencies".to_string(),
                });
            }
        }
    } else {
        deductions += 15;
        findings.push(DoctorFinding {
            id: "missing-node-modules".to_string(),
            title: "node_modules directory not found".to_string(),
            severity: "critical".to_string(),
            impact: -15,
            recommendation: "Run `better-core install` to install dependencies".to_string(),
        });
    }

    // Check 2: Lockfile freshness
    let pkg_json = project_root.join("package.json");
    let lockfile = project_root.join("package-lock.json");
    if lockfile.exists() && pkg_json.exists() {
        let lock_mtime = fs::metadata(&lockfile).and_then(|m| m.modified()).ok();
        let pkg_mtime = fs::metadata(&pkg_json).and_then(|m| m.modified()).ok();
        if let (Some(lock_t), Some(pkg_t)) = (lock_mtime, pkg_mtime) {
            if pkg_t > lock_t {
                deductions += 10;
                findings.push(DoctorFinding {
                    id: "stale-lockfile".to_string(),
                    title: "package-lock.json is older than package.json".to_string(),
                    severity: "error".to_string(),
                    impact: -10,
                    recommendation: "Run `npm install` to update lockfile".to_string(),
                });
            }
        }
    } else if !lockfile.exists() {
        deductions += 10;
        findings.push(DoctorFinding {
            id: "missing-lockfile".to_string(),
            title: "No package-lock.json found".to_string(),
            severity: "error".to_string(),
            impact: -10,
            recommendation: "Run `npm install` to generate a lockfile".to_string(),
        });
    }

    // Check 3: Deprecated packages (look for "deprecated" field in lockfile)
    if lockfile.exists() {
        if let Ok(lock_content) = fs::read_to_string(&lockfile) {
            let deprecated_count = lock_content.matches("\"deprecated\"").count();
            if deprecated_count > 0 {
                deductions += (deprecated_count as i32).min(25);
                findings.push(DoctorFinding {
                    id: "deprecated-packages".to_string(),
                    title: format!("{} deprecated package(s) found", deprecated_count),
                    severity: "warning".to_string(),
                    impact: -(deprecated_count as i32).min(25),
                    recommendation: "Update deprecated packages to maintained alternatives".to_string(),
                });
            }
        }
    }

    // Check 4: .npmrc exists
    if !project_root.join(".npmrc").exists() {
        // Not a deduction, just a suggestion
        findings.push(DoctorFinding {
            id: "no-npmrc".to_string(),
            title: "No .npmrc configuration file".to_string(),
            severity: "info".to_string(),
            impact: 0,
            recommendation: "Consider adding .npmrc for reproducible builds".to_string(),
        });
    }

    let score = (100 - deductions).max(0);
    Ok(DoctorReport { score, threshold, findings })
}

// --- B.7: Cache Stats/GC ---

#[derive(Debug)]
pub struct CacheStatsReport {
    pub cache_root: PathBuf,
    pub total_bytes: u64,
    pub package_count: u64,
    pub tarball_count: u64,
    pub tarball_bytes: u64,
    pub unpacked_count: u64,
    pub unpacked_bytes: u64,
    pub file_cas_count: u64,
    pub file_cas_bytes: u64,
}

#[derive(Debug)]
pub struct CacheGcReport {
    pub removed: u64,
    pub freed_bytes: u64,
    pub dry_run: bool,
}

pub fn cache_stats(cache_root: &Path) -> Result<CacheStatsReport, String> {
    let layout = CasLayout::new(cache_root);
    let file_store = cache_root.join("file-store");

    let (tarball_count, tarball_bytes) = dir_stats_recursive(&layout.tarballs_dir);
    let (unpacked_count, unpacked_bytes) = dir_stats_recursive(&layout.unpacked_dir);
    let (file_cas_count, file_cas_bytes) = dir_stats_recursive(&file_store);

    let total_bytes = tarball_bytes + unpacked_bytes + file_cas_bytes;
    let package_count = tarball_count;

    Ok(CacheStatsReport {
        cache_root: cache_root.to_path_buf(),
        total_bytes,
        package_count,
        tarball_count,
        tarball_bytes,
        unpacked_count,
        unpacked_bytes,
        file_cas_count,
        file_cas_bytes,
    })
}

fn dir_stats_recursive(dir: &Path) -> (u64, u64) {
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];

    while let Some(d) = stack.pop() {
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.is_dir() {
                stack.push(entry.path());
            } else {
                count += 1;
                bytes += md.len();
            }
        }
    }
    (count, bytes)
}

pub fn cache_gc(cache_root: &Path, max_age_days: u64, dry_run: bool) -> Result<CacheGcReport, String> {
    use std::time::{SystemTime, Duration};

    let cutoff = SystemTime::now() - Duration::from_secs(max_age_days * 86400);
    let mut removed = 0u64;
    let mut freed = 0u64;

    let layout = CasLayout::new(cache_root);

    // Walk tarballs and unpacked dirs
    for dir in &[&layout.tarballs_dir, &layout.unpacked_dir] {
        gc_walk(dir, &cutoff, dry_run, &mut removed, &mut freed);
    }

    Ok(CacheGcReport { removed, freed_bytes: freed, dry_run })
}

fn gc_walk(dir: &Path, cutoff: &std::time::SystemTime, dry_run: bool, removed: &mut u64, freed: &mut u64) {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let md = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.is_dir() {
                stack.push(entry.path());
                continue;
            }
            let mtime = md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if mtime < *cutoff {
                *freed += md.len();
                *removed += 1;
                if !dry_run {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

// --- B.8: Security Audit ---

#[derive(Debug, Clone)]
pub struct AuditVulnerability {
    pub id: String,
    pub summary: String,
    pub severity: String,
    pub package: String,
    pub version: String,
    pub fixed: String,
}

#[derive(Debug)]
pub struct AuditReport {
    pub scanned_packages: u64,
    pub vulnerabilities: Vec<AuditVulnerability>,
    pub total: u64,
    pub critical: u64,
    pub high: u64,
    pub medium: u64,
    pub low: u64,
    pub risk_level: String,
}

pub fn run_audit(lockfile: &Path, _project_root: &Path, min_severity: &str) -> Result<AuditReport, String> {
    let resolve_result = resolve_from_lockfile(lockfile)?;

    // Build OSV batch query
    let mut query = JsonWriter::new();
    query.begin_object();
    query.key("queries");
    query.begin_array();

    // Deduplicate packages
    let mut seen: HashSet<String> = HashSet::new();
    let mut query_count = 0u64;
    for pkg in &resolve_result.packages {
        let key = format!("{}@{}", pkg.name, pkg.version);
        if seen.insert(key) {
            query.begin_object();
            query.key("package");
            query.begin_object();
            query.key("name");
            query.value_string(&pkg.name);
            query.key("ecosystem");
            query.value_string("npm");
            query.end_object();
            query.key("version");
            query.value_string(&pkg.version);
            query.end_object();
            query_count += 1;
        }
    }

    query.end_array();
    query.end_object();
    let body = query.finish();

    // POST to OSV.dev
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(30))
        .build();

    let resp = agent.post("https://api.osv.dev/v1/querybatch")
        .set("Content-Type", "application/json")
        .send_string(&body)
        .map_err(|e| format!("OSV API request failed: {}", e))?;

    let resp_body = resp.into_string()
        .map_err(|e| format!("Failed to read OSV response: {}", e))?;

    // Parse response
    let mut vulns: Vec<AuditVulnerability> = Vec::new();

    // Simple parsing: find all "vulns" arrays in the results
    // Response format: {"results":[{"vulns":[{"id":"...","summary":"..."}]},{"vulns":[]},..]}
    let severity_rank = |s: &str| -> u8 {
        match s.to_lowercase().as_str() {
            "critical" => 4,
            "high" => 3,
            "medium" | "moderate" => 2,
            "low" => 1,
            _ => 0,
        }
    };
    let min_rank = severity_rank(min_severity);

    // Walk through unique packages and match with results
    let mut pkg_names: Vec<(String, String)> = Vec::new();
    let mut seen2: HashSet<String> = HashSet::new();
    for pkg in &resolve_result.packages {
        let key = format!("{}@{}", pkg.name, pkg.version);
        if seen2.insert(key) {
            pkg_names.push((pkg.name.clone(), pkg.version.clone()));
        }
    }

    // Parse "results" array - each element corresponds to a query
    // Simple approach: find each "vulns" occurrence and extract vulnerability info
    let mut search_pos = 0;
    let mut pkg_idx = 0usize;
    while let Some(vulns_pos) = resp_body[search_pos..].find("\"vulns\"") {
        let abs_pos = search_pos + vulns_pos;
        search_pos = abs_pos + 6;

        let (pkg_name, pkg_version) = if pkg_idx < pkg_names.len() {
            (pkg_names[pkg_idx].0.clone(), pkg_names[pkg_idx].1.clone())
        } else {
            ("unknown".to_string(), "0.0.0".to_string())
        };
        pkg_idx += 1;

        // Find the array content
        let after = &resp_body[abs_pos..];
        if let Some(arr_start) = after.find('[') {
            let arr_section = &after[arr_start..];
            // Check if empty array
            let trimmed = arr_section.trim_start_matches('[').trim_start();
            if trimmed.starts_with(']') { continue; }

            // Extract individual vulnerability objects
            let mut depth = 0i32;
            let mut obj_start = 0usize;
            let mut in_str = false;
            let mut esc = false;

            for (i, ch) in arr_section.char_indices() {
                if esc { esc = false; continue; }
                if ch == '\\' && in_str { esc = true; continue; }
                if ch == '"' { in_str = !in_str; continue; }
                if in_str { continue; }
                if ch == '{' {
                    if depth == 0 { obj_start = i; }
                    depth += 1;
                } else if ch == '}' {
                    depth -= 1;
                    if depth == 0 {
                        let vuln_json = &arr_section[obj_start + 1..i];
                        let id = extract_json_field(vuln_json, "id").unwrap_or_default();
                        let summary = extract_json_field(vuln_json, "summary")
                            .unwrap_or_else(|| "No description".to_string());

                        // Try to extract severity
                        let severity = extract_json_field(vuln_json, "severity")
                            .or_else(|| {
                                if vuln_json.contains("CRITICAL") { Some("CRITICAL".to_string()) }
                                else if vuln_json.contains("HIGH") { Some("HIGH".to_string()) }
                                else if vuln_json.contains("MODERATE") || vuln_json.contains("MEDIUM") { Some("MEDIUM".to_string()) }
                                else { Some("LOW".to_string()) }
                            })
                            .unwrap_or_else(|| "UNKNOWN".to_string());

                        if severity_rank(&severity) >= min_rank {
                            vulns.push(AuditVulnerability {
                                id: id.clone(),
                                summary,
                                severity: severity.to_uppercase(),
                                package: pkg_name.clone(),
                                version: pkg_version.clone(),
                                fixed: extract_json_field(vuln_json, "fixed").unwrap_or_default(),
                            });
                        }
                    }
                } else if ch == ']' && depth == 0 {
                    break;
                }
            }
        }
    }

    let total = vulns.len() as u64;
    let critical = vulns.iter().filter(|v| v.severity == "CRITICAL").count() as u64;
    let high = vulns.iter().filter(|v| v.severity == "HIGH").count() as u64;
    let medium = vulns.iter().filter(|v| v.severity == "MEDIUM" || v.severity == "MODERATE").count() as u64;
    let low = vulns.iter().filter(|v| v.severity == "LOW").count() as u64;

    let risk_level = if critical > 0 { "critical" }
        else if high > 0 { "high" }
        else if medium > 0 { "medium" }
        else if low > 0 { "low" }
        else { "none" };

    Ok(AuditReport {
        scanned_packages: query_count,
        vulnerabilities: vulns,
        total, critical, high, medium, low,
        risk_level: risk_level.to_string(),
    })
}

// --- B.9: Benchmark ---

#[derive(Debug, Clone)]
pub struct BenchmarkTiming {
    pub median_ms: u64,
    pub min_ms: u64,
    pub max_ms: u64,
    pub mean_ms: u64,
}

#[derive(Debug, Clone)]
pub struct BenchmarkResult {
    pub name: String,
    pub cold: BenchmarkTiming,
    pub warm: BenchmarkTiming,
}

#[derive(Debug)]
pub struct BenchmarkReport {
    pub platform: String,
    pub arch: String,
    pub cpus: u64,
    pub results: Vec<BenchmarkResult>,
}

fn compute_timing(mut times: Vec<u64>) -> BenchmarkTiming {
    if times.is_empty() {
        return BenchmarkTiming { median_ms: 0, min_ms: 0, max_ms: 0, mean_ms: 0 };
    }
    times.sort_unstable();
    let min_ms = times[0];
    let max_ms = *times.last().unwrap();
    let mean_ms = times.iter().sum::<u64>() / times.len() as u64;
    let median_ms = times[times.len() / 2];
    BenchmarkTiming { median_ms, min_ms, max_ms, mean_ms }
}

pub fn run_benchmark(project_root: &Path, rounds: usize, pms: &[String]) -> Result<BenchmarkReport, String> {
    let platform = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let cpus = std::thread::available_parallelism().map(|n| n.get() as u64).unwrap_or(1);

    let node_modules = project_root.join("node_modules");
    let mut results = Vec::new();

    for pm in pms {
        let (cmd, args): (&str, Vec<&str>) = match pm.as_str() {
            "npm" => ("npm", vec!["install", "--no-audit", "--no-fund"]),
            "bun" => ("bun", vec!["install"]),
            "better" => {
                let _exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("better-core"));
                ("__self__", vec![])
            }
            other => (other, vec!["install"]),
        };

        // Check if PM is available (skip if not found)
        if pm != "better" {
            let check = std::process::Command::new(cmd)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            if check.is_err() || !check.unwrap().success() {
                continue;
            }
        }

        let mut cold_times = Vec::new();
        let mut warm_times = Vec::new();

        for _round in 0..rounds {
            // Cold install: remove node_modules first
            let _ = fs::remove_dir_all(&node_modules);

            let start = Instant::now();
            let status = if pm == "better" {
                let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("better-core"));
                std::process::Command::new(&exe)
                    .args(["install", "--project-root"])
                    .arg(project_root)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
            } else {
                std::process::Command::new(cmd)
                    .args(&args)
                    .current_dir(project_root)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
            };
            if let Ok(s) = status {
                if s.success() {
                    cold_times.push(start.elapsed().as_millis() as u64);
                }
            }

            // Warm install: node_modules exists
            let start = Instant::now();
            let status = if pm == "better" {
                let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("better-core"));
                std::process::Command::new(&exe)
                    .args(["install", "--project-root"])
                    .arg(project_root)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
            } else {
                std::process::Command::new(cmd)
                    .args(&args)
                    .current_dir(project_root)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
            };
            if let Ok(s) = status {
                if s.success() {
                    warm_times.push(start.elapsed().as_millis() as u64);
                }
            }
        }

        results.push(BenchmarkResult {
            name: pm.clone(),
            cold: compute_timing(cold_times),
            warm: compute_timing(warm_times),
        });
    }

    Ok(BenchmarkReport { platform, arch, cpus, results })
}

// === Phase C: Developer Tool Features ===

// --- C.2: Git Hooks ---

/// Extract hooks config from package.json "better.hooks" section.
fn extract_hooks_config(pkg_json_content: &str) -> Vec<(String, String)> {
    if let Some(better_raw) = extract_json_object_raw(pkg_json_content, "better") {
        extract_json_object_pairs(&better_raw, "hooks").unwrap_or_default()
    } else {
        Vec::new()
    }
}

/// Validate a commit message against conventional commit format: type(scope): description
pub fn validate_conventional_commit(message: &str) -> Result<(), String> {
    let first_line = message.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        return Err("Empty commit message".to_string());
    }
    let valid_types = [
        "feat", "fix", "docs", "style", "refactor", "perf",
        "test", "build", "ci", "chore", "revert",
    ];
    // Check format: type(scope): desc  or  type: desc
    let colon_pos = match first_line.find(':') {
        Some(p) => p,
        None => return Err(format!("Missing colon in commit message: '{}'", first_line)),
    };
    let prefix = &first_line[..colon_pos];
    let type_name = if let Some(paren) = prefix.find('(') {
        if !prefix.ends_with(')') {
            return Err(format!("Malformed scope in commit message: '{}'", first_line));
        }
        &prefix[..paren]
    } else {
        prefix
    };
    if !valid_types.contains(&type_name) {
        return Err(format!("Invalid commit type '{}'. Valid: {}", type_name, valid_types.join(", ")));
    }
    let desc = first_line[colon_pos + 1..].trim();
    if desc.is_empty() {
        return Err("Missing description after colon".to_string());
    }
    Ok(())
}

#[derive(Debug)]
pub struct HooksInstallResult {
    pub hooks_installed: u64,
    pub from_config: bool,
    pub hooks: Vec<(String, String)>,
}

pub fn hooks_install(project_root: &Path) -> Result<HooksInstallResult, String> {
    let git_dir = project_root.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }
    let hooks_dir = git_dir.join("hooks");
    fs::create_dir_all(&hooks_dir).map_err(|e| e.to_string())?;

    let pkg_json = project_root.join("package.json");
    let content = fs::read_to_string(&pkg_json).unwrap_or_default();
    let config_hooks = extract_hooks_config(&content);

    let from_config = !config_hooks.is_empty();
    let hook_entries: Vec<(String, String)> = if from_config {
        config_hooks
    } else {
        // Sensible defaults
        let scripts = read_package_json_scripts(project_root).unwrap_or_default();
        let mut defaults = Vec::new();
        if scripts.iter().any(|(n, _)| n == "lint") {
            defaults.push(("pre-commit".to_string(), "better-core run lint".to_string()));
        }
        if scripts.iter().any(|(n, _)| n == "test") {
            defaults.push(("pre-push".to_string(), "better-core run test".to_string()));
        }
        defaults.push(("commit-msg".to_string(), "conventional-commit".to_string()));
        defaults
    };

    let mut hooks_installed = 0u64;
    let mut installed: Vec<(String, String)> = Vec::new();

    for (hook_type, action) in &hook_entries {
        let hook_path = hooks_dir.join(hook_type);
        let script = if action == "conventional-commit" {
            format!(
                "#!/bin/sh\n# Installed by better-core hooks\n\
                MSG=$(cat \"$1\" 2>/dev/null || echo \"$1\")\n\
                if ! echo \"$MSG\" | grep -qE '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\(.*\\))?: .+'; then\n  \
                echo \"error: commit message must follow Conventional Commits format\" >&2\n  \
                echo \"  format: type(scope): description\" >&2\n  \
                exit 1\nfi\n"
            )
        } else {
            format!(
                "#!/bin/sh\n# Installed by better-core hooks\nexec {} \"$@\"\n",
                action
            )
        };

        fs::write(&hook_path, &script).map_err(|e| e.to_string())?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&hook_path).map_err(|e| e.to_string())?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&hook_path, perms).map_err(|e| e.to_string())?;
        }

        hooks_installed += 1;
        installed.push((hook_type.clone(), action.clone()));
    }

    Ok(HooksInstallResult { hooks_installed, from_config, hooks: installed })
}

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

#[derive(Debug)]
pub struct EnvInfo {
    pub node_version: String,
    pub npm_version: String,
    pub better_version: String,
    pub platform: String,
    pub arch: String,
    pub project_name: Option<String>,
    pub project_version: Option<String>,
    pub engines: Option<String>,
}

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

#[derive(Debug)]
pub struct EnvCheckEntry {
    pub tool: String,
    pub current: String,
    pub required: String,
    pub satisfied: bool,
}

#[derive(Debug)]
pub struct EnvCheckResult {
    pub checks: Vec<EnvCheckEntry>,
    pub all_ok: bool,
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
fn load_dotenv(project_root: &Path) -> Vec<(String, String)> {
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

// --- C.5: Init ---

const TEMPLATE_TSCONFIG: &str = r#"{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
"#;

const TEMPLATE_GITIGNORE: &str = "node_modules/\ndist/\n.env\n.env.local\n*.log\ncoverage/\n.DS_Store\n";

const TEMPLATE_REACT_APP: &str = r#"import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>Hello from Better</h1>
      <button onClick={() => setCount(c => c + 1)}>
        Count: {count}
      </button>
    </div>
  );
}
"#;

const TEMPLATE_NEXT_PAGE: &str = r#"export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>Hello from Better + Next.js</h1>
      <p>Edit <code>src/app/page.tsx</code> to get started.</p>
    </main>
  );
}
"#;

const TEMPLATE_EXPRESS_APP: &str = r#"import express from 'express';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: 'Hello from Better + Express' });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
"#;

#[derive(Debug)]
pub struct InitResult {
    pub files_created: Vec<String>,
    pub template: Option<String>,
}

fn write_file(root: &Path, rel: &str, content: &str, files: &mut Vec<String>) -> Result<(), String> {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", rel, e))?;
    files.push(rel.to_string());
    Ok(())
}

fn write_react_template(root: &Path, name: &str) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("name"); w.value_string(name);
    w.key("version"); w.value_string("0.1.0");
    w.key("private"); w.value_bool(true);
    w.key("type"); w.value_string("module");
    w.key("scripts"); w.begin_object();
    w.key("dev"); w.value_string("vite");
    w.key("build"); w.value_string("tsc && vite build");
    w.key("preview"); w.value_string("vite preview");
    w.end_object();
    w.key("dependencies"); w.begin_object();
    w.key("react"); w.value_string("^18.3.0");
    w.key("react-dom"); w.value_string("^18.3.0");
    w.end_object();
    w.key("devDependencies"); w.begin_object();
    w.key("@types/react"); w.value_string("^18.3.0");
    w.key("@types/react-dom"); w.value_string("^18.3.0");
    w.key("@vitejs/plugin-react"); w.value_string("^4.0.0");
    w.key("typescript"); w.value_string("^5.0.0");
    w.key("vite"); w.value_string("^5.0.0");
    w.end_object();
    w.end_object(); w.out.push('\n');
    write_file(root, "package.json", &w.finish(), &mut files)?;
    write_file(root, "tsconfig.json", TEMPLATE_TSCONFIG, &mut files)?;
    write_file(root, ".gitignore", TEMPLATE_GITIGNORE, &mut files)?;
    write_file(root, "src/App.tsx", TEMPLATE_REACT_APP, &mut files)?;
    Ok(files)
}

fn write_next_template(root: &Path, name: &str) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("name"); w.value_string(name);
    w.key("version"); w.value_string("0.1.0");
    w.key("private"); w.value_bool(true);
    w.key("scripts"); w.begin_object();
    w.key("dev"); w.value_string("next dev");
    w.key("build"); w.value_string("next build");
    w.key("start"); w.value_string("next start");
    w.end_object();
    w.key("dependencies"); w.begin_object();
    w.key("next"); w.value_string("^14.0.0");
    w.key("react"); w.value_string("^18.3.0");
    w.key("react-dom"); w.value_string("^18.3.0");
    w.end_object();
    w.key("devDependencies"); w.begin_object();
    w.key("@types/react"); w.value_string("^18.3.0");
    w.key("typescript"); w.value_string("^5.0.0");
    w.end_object();
    w.end_object(); w.out.push('\n');
    write_file(root, "package.json", &w.finish(), &mut files)?;
    write_file(root, "tsconfig.json", TEMPLATE_TSCONFIG, &mut files)?;
    write_file(root, ".gitignore", TEMPLATE_GITIGNORE, &mut files)?;
    write_file(root, "src/app/page.tsx", TEMPLATE_NEXT_PAGE, &mut files)?;
    Ok(files)
}

fn write_express_template(root: &Path, name: &str) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("name"); w.value_string(name);
    w.key("version"); w.value_string("0.1.0");
    w.key("private"); w.value_bool(true);
    w.key("type"); w.value_string("module");
    w.key("scripts"); w.begin_object();
    w.key("dev"); w.value_string("tsx watch src/app.ts");
    w.key("build"); w.value_string("tsc");
    w.key("start"); w.value_string("node dist/app.js");
    w.end_object();
    w.key("dependencies"); w.begin_object();
    w.key("express"); w.value_string("^4.18.0");
    w.end_object();
    w.key("devDependencies"); w.begin_object();
    w.key("@types/express"); w.value_string("^4.17.0");
    w.key("tsx"); w.value_string("^4.0.0");
    w.key("typescript"); w.value_string("^5.0.0");
    w.end_object();
    w.end_object(); w.out.push('\n');
    write_file(root, "package.json", &w.finish(), &mut files)?;
    write_file(root, "tsconfig.json", TEMPLATE_TSCONFIG, &mut files)?;
    write_file(root, ".gitignore", TEMPLATE_GITIGNORE, &mut files)?;
    write_file(root, "src/app.ts", TEMPLATE_EXPRESS_APP, &mut files)?;
    Ok(files)
}

pub fn init_project(project_root: &Path, name: Option<&str>, template: Option<&str>) -> Result<InitResult, String> {
    fs::create_dir_all(project_root).map_err(|e| e.to_string())?;

    let pkg_json = project_root.join("package.json");
    if pkg_json.exists() {
        return Err("package.json already exists".to_string());
    }

    let project_name = name.map(|s| s.to_string()).unwrap_or_else(|| {
        project_root.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "my-project".to_string())
    });

    if let Some(tmpl) = template {
        let files = match tmpl {
            "react" => write_react_template(project_root, &project_name)?,
            "next" => write_next_template(project_root, &project_name)?,
            "express" => write_express_template(project_root, &project_name)?,
            _ => return Err(format!("Unknown template '{}'. Available: react, next, express", tmpl)),
        };
        return Ok(InitResult { files_created: files, template: Some(tmpl.to_string()) });
    }

    // Default init (no template)
    let mut files = Vec::new();
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("name"); w.value_string(&project_name);
    w.key("version"); w.value_string("1.0.0");
    w.key("description"); w.value_string("");
    w.key("main"); w.value_string("index.js");
    w.key("scripts"); w.begin_object();
    w.key("test"); w.value_string("echo \"Error: no test specified\" && exit 1");
    w.end_object();
    w.key("keywords"); w.begin_array(); w.end_array();
    w.key("author"); w.value_string("");
    w.key("license"); w.value_string("ISC");
    w.end_object(); w.out.push('\n');

    fs::write(&pkg_json, w.finish()).map_err(|e| e.to_string())?;
    files.push("package.json".to_string());

    Ok(InitResult { files_created: files, template: None })
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
