//! Sealed dependency environments for agent fleets. The hoisted node_modules for a lockfile is
//! built once, frozen into an erofs image, and attached to each worktree with a private overlay:
//! one mount replaces an install. Seal, attach and detach are Linux-only; attach and detach need root.
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const TAG: &str = "better-substrate-v1";
pub const DEFAULT_STORE: &str = "/var/lib/better/substrate";

/// Hash of every input that changes the sealed bytes. Scripts never run at seal time, so the
/// Node ABI is not an input yet; it must become one when sealing runs install scripts.
pub fn env_id(lockfile: &[u8], owner: (u32, u32)) -> String {
    let (os, cpu) = crate::native_install_target();
    let libc = if cfg!(target_env = "musl") { "musl" } else { "glibc" };
    let owner = format!("{}:{}", owner.0, owner.1);
    let mut hash = Sha256::new();
    for part in [TAG.as_bytes(), env!("CARGO_PKG_VERSION").as_bytes(), os.as_bytes(), cpu.as_bytes(), libc.as_bytes(), owner.as_bytes(), lockfile] {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    hex(&hash.finalize())
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

/// Root-owned layout: images/<id>.erofs, lower/<id> (shared mount), refs/<id>/<project hash>, locks/<id>.lock.
pub struct Store { root: PathBuf }

impl Store {
    /// The store path lands in overlay mount options, where a comma or colon would inject options.
    pub fn new(root: PathBuf) -> Result<Self, String> {
        let text = root.to_str().ok_or("Store path must be UTF-8")?;
        if !root.is_absolute() || text.contains([',', ':', '\\', '=']) { return Err("Store path must be absolute without , : = \\".into()); }
        Ok(Self { root })
    }
    pub fn image(&self, id: &str) -> PathBuf { self.root.join("images").join(format!("{id}.erofs")) }
    pub fn lower(&self, id: &str) -> PathBuf { self.root.join("lower").join(id) }
    pub fn refs(&self, id: &str) -> PathBuf { self.root.join("refs").join(id) }
}

#[cfg(target_os = "linux")]
pub use linux::{attach, detach, seal};

#[cfg(target_os = "linux")]
mod linux {
    use super::{env_id, hex, Store};
    use sha2::{Digest, Sha256};
    use std::ffi::CString;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::path::{Path, PathBuf};

    const OVERLAYFS_SUPER_MAGIC: i64 = 0x794c_7630;
    const EROFS_SUPER_MAGIC: i64 = 0xE0F5_E1E2;
    const STATE_DIR: &str = ".better-substrate";
    const MAX_PROJECT_FILE: u64 = 64 * 1024 * 1024;

    pub struct Sealed { pub id: String, pub image: PathBuf, pub reused: bool }
    pub struct Attached { pub id: String, pub target: PathBuf, pub sealed_now: bool }

    fn io<T>(result: std::io::Result<T>, what: &str) -> Result<T, String> { result.map_err(|e| format!("{what}: {e}")) }
    fn check(r: i32, what: &str) -> Result<(), String> {
        if r == -1 { Err(format!("{what}: {}", std::io::Error::last_os_error())) } else { Ok(()) }
    }
    fn cstr(bytes: &[u8]) -> Result<CString, String> { CString::new(bytes).map_err(|_| "Path contains NUL".to_string()) }
    fn fd_path(fd: &OwnedFd) -> String { format!("/proc/self/fd/{}", fd.as_raw_fd()) }
    fn project_key(project: &Path) -> String { hex(&Sha256::digest(project.as_os_str().as_bytes())) }

    /// Project files are user-controlled: never follow a symlink, never block on a FIFO.
    fn read_user_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
        let file = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("Cannot open {}: {e}", path.display())),
        };
        if !io(file.metadata(), "Cannot stat project file")?.is_file() { return Err(format!("{} is not a regular file", path.display())); }
        let mut bytes = Vec::new();
        io(file.take(MAX_PROJECT_FILE).read_to_end(&mut bytes), "Cannot read project file")?;
        Ok(Some(bytes))
    }

    /// One exclusive lock per environment: concurrent seals of an id collapse into one build, and
    /// the shared lower is never unmounted while an attach is in progress.
    fn lock(store: &Store, id: &str) -> Result<File, String> {
        let dir = store.root.join("locks");
        io(fs::create_dir_all(&dir), "Cannot create lock dir")?;
        let file = io(File::options().create(true).truncate(false).write(true).open(dir.join(format!("{id}.lock"))), "Cannot open lock")?;
        io(file.lock(), "Cannot lock environment")?;
        Ok(file)
    }

    /// Opens a directory with no symlink anywhere in its path (openat2 RESOLVE_NO_SYMLINKS).
    fn open_no_symlinks(path: &Path) -> Result<OwnedFd, String> {
        #[repr(C)]
        struct OpenHow { flags: u64, mode: u64, resolve: u64 }
        const RESOLVE_NO_SYMLINKS: u64 = 0x04;
        let how = OpenHow { flags: (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64, mode: 0, resolve: RESOLVE_NO_SYMLINKS };
        let c = cstr(path.as_os_str().as_bytes())?;
        let fd = unsafe { libc::syscall(libc::SYS_openat2, libc::AT_FDCWD, c.as_ptr(), &how as *const OpenHow, std::mem::size_of::<OpenHow>()) };
        if fd < 0 { return Err(format!("Cannot open {} without symlinks: {}", path.display(), std::io::Error::last_os_error())); }
        Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
    }

    /// Creates (or reuses) a real directory under `parent` and returns an O_PATH handle to it.
    /// Only a directory this call created is handed to `owner`.
    fn dir_at(parent: &OwnedFd, name: &str, owner: (u32, u32)) -> Result<OwnedFd, String> {
        let c = cstr(name.as_bytes())?;
        let created = unsafe { libc::mkdirat(parent.as_raw_fd(), c.as_ptr(), 0o755) } == 0;
        if !created && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
            return Err(format!("Cannot create {name}: {}", std::io::Error::last_os_error()));
        }
        let fd = unsafe { libc::openat(parent.as_raw_fd(), c.as_ptr(), libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        check(fd, &format!("{name} must be a real directory"))?;
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        if created {
            let empty = cstr(b"")?;
            check(unsafe { libc::fchownat(fd.as_raw_fd(), empty.as_ptr(), owner.0, owner.1, libc::AT_EMPTY_PATH) }, "Cannot chown")?;
        }
        Ok(fd)
    }

    /// Opens `name` inside an attach-state directory without following a planted symlink.
    fn state_file(state: &OwnedFd, name: &str, write: bool) -> std::io::Result<File> {
        let mut options = OpenOptions::new();
        if write { options.write(true).create(true).truncate(true).mode(0o644); } else { options.read(true); }
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(format!("{}/{name}", fd_path(state)))
    }

    fn fs_type(fd: &OwnedFd) -> Result<i64, String> {
        let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
        check(unsafe { libc::fstatfs(fd.as_raw_fd(), &mut buf) }, "fstatfs")?;
        Ok(buf.f_type as i64)
    }

    fn mount(source: &str, target: &str, fstype: &str, flags: libc::c_ulong, data: &str) -> std::io::Result<()> {
        let (s, t, f, d) = (CString::new(source)?, CString::new(target)?, CString::new(fstype)?, CString::new(data)?);
        if unsafe { libc::mount(s.as_ptr(), t.as_ptr(), f.as_ptr(), flags, d.as_ptr().cast()) } == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
    }

    fn owner_of(path: &Path) -> Result<(u32, u32), String> {
        let meta = io(fs::symlink_metadata(path), "Cannot stat project")?;
        Ok((meta.uid(), meta.gid()))
    }

    fn require_root() -> Result<(), String> {
        if unsafe { libc::geteuid() } != 0 { return Err("Attaching mounts filesystems and needs root".into()); }
        Ok(())
    }

    /// Builds the environment for `project`'s lockfile once. The erofs image is the single durable
    /// commit for everything it contains: one fsync, then an atomic rename into the store.
    pub fn seal(store: &Store, project: &Path, cache_root: &Path) -> Result<Sealed, String> {
        let owner = owner_of(project)?;
        let lockfile = read_user_file(&project.join("package-lock.json"))?.ok_or("package-lock.json is required")?;
        let id = env_id(&lockfile, owner);
        let _lock = lock(store, &id)?;
        let image = store.image(&id);
        if image.is_file() { return Ok(Sealed { id, image, reused: true }); }
        let staging = store.root.join("tmp").join(format!("{id}.{}", std::process::id()));
        let _ = fs::remove_dir_all(&staging);
        io(fs::create_dir_all(&staging), "Cannot create staging")?;
        let built = build(project, &lockfile, &staging, cache_root, owner, &image);
        let _ = fs::remove_dir_all(&staging);
        built.map(|()| Sealed { id, image, reused: false })
    }

    fn build(project: &Path, lockfile: &[u8], staging: &Path, cache_root: &Path, owner: (u32, u32), image: &Path) -> Result<(), String> {
        io(fs::write(staging.join("package-lock.json"), lockfile), "Cannot stage lockfile")?;
        for name in ["package.json", ".npmrc"] {
            if let Some(bytes) = read_user_file(&project.join(name))? { io(fs::write(staging.join(name), bytes), "Cannot stage project file")?; }
        }
        let (os, cpu) = crate::native_install_target();
        let jobs = std::thread::available_parallelism().map(|n| n.get().saturating_mul(2)).unwrap_or(8).clamp(1, 64);
        crate::install::run_install(crate::install::InstallOptions {
            lockfile: staging.join("package-lock.json"), project_root: staging.to_path_buf(), cache_root: cache_root.to_path_buf(),
            store_root: None, link_strategy: crate::types::LinkStrategy::Auto, jobs, extraction_jobs: None,
            artifact_limits: Default::default(), scripts: false, dedup: false, frozen: false, offline: false, production: false,
            target_os: os.to_string(), target_cpu: cpu.to_string(), json_progress: false, node_layout: crate::types::NodeLayout::Hoist,
            sandbox: false, verify_provenance: false, require_provenance: false, registry_failover: false, json_mode: true, progress_enabled: false,
        }).map_err(|e| e.report.trim().to_string())?;
        let partial = staging.join("image.erofs");
        let status = std::process::Command::new("mkfs.erofs")
            .arg(format!("--force-uid={}", owner.0)).arg(format!("--force-gid={}", owner.1)).arg("-T0")
            .arg(&partial).arg(staging.join("node_modules"))
            .stdout(std::process::Stdio::null()).status()
            .map_err(|e| format!("mkfs.erofs is required (erofs-utils): {e}"))?;
        if !status.success() { return Err(format!("mkfs.erofs failed: {status}")); }
        io(File::open(&partial).and_then(|f| f.sync_all()), "Cannot flush image")?;
        let dir = image.parent().ok_or("Invalid image path")?;
        io(fs::create_dir_all(dir), "Cannot create image dir")?;
        io(fs::rename(&partial, image), "Cannot publish image")?;
        io(File::open(dir).and_then(|d| d.sync_all()), "Cannot flush image dir")
    }

    /// Mounts the sealed environment at `project/node_modules` with a private writable upper.
    /// Every user-owned path is opened O_NOFOLLOW and mounted through /proc/self/fd, so swapping
    /// a directory for a symlink cannot make root mount or write anywhere else.
    pub fn attach(store: &Store, project: &Path, cache_root: &Path) -> Result<Attached, String> {
        require_root()?;
        let project = io(project.canonicalize(), "Cannot resolve project")?;
        let sealed = seal(store, &project, cache_root)?;
        let owner = owner_of(&project)?;
        let root = open_no_symlinks(&project)?;
        let target = dir_at(&root, "node_modules", owner)?;
        if fs_type(&target)? == OVERLAYFS_SUPER_MAGIC { return Err("node_modules is already attached".into()); }
        if io(fs::read_dir(fd_path(&target)), "Cannot list node_modules")?.next().is_some() {
            return Err("node_modules is not empty; remove it before attaching".into());
        }
        let state = dir_at(&root, STATE_DIR, owner)?;
        let (upper, work) = (dir_at(&state, "upper", owner)?, dir_at(&state, "work", owner)?);
        let _guard = lock(store, &sealed.id)?;
        let lower = store.lower(&sealed.id);
        io(fs::create_dir_all(&lower), "Cannot create lower dir")?;
        if fs_type(&open_no_symlinks(&lower)?)? != EROFS_SUPER_MAGIC {
            // File-backed erofs (Linux 6.12+) avoids a loop device and its second page cache.
            let flags = libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV;
            if mount(&store.image(&sealed.id).to_string_lossy(), &lower.to_string_lossy(), "erofs", flags, "").is_err() {
                let status = std::process::Command::new("mount").args(["-t", "erofs", "-o", "loop,ro,nosuid,nodev"])
                    .arg(store.image(&sealed.id)).arg(&lower).status().map_err(|e| format!("Cannot mount image: {e}"))?;
                if !status.success() { return Err(format!("Cannot mount image: {status}")); }
            }
        }
        let refs = store.refs(&sealed.id);
        io(fs::create_dir_all(&refs), "Cannot create refs")?;
        // Record before mounting, so a mounted overlay always has a record detach can find.
        io(state_file(&state, "id", true).and_then(|mut f| f.write_all(sealed.id.as_bytes())), "Cannot record environment")?;
        let reference = refs.join(project_key(&project));
        io(fs::write(&reference, project.as_os_str().as_bytes()), "Cannot record attachment")?;
        // The overlay mount stays inside the lock: the kernel serializes mounts per namespace anyway,
        // and queueing on the lock measured faster at width 100 than contending for that rwsem.
        // The upper belongs to one agent and is discarded at detach, so skipping its syncs loses nothing.
        let data = format!("lowerdir={},upperdir={},workdir={}", lower.display(), fd_path(&upper), fd_path(&work));
        let flags = libc::MS_NOSUID | libc::MS_NODEV;
        let mounted = mount("overlay", &fd_path(&target), "overlay", flags, &format!("{data},volatile"))
            .or_else(|_| mount("overlay", &fd_path(&target), "overlay", flags, &data));
        if let Err(e) = mounted {
            let _ = fs::remove_file(&reference);
            let _ = fs::remove_file(format!("{}/id", fd_path(&state)));
            return Err(format!("Cannot mount overlay: {e}"));
        }
        Ok(Attached { id: sealed.id, target: project.join("node_modules"), sealed_now: !sealed.reused })
    }

    /// Unmounts the overlay, discards the private upper, and releases the shared lower when unused.
    pub fn detach(store: &Store, project: &Path) -> Result<String, String> {
        require_root()?;
        let project = io(project.canonicalize(), "Cannot resolve project")?;
        let root = open_no_symlinks(&project)?;
        let owner = owner_of(&project)?;
        let state = dir_at(&root, STATE_DIR, owner)?;
        let mut id = String::new();
        io(state_file(&state, "id", false).and_then(|f| f.take(64).read_to_string(&mut id)), "Not attached")?;
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Corrupt attachment record".into()); }
        let target = dir_at(&root, "node_modules", owner)?;
        if fs_type(&target)? == OVERLAYFS_SUPER_MAGIC {
            let path = cstr(fd_path(&target).as_bytes())?;
            check(unsafe { libc::umount2(path.as_ptr(), libc::MNT_DETACH) }, "Cannot unmount overlay")?;
        }
        drop(target);
        // remove_dir_all never follows symlinks below its root; the root is the verified O_PATH handle.
        for entry in io(fs::read_dir(fd_path(&state)), "Cannot list attach state")? {
            let entry = io(entry, "Cannot list attach state")?;
            let removed = if entry.file_type().is_ok_and(|t| t.is_dir()) { fs::remove_dir_all(entry.path()) } else { fs::remove_file(entry.path()) };
            io(removed, "Cannot discard upper")?;
        }
        let _lock = lock(store, &id)?;
        let _ = fs::remove_file(store.refs(&id).join(project_key(&project)));
        if fs::read_dir(store.refs(&id)).map(|mut d| d.next().is_none()).unwrap_or(true) {
            let lower = cstr(store.lower(&id).as_os_str().as_bytes())?;
            unsafe { libc::umount2(lower.as_ptr(), 0) }; // EBUSY means another attach raced in; keep it.
        }
        Ok(id)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn me() -> (u32, u32) { unsafe { (libc::geteuid(), libc::getegid()) } }

        #[test]
        fn attach_state_never_follows_symlinks() {
            let temp = tempfile::tempdir().unwrap();
            let elsewhere = temp.path().join("elsewhere");
            fs::create_dir(&elsewhere).unwrap();
            std::os::unix::fs::symlink(&elsewhere, temp.path().join("node_modules")).unwrap();
            let root = open_no_symlinks(temp.path()).unwrap();
            assert!(dir_at(&root, "node_modules", me()).is_err(), "a symlinked target must be rejected");
            assert!(open_no_symlinks(&temp.path().join("node_modules")).is_err(), "no symlink anywhere in the path");
            let state = dir_at(&root, "state", me()).unwrap();
            std::os::unix::fs::symlink(elsewhere.join("victim"), temp.path().join("state/id")).unwrap();
            assert!(state_file(&state, "id", true).is_err(), "a planted id symlink must not be written through");
            assert!(!elsewhere.join("victim").exists());
            assert!(read_user_file(&temp.path().join("state/id")).is_err());
            assert!(read_user_file(&temp.path().join("absent")).unwrap().is_none());
        }
    }
}

/// `better-core substrate <seal|attach|detach> --project-root P [--store S] [--cache-root C]`, one JSON line.
pub fn cli(args: &[std::ffi::OsString]) -> i32 {
    let action = args.first().and_then(|a| a.to_str()).unwrap_or("").to_string();
    let (mut project, mut store, mut cache) = (None, PathBuf::from(DEFAULT_STORE), None);
    let mut rest = args.iter().skip(1);
    while let Some(flag) = rest.next() {
        let value = rest.next().map(PathBuf::from);
        match (flag.to_str(), value) {
            (Some("--project-root"), Some(v)) => project = Some(v),
            (Some("--store"), Some(v)) => store = v,
            (Some("--cache-root"), Some(v)) => cache = Some(v),
            _ => return fail(&action, "usage: substrate <seal|attach|detach> --project-root P [--store S] [--cache-root C]", 0.0, 2),
        }
    }
    let Some(project) = project else { return fail(&action, "--project-root is required", 0.0, 2) };
    let cache = cache.unwrap_or_else(|| store.join("cache"));
    let started = std::time::Instant::now();
    let result = Store::new(store).and_then(|store| run(&action, &store, &project, &cache));
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    match result {
        Ok(mut value) => {
            value["ok"] = true.into();
            value["kind"] = format!("better.substrate.{action}").into();
            value["ms"] = ms.into();
            println!("{value}");
            0
        }
        Err(reason) => fail(&action, &reason, ms, 1),
    }
}

fn fail(action: &str, reason: &str, ms: f64, code: i32) -> i32 {
    println!("{}", serde_json::json!({"ok": false, "kind": format!("better.substrate.{action}"), "reason": reason, "ms": ms}));
    code
}

#[cfg(target_os = "linux")]
fn run(action: &str, store: &Store, project: &Path, cache: &Path) -> Result<serde_json::Value, String> {
    match action {
        "seal" => seal(store, project, cache).map(|s| serde_json::json!({"id": s.id, "image": s.image, "reused": s.reused})),
        "attach" => attach(store, project, cache).map(|a| serde_json::json!({"id": a.id, "target": a.target, "sealedNow": a.sealed_now})),
        "detach" => detach(store, project).map(|id| serde_json::json!({"id": id})),
        _ => Err("expected seal, attach or detach".into()),
    }
}

#[cfg(not(target_os = "linux"))]
fn run(_: &str, _: &Store, _: &Path, _: &Path) -> Result<serde_json::Value, String> {
    Err("Sealed environments need Linux (erofs and overlayfs)".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_id_tracks_lockfile_bytes_and_owner() {
        let a = env_id(b"{\"lockfileVersion\":3}", (1000, 1000));
        assert_eq!(a, env_id(b"{\"lockfileVersion\":3}", (1000, 1000)));
        assert_eq!(a.len(), 64);
        assert_ne!(a, env_id(b"{\"lockfileVersion\":3} ", (1000, 1000)));
        assert_ne!(a, env_id(b"{\"lockfileVersion\":3}", (1001, 1000)));
    }

    #[test]
    fn store_paths_cannot_inject_overlay_options() {
        assert!(Store::new(PathBuf::from("/var/lib/better/substrate")).is_ok());
        for bad in ["relative", "/a,upperdir=/etc", "/a:b", "/a=b"] { assert!(Store::new(PathBuf::from(bad)).is_err(), "{bad}"); }
    }
}
