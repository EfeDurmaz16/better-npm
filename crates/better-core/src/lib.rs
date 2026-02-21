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

    // Parse manifest to extract file entries
    // Format: "rel/path":{"type":"file","hash":"abc123","size":1234,"mode":420}
    // or: "rel/path":{"type":"symlink","target":"../other"}

    let mut file_entries = Vec::new();
    let mut symlink_entries = Vec::new();

    // Simple JSON parsing - find all file/symlink entries
    let lines: Vec<&str> = manifest_content.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i].trim();

        // Look for a line that starts with a quoted path
        if line.starts_with('"') && line.contains("\":{") {
            if let Some(colon_pos) = line.find("\":{") {
                let rel_path = &line[1..colon_pos];

                // Look ahead to find type, hash, target, etc.
                let mut entry_type = "";
                let mut hash = String::new();
                let mut target = String::new();

                // Scan next few lines for the entry data
                for j in i..std::cmp::min(i + 10, lines.len()) {
                    let entry_line = lines[j].trim();

                    if entry_line.contains(r#""type":"file""#) {
                        entry_type = "file";
                    } else if entry_line.contains(r#""type":"symlink""#) {
                        entry_type = "symlink";
                    }

                    if entry_line.contains(r#""hash":"#) {
                        if let Some(hash_start) = entry_line.find(r#""hash":""#) {
                            let hash_value_start = hash_start + 8;
                            if let Some(hash_end) = entry_line[hash_value_start..].find('"') {
                                hash = entry_line[hash_value_start..hash_value_start + hash_end].to_string();
                            }
                        }
                    }

                    if entry_line.contains(r#""target":"#) {
                        if let Some(target_start) = entry_line.find(r#""target":""#) {
                            let target_value_start = target_start + 10;
                            if let Some(target_end) = entry_line[target_value_start..].find('"') {
                                target = entry_line[target_value_start..target_value_start + target_end].to_string();
                            }
                        }
                    }

                    if entry_line.contains('}') {
                        break;
                    }
                }

                if entry_type == "file" && !hash.is_empty() {
                    file_entries.push((rel_path.to_string(), hash));
                } else if entry_type == "symlink" && !target.is_empty() {
                    symlink_entries.push((rel_path.to_string(), target));
                }
            }
        }

        i += 1;
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

    // Materialize files
    let mut stats = FileCasMaterializeResult {
        ok: true,
        files: 0,
        linked: 0,
        copied: 0,
        symlinks: 0,
    };

    for (rel_path, hash) in file_entries {
        let store_path = file_store_path(store_root, &hash);
        let dest_path = dest_dir.join(&rel_path);

        stats.files += 1;

        match link_strategy {
            LinkStrategy::Copy => {
                fs::copy(&store_path, &dest_path)
                    .map_err(|e| format!("Failed to copy file: {}", e))?;
                stats.copied += 1;
            }
            LinkStrategy::Hardlink | LinkStrategy::Auto => {
                // Try hardlink first
                match fs::hard_link(&store_path, &dest_path) {
                    Ok(_) => {
                        stats.linked += 1;
                    }
                    Err(_) => {
                        // Fallback to copy
                        fs::copy(&store_path, &dest_path)
                            .map_err(|e| format!("Failed to copy file (hardlink failed): {}", e))?;
                        stats.copied += 1;
                    }
                }
            }
        }
    }

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
