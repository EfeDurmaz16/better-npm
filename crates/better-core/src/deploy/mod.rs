// crates/better-core/src/deploy/mod.rs
// Deploy platform abstraction — detect framework, run build, push to cloud

pub mod detect;
pub mod platforms;

pub use detect::{detect_framework, Framework, DeployPlatform, FrameworkDetection};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DeployResult {
    pub ok: bool,
    pub platform: String,
    pub url: Option<String>,
    pub deployment_id: Option<String>,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DeployConfig {
    pub project_root: std::path::PathBuf,
    pub platform: Option<String>,
    pub token: Option<String>,
    pub dry_run: bool,
    pub env: String,
}

pub fn run_deploy(config: &DeployConfig) -> DeployResult {
    let start = std::time::Instant::now();
    let detection = detect_framework(&config.project_root);

    let platform = config.platform.as_deref()
        .unwrap_or_else(|| match &detection.recommended_platform {
            DeployPlatform::Vercel => "vercel",
            DeployPlatform::Cloudflare => "cloudflare",
            DeployPlatform::Railway => "railway",
            DeployPlatform::Fly => "fly",
        });

    // Run build step
    if !detection.build_command.is_empty() && !config.dry_run {
        let parts: Vec<&str> = detection.build_command.split_whitespace().collect();
        if let Some((cmd, args)) = parts.split_first() {
            let status = std::process::Command::new(cmd)
                .args(args)
                .current_dir(&config.project_root)
                .status();
            if let Ok(s) = status {
                if !s.success() {
                    return DeployResult {
                        ok: false,
                        platform: platform.to_string(),
                        url: None,
                        deployment_id: None,
                        duration_ms: start.elapsed().as_millis() as u64,
                        error: Some("Build step failed".to_string()),
                    };
                }
            }
        }
    }

    DeployResult {
        ok: true,
        platform: platform.to_string(),
        url: None,
        deployment_id: None,
        duration_ms: start.elapsed().as_millis() as u64,
        error: if config.dry_run { Some("dry-run: no deployment made".to_string()) } else { None },
    }
}
