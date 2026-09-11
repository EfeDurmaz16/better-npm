//! Process-local, bounded resident install admission. A small persistent pool
//! orchestrates independent projects; one shared executor supplies file parallelism.
//! This is not a system-wide daemon and does not report ready until work completes.
use crate::fetch_pipeline::{ArtifactLimits, FetchOptions};
use crate::install::{run_install, InstallError, InstallOptions};
use crate::{LinkStrategy, NodeLayout};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Instant;

const QUEUE_CAPACITY: usize = 8;
const RESIDENT_NETWORK_JOBS: usize = 8;
const RESIDENT_EXTRACT_JOBS: usize = 4;
const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallRequest {
    project_root: PathBuf,
    lockfile: Option<PathBuf>,
    cache_root: Option<PathBuf>,
    store_root: Option<PathBuf>,
    link_strategy: Option<String>,
    jobs: Option<usize>,
    extract_jobs: Option<usize>,
    max_tarball_bytes: Option<u64>,
    max_expanded_bytes: Option<u64>,
    max_archive_entries: Option<u64>,
    max_archive_metadata_bytes: Option<u64>,
    scripts: Option<bool>,
    #[serde(default)]
    dedup: bool,
    #[serde(default)]
    frozen: bool,
    #[serde(default)]
    offline: bool,
    #[serde(default)]
    production: bool,
    target_os: Option<String>,
    target_cpu: Option<String>,
    node_layout: Option<String>,
    #[serde(default)]
    sandbox: bool,
    #[serde(default)]
    verify_provenance: bool,
    #[serde(default)]
    require_provenance: bool,
    #[serde(default)]
    registry_failover: bool,
}

pub fn options_from_json(json: &str) -> Result<InstallOptions, InstallError> {
    if json.len() > MAX_REQUEST_BYTES {
        return Err(InstallError::new("Resident request exceeds 64 KiB"));
    }
    let r: InstallRequest = serde_json::from_str(json)
        .map_err(|e| InstallError::new(format!("Invalid resident install options: {e}")))?;
    if r.sandbox || r.verify_provenance || r.require_provenance {
        return Err(InstallError::new(
            "Sandbox and cryptographic provenance options are not supported for install",
        ));
    }
    let lockfile = r
        .lockfile
        .unwrap_or_else(|| r.project_root.join("package-lock.json"));
    let cache_root = r.cache_root.unwrap_or_else(default_cache_root);
    // Resident callers cannot change the process cwd to interpret a request.
    for path in [&r.project_root, &lockfile, &cache_root]
        .into_iter()
        .chain(r.store_root.iter())
    {
        if !path.is_absolute() {
            return Err(InstallError::new("Resident install paths must be absolute"));
        }
    }
    let jobs = r.jobs.unwrap_or_else(|| {
        std::thread::available_parallelism()
            .map(|n| n.get().saturating_mul(2))
            .unwrap_or(8)
            .clamp(1, 64)
    });
    let defaults = ArtifactLimits::default();
    let artifact_limits = ArtifactLimits {
        compressed_bytes: r.max_tarball_bytes.unwrap_or(defaults.compressed_bytes),
        expanded_bytes: r.max_expanded_bytes.unwrap_or(defaults.expanded_bytes),
        entries: r.max_archive_entries.unwrap_or(defaults.entries),
        metadata_bytes: r
            .max_archive_metadata_bytes
            .unwrap_or(defaults.metadata_bytes),
    };
    FetchOptions {
        network_jobs: jobs,
        extract_jobs: r.extract_jobs.unwrap_or(jobs),
        limits: artifact_limits,
    }
    .validate()
    .map_err(InstallError::new)?;
    let mut options = InstallOptions {
        project_root: r.project_root,
        lockfile,
        cache_root,
        store_root: r.store_root,
        link_strategy: LinkStrategy::from_arg(r.link_strategy.as_deref().unwrap_or("auto"))
            .ok_or_else(|| InstallError::new("Invalid link strategy"))?,
        node_layout: NodeLayout::from_arg(r.node_layout.as_deref().unwrap_or("hoist"))
            .ok_or_else(|| InstallError::new("Invalid node layout"))?,
        jobs,
        extraction_jobs: r.extract_jobs,
        artifact_limits,
        scripts: r.scripts.unwrap_or(true),
        dedup: r.dedup,
        frozen: r.frozen,
        offline: r.offline,
        production: r.production,
        target_os: r.target_os.unwrap_or_else(|| {
            match std::env::consts::OS {
                "macos" => "darwin",
                "windows" => "win32",
                v => v,
            }
            .into()
        }),
        target_cpu: r.target_cpu.unwrap_or_else(|| {
            match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                "x86" => "ia32",
                v => v,
            }
            .into()
        }),
        json_progress: false,
        json_mode: false,
        progress_enabled: false,
        sandbox: false,
        verify_provenance: false,
        require_provenance: false,
        registry_failover: r.registry_failover,
    };
    bound_resident_resources(&mut options)?;
    Ok(options)
}

fn default_cache_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    #[cfg(target_os = "macos")]
    {
        home.join("Library/Caches/better")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("better/cache")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".cache"))
            .join("better")
    }
}

struct Job {
    options: InstallOptions,
    accepted: Instant,
    complete: Box<dyn FnOnce(Result<String, InstallError>) + Send>,
}

pub struct InstallTicket {
    result: mpsc::Receiver<Result<String, InstallError>>,
}
impl InstallTicket {
    /// Blocking ready wait; bindings must call it off their event-loop thread.
    pub fn wait(self) -> Result<String, InstallError> {
        self.result
            .recv()
            .map_err(|_| InstallError::new("Resident install coordinator stopped"))?
    }
}

static COORDINATOR: OnceLock<Result<mpsc::SyncSender<Job>, String>> = OnceLock::new();

/// Admission is nonblocking and bounded before a binding schedules a wait task.
/// Running installs are not cancellable; callers must await their final result.
pub fn submit(options: InstallOptions) -> Result<InstallTicket, InstallError> {
    let (sender, receiver) = mpsc::sync_channel(1);
    admit(Job {
        options,
        accepted: Instant::now(),
        complete: Box::new(move |result| {
            let _ = sender.send(result);
        }),
    })
    .map_err(|(error, _job)| error)?;
    Ok(InstallTicket { result: receiver })
}

/// Complete exactly once, including failed queue admission. Bindings can send
/// their result directly to an event loop without occupying a blocking wait pool.
pub fn submit_with_callback(
    options: InstallOptions,
    complete: impl FnOnce(Result<String, InstallError>) + Send + 'static,
) {
    let job = Job {
        options,
        accepted: Instant::now(),
        complete: Box::new(complete),
    };
    if let Err((error, job)) = admit(job) {
        (job.complete)(Err(error));
    }
}

fn bound_resident_resources(options: &mut InstallOptions) -> Result<(), InstallError> {
    let extraction_jobs = options.extraction_jobs.unwrap_or(options.jobs);
    // Validate requested values before capping, including direct Rust callers.
    FetchOptions {
        network_jobs: options.jobs,
        extract_jobs: extraction_jobs,
        limits: options.artifact_limits,
    }
    .validate()
    .map_err(InstallError::new)?;
    options.jobs = options.jobs.min(RESIDENT_NETWORK_JOBS);
    options.extraction_jobs = Some(extraction_jobs.min(RESIDENT_EXTRACT_JOBS));
    Ok(())
}

fn admit(mut job: Job) -> Result<(), (InstallError, Job)> {
    if let Err(error) = bound_resident_resources(&mut job.options) {
        return Err((error, job));
    }
    let sender = COORDINATOR.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<Job>(QUEUE_CAPACITY);
        let receiver = Arc::new(Mutex::new(receiver));
        let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 4);
        for index in 0..workers {
            let receiver = Arc::clone(&receiver);
            std::thread::Builder::new().name(format!("better-install-{index}")).spawn(move || {
                loop {
                    // Hold the receiver mutex only while receiving. Never retain
                    // it during install execution or while publishing a result.
                    let job = {
                        let Ok(receiver) = receiver.lock() else { break; };
                        match receiver.recv() { Ok(job) => job, Err(_) => break }
                    };
                    let queue_micros = job.accepted.elapsed().as_micros().min(u64::MAX as u128) as u64;
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_install(job.options)))
                        .unwrap_or_else(|_| Err(InstallError::new("Resident install execution panicked")))
                        .and_then(|report| {
                        let mut value: serde_json::Value = serde_json::from_str(&report).map_err(|error| InstallError::new(format!("Invalid canonical install report: {error}")))?;
                        value["resident"] = serde_json::json!({
                            "queueCapacity": QUEUE_CAPACITY,
                            "coordinatorWorkers": workers,
                            "queueWaitMicros": queue_micros,
                            "readyMicros": job.accepted.elapsed().as_micros().min(u64::MAX as u128) as u64,
                        });
                        Ok(value.to_string() + "\n")
                    });
                    (job.complete)(result);
                }
            }).map_err(|e| format!("Cannot start resident install coordinator: {e}"))?;
        }
        Ok(sender)
    });
    let sender = match sender.as_ref() {
        Ok(sender) => sender,
        Err(reason) => return Err((InstallError::new(reason.clone()), job)),
    };
    sender.try_send(job).map_err(|error| match error {
        mpsc::TrySendError::Full(job) => (
            InstallError::new(
                "Resident install queue is full; retry after an outstanding install completes",
            ),
            job,
        ),
        mpsc::TrySendError::Disconnected(job) => (
            InstallError::new("Resident install coordinator stopped"),
            job,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resident_resource_requests_are_bounded_without_expanding_smaller_limits() {
        let root = tempfile::tempdir().unwrap();
        for (requested_network, requested_extract, expected_network, expected_extract) in
            [(256, 256, 8, 4), (2, 1, 2, 1), (1, 3, 1, 3)]
        {
            let options = options_from_json(&serde_json::json!({"projectRoot":root.path(),"jobs":requested_network,"extractJobs":requested_extract}).to_string()).unwrap();
            assert_eq!(options.jobs, expected_network);
            assert_eq!(options.extraction_jobs, Some(expected_extract));
        }
        assert!(options_from_json(
            &serde_json::json!({"projectRoot":root.path(),"jobs":257}).to_string()
        )
        .is_err());
    }
    #[test]
    fn direct_admission_validates_before_capping_and_completes_failure() {
        let root = tempfile::tempdir().unwrap();
        let mut options =
            options_from_json(&serde_json::json!({"projectRoot":root.path()}).to_string()).unwrap();
        options.jobs = 256;
        options.extraction_jobs = Some(256);
        bound_resident_resources(&mut options).unwrap();
        assert_eq!((options.jobs, options.extraction_jobs), (8, Some(4)));
        options.jobs = 257;
        let (sender, receiver) = mpsc::sync_channel(1);
        submit_with_callback(options, move |result| {
            sender.send(result.is_err()).unwrap();
        });
        assert!(receiver.try_recv().unwrap());
    }
    #[test]
    fn resident_options_disable_progress_rendering() {
        let root = tempfile::tempdir().unwrap();
        let options =
            options_from_json(&serde_json::json!({"projectRoot":root.path()}).to_string()).unwrap();
        assert!(!options.progress_enabled);
        assert!(!options.json_progress);
    }
    #[test]
    fn rejects_unsupported_and_unknown_options_before_admission() {
        for json in [
            r#"{"projectRoot":"/tmp/project","sandbox":true}"#,
            r#"{"projectRoot":"/tmp/project","verifyProvenance":true}"#,
            r#"{"projectRoot":"/tmp/project","requireProvenance":true}"#,
            r#"{"projectRoot":"/tmp/project","skipVerification":true}"#,
            r#"{"projectRoot":"relative"}"#,
            r#"{"projectRoot":"/tmp/project","jobs":0}"#,
        ] {
            assert!(options_from_json(json).is_err(), "{json}");
        }
    }
}
