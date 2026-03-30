// crates/better-core/src/ai/orchestrator.rs
// Agent orchestration — coordinate multiple better commands in sequence

use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OrchestrationStep {
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
    pub blocking: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OrchestrationPlan {
    pub name: String,
    pub steps: Vec<OrchestrationStep>,
    pub estimated_duration_secs: u64,
}

pub struct AgentOrchestrator;

impl AgentOrchestrator {
    /// Generate an orchestration plan for a common workflow.
    pub fn plan_new_project(project_root: &Path) -> OrchestrationPlan {
        OrchestrationPlan {
            name: "new-project-setup".to_string(),
            steps: vec![
                OrchestrationStep {
                    command: "better".to_string(),
                    args: vec!["install".to_string()],
                    description: "Install dependencies".to_string(),
                    blocking: true,
                },
                OrchestrationStep {
                    command: "better".to_string(),
                    args: vec!["audit".to_string(), "--prod-only".to_string()],
                    description: "Run security audit".to_string(),
                    blocking: false,
                },
                OrchestrationStep {
                    command: "better".to_string(),
                    args: vec!["doctor".to_string()],
                    description: "Check project health".to_string(),
                    blocking: false,
                },
            ],
            estimated_duration_secs: 30,
        }
    }

    pub fn plan_ci(project_root: &Path) -> OrchestrationPlan {
        OrchestrationPlan {
            name: "ci-pipeline".to_string(),
            steps: vec![
                OrchestrationStep {
                    command: "better".to_string(),
                    args: vec!["ci".to_string()],
                    description: "Clean install with frozen lockfile".to_string(),
                    blocking: true,
                },
                OrchestrationStep {
                    command: "better".to_string(),
                    args: vec!["audit".to_string(), "--prod-only".to_string(), "--min-score".to_string(), "5".to_string()],
                    description: "Security audit (prod only, min score 5)".to_string(),
                    blocking: true,
                },
                OrchestrationStep {
                    command: "better".to_string(),
                    args: vec!["lock".to_string(), "verify".to_string()],
                    description: "Verify lockfile integrity".to_string(),
                    blocking: true,
                },
            ],
            estimated_duration_secs: 60,
        }
    }

    /// Execute an orchestration plan step by step.
    pub fn execute(plan: &OrchestrationPlan, project_root: &Path, dry_run: bool) -> Vec<StepResult> {
        let mut results = Vec::new();
        for step in &plan.steps {
            let result = if dry_run {
                StepResult {
                    step: step.description.clone(),
                    success: true,
                    output: format!("[dry-run] would run: {} {}", step.command, step.args.join(" ")),
                    duration_ms: 0,
                }
            } else {
                let start = std::time::Instant::now();
                let proc = std::process::Command::new(&step.command)
                    .args(&step.args)
                    .current_dir(project_root)
                    .output();
                let duration_ms = start.elapsed().as_millis() as u64;
                match proc {
                    Ok(out) => StepResult {
                        step: step.description.clone(),
                        success: out.status.success(),
                        output: String::from_utf8_lossy(&out.stdout).trim().to_string(),
                        duration_ms,
                    },
                    Err(e) => StepResult {
                        step: step.description.clone(),
                        success: false,
                        output: e.to_string(),
                        duration_ms,
                    },
                }
            };
            let failed = !result.success && step.blocking;
            results.push(result);
            if failed { break; }
        }
        results
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StepResult {
    pub step: String,
    pub success: bool,
    pub output: String,
    pub duration_ms: u64,
}
