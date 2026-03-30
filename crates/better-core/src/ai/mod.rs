// crates/better-core/src/ai/mod.rs

pub mod engine;
pub mod prompts;
pub mod self_healing;
pub mod orchestrator;

pub use engine::{AiEngine, AiProvider, AiRequest, AiPlan, AiStep, ProjectContext, DepSummary, AiTool};
pub use self_healing::{SelfHealingEngine, HealingAction};
pub use orchestrator::{AgentOrchestrator, OrchestrationPlan};
