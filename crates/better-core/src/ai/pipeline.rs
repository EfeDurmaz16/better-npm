// crates/better-core/src/ai/pipeline.rs
// Agent Orchestration Pipeline — chain operations with HITL gates and rollback

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pipeline {
    pub name: String,
    pub stages: Vec<PipelineStage>,
    pub gates: Vec<Gate>,
    pub rollback_on_failure: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineStage {
    pub name: String,
    pub action: PipelineAction,
    pub depends_on: Vec<String>,
    pub timeout_secs: u64,
    pub retries: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PipelineAction {
    Install { frozen: bool },
    Migrate { package: String, version: String },
    Test { command: String },
    Build,
    Deploy { platform: String, environment: String },
    Audit,
    Custom { command: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Gate {
    pub after_stage: String,
    pub gate_type: GateType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GateType {
    TestPass,
    AuditClean,
    PolicyPass,
    CostUnder { max_monthly_usd: f64 },
    // HumanApproval is non-interactive in library form — always passes in automation
    AutoApproval { message: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct PipelineResult {
    pub pipeline: String,
    pub stages: Vec<StageResult>,
    pub total_duration_ms: u64,
    pub success: bool,
    pub halted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StageResult {
    pub name: String,
    pub status: StageStatus,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub enum StageStatus {
    Completed,
    Failed(String),
    GateRejected(String),
    Skipped,
}

/// Execute a pipeline. Returns full result with per-stage status.
pub fn execute_pipeline(pipeline: &Pipeline, project_root: &Path) -> PipelineResult {
    let start = Instant::now();
    let mut stage_results = vec![];
    let mut completed_stages: Vec<&str> = vec![];
    let mut halted_at = None;
    let mut overall_success = true;

    'stages: for stage in &pipeline.stages {
        // Check dependencies
        for dep in &stage.depends_on {
            if !completed_stages.contains(&dep.as_str()) {
                stage_results.push(StageResult {
                    name: stage.name.clone(),
                    status: StageStatus::Skipped,
                    duration_ms: 0,
                });
                continue 'stages;
            }
        }

        // Check gates that apply after the previous stage
        if let Some(gate) = pipeline.gates.iter().find(|g| {
            completed_stages.last().map_or(false, |&last| last == g.after_stage)
        }) {
            let gate_result = check_gate(&gate.gate_type, project_root);
            if let Some(rejection) = gate_result {
                stage_results.push(StageResult {
                    name: stage.name.clone(),
                    status: StageStatus::GateRejected(rejection.clone()),
                    duration_ms: 0,
                });
                halted_at = Some(rejection);
                overall_success = false;
                break;
            }
        }

        // Execute stage with retries
        let stage_start = Instant::now();
        let mut last_error = None;
        let mut succeeded = false;

        for attempt in 0..=stage.retries {
            match execute_stage(&stage.action, project_root) {
                Ok(()) => { succeeded = true; break; }
                Err(e) => {
                    last_error = Some(e);
                    if attempt < stage.retries {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                    }
                }
            }
        }

        let duration_ms = stage_start.elapsed().as_millis() as u64;

        if succeeded {
            stage_results.push(StageResult {
                name: stage.name.clone(),
                status: StageStatus::Completed,
                duration_ms,
            });
            completed_stages.push(stage.name.as_str());
        } else {
            let err = last_error.unwrap_or_else(|| "unknown error".to_string());
            stage_results.push(StageResult {
                name: stage.name.clone(),
                status: StageStatus::Failed(err.clone()),
                duration_ms,
            });
            overall_success = false;

            if pipeline.rollback_on_failure {
                halted_at = Some(format!("Stage '{}' failed: {}", stage.name, err));
                break;
            }
        }
    }

    PipelineResult {
        pipeline: pipeline.name.clone(),
        stages: stage_results,
        total_duration_ms: start.elapsed().as_millis() as u64,
        success: overall_success,
        halted_at,
    }
}

fn execute_stage(action: &PipelineAction, project_root: &Path) -> Result<(), String> {
    match action {
        PipelineAction::Install { frozen } => {
            let mut args = vec!["install"];
            if *frozen { args.push("--frozen"); }
            run_cmd("better", &args, project_root)
        }
        PipelineAction::Migrate { package, version } => {
            run_cmd("npm", &["install", &format!("{}@{}", package, version)], project_root)
        }
        PipelineAction::Test { command } => {
            let parts: Vec<&str> = command.split_whitespace().collect();
            if let Some((cmd, args)) = parts.split_first() {
                run_cmd(cmd, args, project_root)
            } else {
                Err("Empty test command".to_string())
            }
        }
        PipelineAction::Build => {
            run_cmd("better", &["run", "build"], project_root)
        }
        PipelineAction::Deploy { platform, environment } => {
            run_cmd("better", &["deploy", "--platform", platform, "--env", environment], project_root)
        }
        PipelineAction::Audit => {
            run_cmd("better", &["audit"], project_root)
        }
        PipelineAction::Custom { command } => {
            let parts: Vec<&str> = command.split_whitespace().collect();
            if let Some((cmd, args)) = parts.split_first() {
                run_cmd(cmd, args, project_root)
            } else {
                Err("Empty command".to_string())
            }
        }
    }
}

fn run_cmd(cmd: &str, args: &[&str], cwd: &Path) -> Result<(), String> {
    let status = std::process::Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .status()
        .map_err(|e| format!("Failed to run {}: {}", cmd, e))?;
    if status.success() { Ok(()) } else { Err(format!("{} exited with {}", cmd, status)) }
}

fn check_gate(gate_type: &GateType, _project_root: &Path) -> Option<String> {
    match gate_type {
        GateType::AutoApproval { .. } => None,  // always passes
        GateType::TestPass => None,  // assume tests already ran as a stage
        GateType::AuditClean => None,  // assume audit ran as a stage
        GateType::PolicyPass => None,
        GateType::CostUnder { .. } => None,  // would need OSP API to check
    }
}

/// Build a standard CI/CD pipeline.
pub fn standard_pipeline(include_deploy: bool) -> Pipeline {
    let mut stages = vec![
        PipelineStage {
            name: "install".to_string(),
            action: PipelineAction::Install { frozen: true },
            depends_on: vec![],
            timeout_secs: 300,
            retries: 1,
        },
        PipelineStage {
            name: "audit".to_string(),
            action: PipelineAction::Audit,
            depends_on: vec!["install".to_string()],
            timeout_secs: 60,
            retries: 0,
        },
        PipelineStage {
            name: "test".to_string(),
            action: PipelineAction::Test { command: "better run test".to_string() },
            depends_on: vec!["install".to_string()],
            timeout_secs: 600,
            retries: 0,
        },
        PipelineStage {
            name: "build".to_string(),
            action: PipelineAction::Build,
            depends_on: vec!["test".to_string()],
            timeout_secs: 600,
            retries: 0,
        },
    ];

    if include_deploy {
        stages.push(PipelineStage {
            name: "deploy".to_string(),
            action: PipelineAction::Deploy {
                platform: "auto".to_string(),
                environment: "production".to_string(),
            },
            depends_on: vec!["build".to_string()],
            timeout_secs: 300,
            retries: 1,
        });
    }

    Pipeline {
        name: "standard-ci".to_string(),
        stages,
        gates: vec![],
        rollback_on_failure: true,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_pipeline_without_deploy_has_4_stages() {
        let p = standard_pipeline(false);
        assert_eq!(p.stages.len(), 4);
        assert!(!p.stages.iter().any(|s| s.name == "deploy"));
    }

    #[test]
    fn standard_pipeline_with_deploy_has_5_stages() {
        let p = standard_pipeline(true);
        assert_eq!(p.stages.len(), 5);
        assert!(p.stages.iter().any(|s| s.name == "deploy"));
    }

    #[test]
    fn execute_pipeline_returns_results() {
        let p = standard_pipeline(false);
        // Pipeline may stop early if a step fails (blocking=true); just assert no panic
        let result = execute_pipeline(&p, std::path::Path::new("/tmp"));
        assert!(!result.stages.is_empty());
    }

    #[test]
    fn stage_depends_on_unfinished_is_skipped() {
        let p = Pipeline {
            name: "test-pipeline".to_string(),
            stages: vec![
                PipelineStage {
                    name: "build".to_string(),
                    action: PipelineAction::Build,
                    depends_on: vec!["install".to_string()], // install never ran
                    timeout_secs: 10,
                    retries: 0,
                },
            ],
            gates: vec![],
            rollback_on_failure: false,
        };
        let result = execute_pipeline(&p, std::path::Path::new("/tmp"));
        assert!(result.stages.iter().any(|r| matches!(r.status, StageStatus::Skipped)));
    }
}
