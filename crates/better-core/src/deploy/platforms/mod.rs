// crates/better-core/src/deploy/platforms/mod.rs

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PlatformDeployResult {
    pub ok: bool,
    pub platform: String,
    pub url: Option<String>,
    pub deployment_id: Option<String>,
    pub logs: Vec<String>,
}

/// Attempt to deploy using installed platform CLI tool.
pub fn deploy_via_cli(platform: &str, project_root: &std::path::Path, env: &str, dry_run: bool) -> PlatformDeployResult {
    let (cmd, args): (&str, Vec<String>) = match platform {
        "vercel" => {
            let mut a = vec!["deploy".to_string(), "--yes".to_string()];
            if env == "production" { a.push("--prod".to_string()); }
            if dry_run { a.push("--dry-run".to_string()); }
            ("vercel", a)
        }
        "cloudflare" | "wrangler" => {
            let a = if dry_run {
                vec!["deploy".to_string(), "--dry-run".to_string()]
            } else {
                vec!["deploy".to_string()]
            };
            ("wrangler", a)
        }
        "railway" => {
            let a = if dry_run {
                vec!["up".to_string(), "--detach".to_string(), "--dry-run".to_string()]
            } else {
                vec!["up".to_string(), "--detach".to_string()]
            };
            ("railway", a)
        }
        "fly" => {
            let mut a = vec!["deploy".to_string()];
            if dry_run { a.push("--dry-run".to_string()); }
            ("fly", a)
        }
        "netlify" => {
            let mut a = vec!["deploy".to_string()];
            if env == "production" { a.push("--prod".to_string()); }
            ("netlify", a)
        }
        other => {
            return PlatformDeployResult {
                ok: false,
                platform: other.to_string(),
                url: None,
                deployment_id: None,
                logs: vec![format!("Unknown platform: {}", other)],
            };
        }
    };

    let result = std::process::Command::new(cmd)
        .args(&args)
        .current_dir(project_root)
        .output();

    match result {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let mut logs = vec![];
            if !stdout.is_empty() { logs.push(stdout.clone()); }
            if !stderr.is_empty() { logs.push(stderr); }

            // Try to parse URL from output
            let url = stdout.lines()
                .find(|l| l.contains("https://"))
                .and_then(|l| l.split_whitespace().find(|s| s.starts_with("https://")))
                .map(|s| s.to_string());

            PlatformDeployResult {
                ok: out.status.success(),
                platform: platform.to_string(),
                url,
                deployment_id: None,
                logs,
            }
        }
        Err(e) => PlatformDeployResult {
            ok: false,
            platform: platform.to_string(),
            url: None,
            deployment_id: None,
            logs: vec![format!("Failed to run {}: {}", cmd, e)],
        },
    }
}
