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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_timing_empty_returns_zeros() {
        let t = compute_timing(vec![]);
        assert_eq!(t.median_ms, 0);
        assert_eq!(t.min_ms, 0);
        assert_eq!(t.max_ms, 0);
        assert_eq!(t.mean_ms, 0);
    }

    #[test]
    fn compute_timing_single_value() {
        let t = compute_timing(vec![42]);
        assert_eq!(t.min_ms, 42);
        assert_eq!(t.max_ms, 42);
        assert_eq!(t.mean_ms, 42);
        assert_eq!(t.median_ms, 42);
    }

    #[test]
    fn compute_timing_multiple_values() {
        let t = compute_timing(vec![10, 30, 20]);
        assert_eq!(t.min_ms, 10);
        assert_eq!(t.max_ms, 30);
        assert_eq!(t.mean_ms, 20);
        assert_eq!(t.median_ms, 20); // sorted: [10, 20, 30] → median at index 1
    }

    #[test]
    fn run_benchmark_no_pms_returns_empty_results() {
        let tmp = std::env::temp_dir().join("bench-test-empty");
        std::fs::create_dir_all(&tmp).unwrap();
        let report = run_benchmark(&tmp, 1, &[]).unwrap();
        assert!(report.results.is_empty());
        assert!(!report.platform.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn run_benchmark_unavailable_pm_skipped() {
        let tmp = std::env::temp_dir().join("bench-test-skip");
        std::fs::create_dir_all(&tmp).unwrap();
        let pms = vec!["definitely-nonexistent-pm-xyz".to_string()];
        let report = run_benchmark(&tmp, 1, &pms).unwrap();
        assert!(report.results.is_empty()); // skipped because not found
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn compute_timing_even_number_of_values() {
        // sorted: [1, 3, 5, 9] → median at index 2 = 5
        let t = compute_timing(vec![9, 1, 5, 3]);
        assert_eq!(t.min_ms, 1);
        assert_eq!(t.max_ms, 9);
        assert_eq!(t.mean_ms, (1 + 3 + 5 + 9) / 4);
    }

    #[test]
    fn run_benchmark_report_has_platform() {
        let tmp = std::env::temp_dir().join("bench-test-platform");
        std::fs::create_dir_all(&tmp).unwrap();
        let report = run_benchmark(&tmp, 1, &[]).unwrap();
        assert!(!report.platform.is_empty());
        assert!(!report.arch.is_empty());
        assert!(report.cpus >= 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn compute_timing_sorts_input() {
        // Input is unsorted; min should still be 2, max 100
        let t = compute_timing(vec![50, 100, 2, 20]);
        assert_eq!(t.min_ms, 2);
        assert_eq!(t.max_ms, 100);
    }
}
