use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy)]
enum LinkStrategy {
    Auto,
    Hardlink,
    Copy,
}

impl LinkStrategy {
    fn from_arg(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "hardlink" => Some(Self::Hardlink),
            "copy" => Some(Self::Copy),
            _ => None,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Hardlink => "hardlink",
            Self::Copy => "copy",
        }
    }
}

#[derive(Debug)]
enum Command {
    Analyze { root: PathBuf, graph: bool },
    Scan { root: PathBuf },
    Materialize {
        src: PathBuf,
        dest: PathBuf,
        link_strategy: LinkStrategy,
        jobs: usize,
    },
    Version,
    Help { error: Option<String> },
}

fn parse_args() -> Command {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return Command::Help { error: None };
    }
    if args[0] == "version" || args[0] == "--version" || args[0] == "-V" {
        return Command::Version;
    }
    if args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
        return Command::Help { error: None };
    }

    let sub = args[0].as_str();
    let mut root: Option<PathBuf> = None;
    let mut graph = false;
    let mut src: Option<PathBuf> = None;
    let mut dest: Option<PathBuf> = None;
    let mut link_strategy = LinkStrategy::Auto;
    let mut jobs = std::thread::available_parallelism()
        .map(|n| n.get().saturating_mul(2))
        .unwrap_or(8);
    jobs = jobs.clamp(1, 64);
    let mut i = 1usize;
    while i < args.len() {
        match args[i].as_str() {
            "--root" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--root requires a value".to_string()),
                    };
                }
                root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--graph" => {
                graph = true;
                i += 1;
            }
            "--no-graph" => {
                graph = false;
                i += 1;
            }
            "--src" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--src requires a value".to_string()),
                    };
                }
                src = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--dest" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--dest requires a value".to_string()),
                    };
                }
                dest = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--link-strategy" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--link-strategy requires a value".to_string()),
                    };
                }
                let raw = args[i + 1].as_str();
                match LinkStrategy::from_arg(raw) {
                    Some(s) => link_strategy = s,
                    None => {
                        return Command::Help {
                            error: Some(format!(
                                "unknown --link-strategy '{raw}' (expected auto|hardlink|copy)"
                            )),
                        }
                    }
                }
                i += 2;
            }
            "--jobs" => {
                if i + 1 >= args.len() {
                    return Command::Help {
                        error: Some("--jobs requires a value".to_string()),
                    };
                }
                let raw = args[i + 1].as_str();
                match raw.parse::<usize>() {
                    Ok(parsed) if parsed > 0 => jobs = parsed.clamp(1, 256),
                    _ => {
                        return Command::Help {
                            error: Some(format!("invalid --jobs '{raw}' (expected positive integer)")),
                        }
                    }
                }
                i += 2;
            }
            other => {
                return Command::Help {
                    error: Some(format!("unknown flag: {other}")),
                };
            }
        }
    }

    match sub {
        "analyze" => match root {
            Some(r) => Command::Analyze { root: r, graph },
            None => Command::Help {
                error: Some("analyze requires --root".to_string()),
            },
        },
        "scan" => match root {
            Some(r) => Command::Scan { root: r },
            None => Command::Help {
                error: Some("scan requires --root".to_string()),
            },
        },
        "materialize" => match (src, dest) {
            (Some(src), Some(dest)) => Command::Materialize {
                src,
                dest,
                link_strategy,
                jobs,
            },
            _ => Command::Help {
                error: Some("materialize requires --src <path> and --dest <path>".to_string()),
            },
        },
        _ => Command::Help {
            error: Some(format!("unknown command: {sub}")),
        },
    }
}

fn print_help(error: Option<String>) {
    if let Some(e) = error {
        eprintln!("error: {e}\n");
    }
    println!(
        "better-core {VERSION}

Usage:
  better-core analyze --root <path> [--graph]
  better-core scan --root <path>
  better-core materialize --src <path> --dest <path> [--link-strategy auto|hardlink|copy] [--jobs N]
  better-core version
"
    );
}

// --- JSON writer (no dependencies) ---

struct JsonWriter {
    out: String,
    stack_first: Vec<bool>,
    after_key: bool,
}

impl JsonWriter {
    fn new() -> Self {
        Self {
            out: String::new(),
            stack_first: Vec::new(),
            after_key: false,
        }
    }

    fn finish(self) -> String {
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

    fn begin_object(&mut self) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push('{');
        self.stack_first.push(true);
    }

    fn end_object(&mut self) {
        self.out.push('}');
        self.stack_first.pop();
    }

    fn begin_array(&mut self) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push('[');
        self.stack_first.push(true);
    }

    fn end_array(&mut self) {
        self.out.push(']');
        self.stack_first.pop();
    }

    fn key(&mut self, k: &str) {
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

    fn value_string(&mut self, s: &str) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.string(s);
    }

    fn value_bool(&mut self, v: bool) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push_str(if v { "true" } else { "false" });
    }

    fn value_null(&mut self) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push_str("null");
    }

    fn value_u64(&mut self, v: u64) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push_str(&v.to_string());
    }

    fn value_i64(&mut self, v: i64) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.push_comma_if_needed();
        }
        self.out.push_str(&v.to_string());
    }

    fn value_f64(&mut self, v: f64) {
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
fn identity_key(md: &fs::Metadata) -> (u64, u64, bool) {
    use std::os::unix::fs::MetadataExt;
    let dev = md.dev();
    let ino = md.ino();
    let reliable = dev != 0 && ino != 0;
    (dev, ino, reliable)
}

#[cfg(windows)]
fn identity_key(md: &fs::Metadata) -> (u64, u64, bool) {
    use std::os::windows::fs::MetadataExt;
    let vol = md.volume_serial_number().unwrap_or(0) as u64;
    let idx = md.file_index().unwrap_or(0);
    let reliable = vol != 0 && idx != 0;
    (vol, idx, reliable)
}

#[cfg(not(any(unix, windows)))]
fn identity_key(_md: &fs::Metadata) -> (u64, u64, bool) {
    (0, 0, false)
}

fn stable_list_dir(dir: &Path) -> std::io::Result<Vec<fs::DirEntry>> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    Ok(entries)
}

fn physical_len(md: &fs::Metadata) -> u64 {
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

fn is_dir_or_symlink_to_dir(path: &Path, entry: &fs::DirEntry) -> bool {
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

fn read_package_identity(pkg_dir: &Path) -> Option<(String, String)> {
    let pkg_json = pkg_dir.join("package.json");
    let raw = fs::read_to_string(pkg_json).ok()?;
    // Minimal JSON extraction for "name" and "version".
    // This is a best-effort parser to keep dependencies at zero.
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

fn depth_from_path(p: &Path) -> u64 {
    p.components()
        .filter(|c| matches!(c, std::path::Component::Normal(s) if *s == std::ffi::OsStr::new("node_modules")))
        .count() as u64
}

#[derive(Default, Clone)]
struct ScanAgg {
    logical: u64,
    physical: u64,
    shared: u64,
    file_count: u64,
    approx: bool,
}

fn scan_tree(
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
                    // Unknown identity; treat as unique but approximate.
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

#[derive(Default, Clone)]
struct MaterializeStats {
    files: u64,
    files_linked: u64,
    files_copied: u64,
    link_fallback_copies: u64,
    directories: u64,
    symlinks: u64,
}

#[derive(Default)]
struct MaterializeCounters {
    files: AtomicU64,
    files_linked: AtomicU64,
    files_copied: AtomicU64,
    link_fallback_copies: AtomicU64,
    symlinks: AtomicU64,
}

impl MaterializeCounters {
    fn snapshot(&self) -> MaterializeStats {
        MaterializeStats {
            files: self.files.load(Ordering::Relaxed),
            files_linked: self.files_linked.load(Ordering::Relaxed),
            files_copied: self.files_copied.load(Ordering::Relaxed),
            link_fallback_copies: self.link_fallback_copies.load(Ordering::Relaxed),
            directories: 0,
            symlinks: self.symlinks.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone)]
struct MaterializeFileTask {
    src: PathBuf,
    dst: PathBuf,
}

#[derive(Clone)]
struct MaterializeSymlinkTask {
    src: PathBuf,
    dst: PathBuf,
    target: PathBuf,
}

fn remove_path_if_exists(p: &Path) -> Result<(), String> {
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
fn create_symlink(target: &Path, dst: &Path, _src_path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::symlink;
    symlink(target, dst)
}

#[cfg(windows)]
fn create_symlink(target: &Path, dst: &Path, src_path: &Path) -> std::io::Result<()> {
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
fn create_symlink(target: &Path, dst: &Path, _src_path: &Path) -> std::io::Result<()> {
    // Fallback on unsupported targets: preserve behavior via copy.
    fs::copy(target, dst).map(|_| ())
}

fn copy_file_with_retry(src: &Path, dst: &Path) -> Result<(), String> {
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

fn hardlink_with_retry(src: &Path, dst: &Path) -> Result<(), String> {
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

fn create_symlink_with_retry(task: &MaterializeSymlinkTask) -> Result<(), String> {
    match create_symlink(&task.target, &task.dst, &task.src) {
        Ok(()) => Ok(()),
        Err(_) => {
            remove_path_if_exists(&task.dst)?;
            create_symlink(&task.target, &task.dst, &task.src).map_err(|e| e.to_string())
        }
    }
}

enum MaterializeTask {
    File(MaterializeFileTask),
    Symlink(MaterializeSymlinkTask),
}

fn run_materialize_tasks_parallel(
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
                                    if hardlink_with_retry(&task.src, &task.dst).is_ok() {
                                        counters.files_linked.fetch_add(1, Ordering::Relaxed);
                                        Ok(())
                                    } else if let Err(err) =
                                        copy_file_with_retry(&task.src, &task.dst)
                                    {
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

fn materialize_tree(
    src_root: &Path,
    dst_root: &Path,
    strategy: LinkStrategy,
    jobs: usize,
) -> Result<MaterializeStats, String> {
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

    directories.sort();
    directories.dedup();
    for dir in &directories {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let counters = MaterializeCounters::default();
    run_materialize_tasks_parallel(tasks, strategy, jobs, &counters)?;

    let mut stats = counters.snapshot();
    stats.directories = directories.len().saturating_sub(1) as u64;
    Ok(stats)
}

fn write_materialize_json(
    src: &Path,
    dest: &Path,
    strategy: LinkStrategy,
    jobs: usize,
    ok: bool,
    reason: Option<String>,
    duration_ms: u64,
    stats: &MaterializeStats,
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
    w.end_object();
    w.out.push('\n');
    w.finish()
}

fn percentile_p95(mut values: Vec<u64>) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    let idx = ((values.len() - 1) as f64 * 0.95).floor() as usize;
    values[idx]
}

fn list_packages_in_node_modules(node_modules_dir: &Path) -> Result<Vec<PathBuf>, String> {
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

fn is_scope_dir(dir: &Path) -> bool {
    dir.file_name()
        .map(|n| n.to_string_lossy().starts_with('@'))
        .unwrap_or(false)
}

fn is_package_dir(dir: &Path) -> bool {
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
        // Direct child of node_modules: package dir unless it's a scope dir.
        return !name.starts_with('@');
    }

    // Scoped package dir: node_modules/@scope/name
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

fn write_analyze_json(
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
        // v0: only nodes (no edges)
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

fn write_scan_json(root: &Path, agg: &ScanAgg, ok: bool, reason: Option<String>) -> String {
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
    w.end_object();
    w.out.push('\n');
    w.finish()
}

#[derive(Clone)]
struct PackageOut {
    key: String,
    name: String,
    version: String,
    paths: Vec<String>,
    min_depth: u64,
    max_depth: u64,
    logical: u64,
    physical: u64,
    shared: u64,
    file_count: u64,
    approx: bool,
}

struct DuplicateOut {
    name: String,
    versions: Vec<String>,
    majors: Vec<String>,
    count: u64,
}

struct DepthOut {
    max_depth: u64,
    p95_depth: u64,
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

fn analyze(root: &Path, include_graph: bool) -> Result<String, String> {
    let node_modules_dir = root.join("node_modules");
    if !node_modules_dir.exists() {
        // Return ok=false? Align with JS behavior: JS returns ok:false. Here keep ok:true but empty?
        // We choose ok=false to preserve downstream failure semantics.
        return Err("node_modules_not_found".to_string());
    }

    // One-pass analysis for performance: walk node_modules once, attribute each file to its owning package dir.
    // Determinism: stable_list_dir sorts entries within each directory.
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

    Ok(write_analyze_json(
        root,
        &totals,
        &node_modules_dir,
        &packages,
        &duplicates,
        &depth_out,
        include_graph,
    ))
}

fn main() {
    match parse_args() {
        Command::Version => {
            println!("{VERSION}");
        }
        Command::Help { error } => {
            print_help(error);
            std::process::exit(2);
        }
        Command::Scan { root } => {
            let mut seen: HashSet<(u64, u64)> = HashSet::new();
            match scan_tree(&root, &HashSet::new(), Some(&mut seen)) {
                Ok(agg) => {
                    print!("{}", write_scan_json(&root, &agg, true, None));
                }
                Err(e) => {
                    let agg = ScanAgg::default();
                    print!("{}", write_scan_json(&root, &agg, false, Some(e)));
                    std::process::exit(1);
                }
            }
        }
        Command::Materialize {
            src,
            dest,
            link_strategy,
            jobs,
        } => {
            let started = Instant::now();
            match materialize_tree(&src, &dest, link_strategy, jobs) {
                Ok(stats) => {
                    let duration_ms = started.elapsed().as_millis() as u64;
                    print!(
                        "{}",
                        write_materialize_json(
                            &src,
                            &dest,
                            link_strategy,
                            jobs,
                            true,
                            None,
                            duration_ms,
                            &stats
                        )
                    );
                }
                Err(reason) => {
                    let duration_ms = started.elapsed().as_millis() as u64;
                    print!(
                        "{}",
                        write_materialize_json(
                            &src,
                            &dest,
                            link_strategy,
                            jobs,
                            false,
                            Some(reason),
                            duration_ms,
                            &MaterializeStats::default()
                        )
                    );
                    std::process::exit(1);
                }
            }
        }
        Command::Analyze { root, graph } => match analyze(&root, graph) {
            Ok(json) => {
                print!("{json}");
            }
            Err(reason) => {
                // Emit a small error JSON compatible with `better analyze` consumer expectations.
                let mut w = JsonWriter::new();
                w.begin_object();
                w.key("ok");
                w.value_bool(false);
                w.key("kind");
                w.value_string("better.analyze.report");
                w.key("schemaVersion");
                w.value_u64(1);
                w.key("projectRoot");
                w.value_string(&root.to_string_lossy());
                w.key("reason");
                w.value_string(&reason);
                w.end_object();
                w.out.push('\n');
                print!("{}", w.finish());
                std::process::exit(1);
            }
        },
    }
}
