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
pub use linux::{attach, detach, seal, serve};

pub const DEFAULT_SOCKET: &str = "/run/better/substrate.sock";

/// One daemon request line. Unknown fields are rejected so the root protocol cannot grow silently.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct Request { op: String, project: PathBuf }

#[cfg(target_os = "linux")]
mod linux {
    use super::{env_id, hex, Store};
    use sha2::{Digest, Sha256};
    use std::ffi::CString;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};

    const OVERLAYFS_SUPER_MAGIC: i64 = 0x794c_7630;
    const EROFS_SUPER_MAGIC: i64 = 0xE0F5_E1E2;
    const STATE_DIR: &str = ".better-substrate";
    const MAX_PROJECT_FILE: u64 = 64 * 1024 * 1024;

    pub struct Sealed { pub id: String, pub image: PathBuf, pub reused: bool }
    pub struct Attached { pub id: String, pub target: PathBuf, pub sealed_now: bool, pub reused: bool }

    fn io<T>(result: std::io::Result<T>, what: &str) -> Result<T, String> { result.map_err(|e| format!("{what}: {e}")) }
    fn check(r: i32, what: &str) -> Result<(), String> {
        if r == -1 { Err(format!("{what}: {}", std::io::Error::last_os_error())) } else { Ok(()) }
    }
    fn cstr(bytes: &[u8]) -> Result<CString, String> { CString::new(bytes).map_err(|_| "Path contains NUL".to_string()) }
    fn fd_path(fd: &OwnedFd) -> String { format!("/proc/self/fd/{}", fd.as_raw_fd()) }
    fn project_key(project: &Path) -> String { hex(&Sha256::digest(project.as_os_str().as_bytes())) }

    /// Project files are user-controlled: opened relative to the verified project handle, never
    /// through a symlink, never blocking on a FIFO.
    fn read_user_file(dir: &OwnedFd, name: &str) -> Result<Option<Vec<u8>>, String> {
        let c = cstr(name.as_bytes())?;
        let fd = unsafe { libc::openat(dir.as_raw_fd(), c.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) };
        if fd == -1 {
            let error = std::io::Error::last_os_error();
            return if error.kind() == std::io::ErrorKind::NotFound { Ok(None) } else { Err(format!("Cannot open {name}: {error}")) };
        }
        let file = unsafe { File::from_raw_fd(fd) };
        if !io(file.metadata(), "Cannot stat project file")?.is_file() { return Err(format!("{name} is not a regular file")); }
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

    /// A project directory opened without symlinks; its owner comes from that same handle.
    struct Project { path: PathBuf, fd: OwnedFd, owner: (u32, u32) }

    /// `caller` is the peer uid of a daemon request. Checking ownership on the handle that every
    /// later step uses means a path swapped after the check cannot point root at another user.
    fn open_project(project: &Path, caller: Option<u32>) -> Result<Project, String> {
        let path = io(project.canonicalize(), "Cannot resolve project")?;
        let fd = open_no_symlinks(&path)?;
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        check(unsafe { libc::fstat(fd.as_raw_fd(), &mut st) }, "Cannot stat project")?;
        if caller.is_some_and(|uid| uid != 0 && uid != st.st_uid) { return Err("Project is not owned by the caller".into()); }
        Ok(Project { path, fd, owner: (st.st_uid, st.st_gid) })
    }

    fn require_root() -> Result<(), String> {
        if unsafe { libc::geteuid() } != 0 { return Err("Attaching mounts filesystems and needs root".into()); }
        Ok(())
    }

    /// Builds the environment for `project`'s lockfile once. The erofs image is the single durable
    /// commit for everything it contains: one fsync, then an atomic rename into the store.
    pub fn seal(store: &Store, project: &Path, cache_root: &Path, caller: Option<u32>) -> Result<Sealed, String> {
        seal_project(store, &open_project(project, caller)?, cache_root)
    }

    fn seal_project(store: &Store, project: &Project, cache_root: &Path) -> Result<Sealed, String> {
        let owner = project.owner;
        let lockfile = read_user_file(&project.fd, "package-lock.json")?.ok_or("package-lock.json is required")?;
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

    fn build(project: &Project, lockfile: &[u8], staging: &Path, cache_root: &Path, owner: (u32, u32), image: &Path) -> Result<(), String> {
        io(fs::write(staging.join("package-lock.json"), lockfile), "Cannot stage lockfile")?;
        for name in ["package.json", ".npmrc"] {
            if let Some(bytes) = read_user_file(&project.fd, name)? { io(fs::write(staging.join(name), bytes), "Cannot stage project file")?; }
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
    pub fn attach(store: &Store, project: &Path, cache_root: &Path, caller: Option<u32>) -> Result<Attached, String> {
        require_root()?;
        let project = open_project(project, caller)?;
        let sealed = seal_project(store, &project, cache_root)?;
        let (root, owner) = (&project.fd, project.owner);
        let mut target = dir_at(root, "node_modules", owner)?;
        if fs_type(&target)? == OVERLAYFS_SUPER_MAGIC {
            // Installs repeat: either this environment is already here, or the lockfile moved on.
            if attached_id(&project)? == sealed.id {
                return Ok(Attached { id: sealed.id, target: project.path.join("node_modules"), sealed_now: false, reused: true });
            }
            drop(target);
            detach_project(store, &project)?;
            target = dir_at(root, "node_modules", owner)?;
        }
        if io(fs::read_dir(fd_path(&target)), "Cannot list node_modules")?.next().is_some() {
            return Err("node_modules is not empty; remove it before attaching".into());
        }
        let state = dir_at(root, STATE_DIR, owner)?;
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
        let reference = refs.join(project_key(&project.path));
        io(fs::write(&reference, project.path.as_os_str().as_bytes()), "Cannot record attachment")?;
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
        Ok(Attached { id: sealed.id, target: project.path.join("node_modules"), sealed_now: !sealed.reused, reused: false })
    }

    fn attached_id(project: &Project) -> Result<String, String> {
        let state = dir_at(&project.fd, STATE_DIR, project.owner)?;
        let mut id = String::new();
        io(state_file(&state, "id", false).and_then(|f| f.take(64).read_to_string(&mut id)), "Not attached")?;
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Corrupt attachment record".into()); }
        Ok(id)
    }

    /// Unmounts the overlay, discards the private upper, and releases the shared lower when unused.
    pub fn detach(store: &Store, project: &Path, caller: Option<u32>) -> Result<String, String> {
        require_root()?;
        detach_project(store, &open_project(project, caller)?)
    }

    fn detach_project(store: &Store, project: &Project) -> Result<String, String> {
        let (root, owner) = (&project.fd, project.owner);
        let id = attached_id(project)?;
        let state = dir_at(root, STATE_DIR, owner)?;
        let target = dir_at(root, "node_modules", owner)?;
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
        let _ = fs::remove_file(store.refs(&id).join(project_key(&project.path)));
        if fs::read_dir(store.refs(&id)).map(|mut d| d.next().is_none()).unwrap_or(true) {
            let lower = cstr(store.lower(&id).as_os_str().as_bytes())?;
            unsafe { libc::umount2(lower.as_ptr(), 0) }; // EBUSY means another attach raced in; keep it.
        }
        Ok(id)
    }

    const MAX_CLIENTS: usize = 512;
    const MAX_REQUEST: u64 = 4096;

    /// Root daemon: agents attach without sudo and without a process per mount. Each request is
    /// authorized by the peer uid (SO_PEERCRED) against the handle the work then uses.
    pub fn serve(store: Store, socket: &Path, cache_root: PathBuf) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::{atomic::{AtomicUsize, Ordering}, Arc};
        require_root()?;
        io(fs::create_dir_all(socket.parent().ok_or("Invalid socket path")?), "Cannot create socket dir")?;
        let _ = fs::remove_file(socket);
        let listener = io(UnixListener::bind(socket), "Cannot bind socket")?;
        // Any local user may connect; authorization is per request, by project ownership.
        io(fs::set_permissions(socket, fs::Permissions::from_mode(0o666)), "Cannot open socket to users")?;
        let shared = Arc::new((store, cache_root, AtomicUsize::new(0)));
        for stream in listener.incoming().flatten() {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || {
                let (store, cache, active) = &*shared;
                // Bounded, so a flood of idle connections cannot exhaust root's threads.
                if active.fetch_add(1, Ordering::SeqCst) < MAX_CLIENTS { let _ = handle(&stream, store, cache); } else {
                    let mut out = &stream;
                    let _ = writeln!(out, "{}", super::reply("request", Err("Daemon busy".into()), std::time::Instant::now()));
                }
                active.fetch_sub(1, Ordering::SeqCst);
            });
        }
        Ok(())
    }

    fn handle(stream: &UnixStream, store: &Store, cache: &Path) -> std::io::Result<()> {
        use std::io::BufRead;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(10)))?;
        stream.set_write_timeout(Some(std::time::Duration::from_secs(10)))?;
        let caller = peer_uid(stream)?;
        let mut line = String::new();
        std::io::BufReader::new(stream.take(MAX_REQUEST)).read_line(&mut line)?;
        let started = std::time::Instant::now();
        let reply = match serde_json::from_str::<super::Request>(&line) {
            Ok(request) => super::reply(&request.op, super::dispatch(&request.op, store, &request.project, cache, Some(caller)), started),
            Err(e) => super::reply("request", Err(format!("Bad request: {e}")), started),
        };
        let mut out = stream;
        writeln!(out, "{reply}")
    }

    fn peer_uid(stream: &UnixStream) -> std::io::Result<u32> {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let r = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len) };
        if r == -1 { Err(std::io::Error::last_os_error()) } else { Ok(cred.uid) }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn me() -> (u32, u32) { unsafe { (libc::geteuid(), libc::getegid()) } }

        #[test]
        fn daemon_callers_only_reach_their_own_projects() {
            let temp = tempfile::tempdir().unwrap();
            let (uid, _) = me();
            assert!(open_project(temp.path(), None).is_ok());
            assert!(open_project(temp.path(), Some(uid)).is_ok());
            assert!(open_project(temp.path(), Some(0)).is_ok(), "root may act for anyone");
            let err = open_project(temp.path(), Some(uid.wrapping_add(1))).err().unwrap();
            assert!(err.contains("not owned by the caller"), "{err}");
        }

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
            assert!(read_user_file(&state, "id").is_err());
            assert!(read_user_file(&root, "absent").unwrap().is_none());
        }
    }
}

/// `better-core substrate <seal|attach|detach> --project-root P` prints one JSON line; as root it
/// acts directly, otherwise it asks the daemon. `better-core substrate serve` runs the daemon.
/// Flags: --store S, --cache-root C, --socket PATH.
pub fn cli(args: &[std::ffi::OsString]) -> i32 {
    let started = std::time::Instant::now();
    let action = args.first().and_then(|a| a.to_str()).unwrap_or("").to_string();
    let (mut project, mut store, mut cache, mut socket) = (None, PathBuf::from(DEFAULT_STORE), None, PathBuf::from(DEFAULT_SOCKET));
    let mut rest = args.iter().skip(1);
    while let Some(flag) = rest.next() {
        let value = rest.next().map(PathBuf::from);
        match (flag.to_str(), value) {
            (Some("--project-root"), Some(v)) => project = Some(v),
            (Some("--store"), Some(v)) => store = v,
            (Some("--cache-root"), Some(v)) => cache = Some(v),
            (Some("--socket"), Some(v)) => socket = v,
            _ => return emit(reply(&action, Err("usage: substrate <seal|attach|detach|serve> [--project-root P] [--store S] [--cache-root C] [--socket PATH]".into()), started), 2),
        }
    }
    let cache = cache.unwrap_or_else(|| store.join("cache"));
    if action == "serve" {
        return match Store::new(store).and_then(|store| serve_on(store, &socket, cache)) { Ok(()) => 0, Err(e) => emit(reply(&action, Err(e), started), 1) };
    }
    let Some(project) = project else { return emit(reply(&action, Err("--project-root is required".into()), started), 2) };
    let value = if unsafe { libc::geteuid() } == 0 {
        reply(&action, Store::new(store).and_then(|store| dispatch(&action, &store, &project, &cache, None)), started)
    } else {
        forward(&socket, &action, &project).unwrap_or_else(|e| reply(&action, Err(e), started))
    };
    let code = if value["ok"] == true { 0 } else { 1 };
    emit(value, code)
}

fn emit(value: serde_json::Value, code: i32) -> i32 { println!("{value}"); code }

/// The one JSON shape shared by the CLI and the daemon.
fn reply(action: &str, result: Result<serde_json::Value, String>, started: std::time::Instant) -> serde_json::Value {
    let (kind, ms) = (format!("better.substrate.{action}"), started.elapsed().as_secs_f64() * 1000.0);
    match result {
        Ok(mut value) => { value["ok"] = true.into(); value["kind"] = kind.into(); value["ms"] = ms.into(); value }
        Err(reason) => serde_json::json!({"ok": false, "kind": kind, "reason": reason, "ms": ms}),
    }
}

/// Sends one request to the daemon; its reply already carries ok, kind and ms.
fn forward(socket: &Path, action: &str, project: &Path) -> Result<serde_json::Value, String> {
    use std::io::{BufRead, Write};
    let project = project.canonicalize().map_err(|e| format!("Cannot resolve project: {e}"))?;
    let stream = std::os::unix::net::UnixStream::connect(socket).map_err(|e| format!("Cannot reach the substrate daemon at {}: {e}", socket.display()))?;
    let mut out = &stream;
    writeln!(out, "{}", serde_json::json!({"op": action, "project": project})).map_err(|e| format!("Cannot send request: {e}"))?;
    let mut line = String::new();
    std::io::BufReader::new(&stream).read_line(&mut line).map_err(|e| format!("No reply from daemon: {e}"))?;
    serde_json::from_str(&line).map_err(|e| format!("Bad daemon reply: {e}"))
}

#[cfg(target_os = "linux")]
fn dispatch(action: &str, store: &Store, project: &Path, cache: &Path, caller: Option<u32>) -> Result<serde_json::Value, String> {
    match action {
        "seal" => seal(store, project, cache, caller).map(|s| serde_json::json!({"id": s.id, "image": s.image, "reused": s.reused})),
        "attach" => attach(store, project, cache, caller).map(|a| serde_json::json!({"id": a.id, "target": a.target, "sealedNow": a.sealed_now, "reused": a.reused})),
        "detach" => detach(store, project, caller).map(|id| serde_json::json!({"id": id})),
        _ => Err("expected seal, attach or detach".into()),
    }
}

#[cfg(target_os = "linux")]
fn serve_on(store: Store, socket: &Path, cache: PathBuf) -> Result<(), String> { serve(store, socket, cache) }

#[cfg(not(target_os = "linux"))]
fn dispatch(_: &str, _: &Store, _: &Path, _: &Path, _: Option<u32>) -> Result<serde_json::Value, String> {
    Err("Sealed environments need Linux (erofs and overlayfs)".into())
}

#[cfg(not(target_os = "linux"))]
fn serve_on(_: Store, _: &Path, _: PathBuf) -> Result<(), String> { Err("Sealed environments need Linux (erofs and overlayfs)".into()) }

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
    fn daemon_requests_accept_only_op_and_project() {
        assert!(serde_json::from_str::<Request>(r#"{"op":"attach","project":"/p"}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"op":"attach","project":"/p","caller":0}"#).is_err(), "no caller override");
        assert!(serde_json::from_str::<Request>(r#"{"op":"attach"}"#).is_err());
    }

    #[test]
    fn store_paths_cannot_inject_overlay_options() {
        assert!(Store::new(PathBuf::from("/var/lib/better/substrate")).is_ok());
        for bad in ["relative", "/a,upperdir=/etc", "/a:b", "/a=b"] { assert!(Store::new(PathBuf::from(bad)).is_err(), "{bad}"); }
    }
}
