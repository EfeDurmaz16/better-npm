use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::types::{BenchmarkTiming, BenchmarkResult, BenchmarkReport};

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

