import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { runPlanPipelineNapi } from "../lib/core.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { join } from "node:path";

/**
 * `better pipeline` — run an agent orchestration pipeline
 *
 * Usage:
 *   better pipeline run [--config pipeline.json] [--dry-run]
 *   better pipeline init           # create a sample pipeline.json
 *   better pipeline validate       # validate pipeline.json
 *   better pipeline list           # list available pipelines
 */
export async function cmdPipeline(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    printText(`Usage:
  better pipeline <subcommand> [options]

Agent orchestration pipeline — chain operations with gates and rollback.

Subcommands:
  run [--config FILE]    Run a pipeline from config file (default: pipeline.json)
  init                   Create a sample pipeline.json in current directory
  validate               Validate pipeline.json configuration
  list                   List built-in pipeline templates

Options:
  --dry-run        Show what would happen without executing
  --json           Machine-readable output
  -h, --help       Show this help

Pipeline config format (pipeline.json):
  {
    "name": "deploy",
    "rollback_on_failure": true,
    "stages": [
      { "name": "install", "action": { "type": "Install", "frozen": true }, "depends_on": [] },
      { "name": "test",    "action": { "type": "Test", "command": "npm test" }, "depends_on": ["install"] },
      { "name": "build",   "action": { "type": "Build" }, "depends_on": ["test"] },
      { "name": "deploy",  "action": { "type": "Deploy", "platform": "vercel", "environment": "production" }, "depends_on": ["build"] }
    ],
    "gates": []
  }
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      config: { type: "string", default: "pipeline.json" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const sub = positionals[0] || "run";
  const useJson = values.json;
  const cwd = process.cwd();

  switch (sub) {
    case "init": {
      const sample = {
        name: "ci-cd",
        rollback_on_failure: true,
        stages: [
          { name: "install", action: { type: "Install", frozen: false }, depends_on: [], timeout_secs: 300, retries: 1 },
          { name: "audit", action: { type: "Audit" }, depends_on: ["install"], timeout_secs: 60, retries: 0 },
          { name: "test", action: { type: "Test", command: "npm test" }, depends_on: ["install"], timeout_secs: 600, retries: 0 },
          { name: "build", action: { type: "Build" }, depends_on: ["test"], timeout_secs: 600, retries: 0 },
        ],
        gates: [],
      };
      const outPath = join(cwd, "pipeline.json");
      await fs.writeFile(outPath, JSON.stringify(sample, null, 2));
      if (useJson) {
        printJson({ ok: true, kind: "better.pipeline.init", path: outPath });
      } else {
        printText(`Created pipeline.json — run 'better pipeline run' to execute.`);
      }
      break;
    }

    case "validate": {
      const configPath = join(cwd, values.config);
      try {
        const content = await fs.readFile(configPath, "utf8");
        const config = JSON.parse(content);

        // NAPI fast path: Rust validates and plans the pipeline graph
        const projectRoot = values["project-root"] ? path.resolve(values["project-root"]) : cwd;
        const napiPlan = runPlanPipelineNapi(content, projectRoot);
        if (napiPlan?.ok) {
          if (useJson) {
            printJson({ ok: true, kind: "better.pipeline.validate", pipeline: napiPlan.pipeline, stages: napiPlan.stages?.length ?? 0, plan: napiPlan });
          } else {
            printText(`Pipeline '${napiPlan.pipeline}' is valid (${napiPlan.stages?.length ?? 0} stages, ${napiPlan.gates ?? 0} gates).`);
            if (napiPlan.stages?.length > 0) {
              printText("Stages:");
              for (const s of napiPlan.stages) {
                const deps = s.depends_on?.length > 0 ? ` (after: ${s.depends_on.join(", ")})` : "";
                printText(`  ${s.name}${deps}`);
              }
            }
          }
          break;
        }

        // JS fallback validation
        const errors = [];
        if (!config.name) errors.push("Missing 'name' field");
        if (!Array.isArray(config.stages)) errors.push("Missing 'stages' array");
        else {
          for (const stage of config.stages) {
            if (!stage.name) errors.push(`Stage missing 'name'`);
            if (!stage.action) errors.push(`Stage '${stage.name}' missing 'action'`);
          }
        }
        if (errors.length > 0) {
          if (useJson) { printJson({ ok: false, errors }); } else { printText(`Errors:\n${errors.map(e => `  - ${e}`).join("\n")}`); }
          process.exitCode = 1;
        } else {
          if (useJson) { printJson({ ok: true, kind: "better.pipeline.validate", stages: config.stages.length }); }
          else { printText(`Pipeline '${config.name}' is valid (${config.stages.length} stages).`); }
        }
      } catch (err) {
        if (useJson) { printJson({ ok: false, error: err.message }); } else { printText(`Error: ${err.message}`); }
        process.exitCode = 1;
      }
      break;
    }

    case "list": {
      const templates = [
        { name: "ci", description: "Install → Audit → Test → Build" },
        { name: "ci-deploy", description: "Install → Audit → Test → Build → Deploy" },
        { name: "upgrade", description: "Update deps → Audit → Test → Commit" },
      ];
      if (useJson) {
        printJson({ ok: true, kind: "better.pipeline.list", templates });
      } else {
        printText("Available pipeline templates:");
        for (const t of templates) {
          printText(`  ${t.name.padEnd(15)} ${t.description}`);
        }
        printText("\nUse: better pipeline init --template <name>");
      }
      break;
    }

    case "run":
    default: {
      const configPath = join(cwd, values.config);
      let config;
      try {
        const content = await fs.readFile(configPath, "utf8");
        config = JSON.parse(content);
      } catch {
        // Use default standard pipeline
        config = {
          name: "standard-ci",
          rollback_on_failure: true,
          stages: [
            { name: "install", action: { type: "Install", frozen: false }, depends_on: [] },
            { name: "test", action: { type: "Test", command: "npm test" }, depends_on: ["install"] },
            { name: "build", action: { type: "Build" }, depends_on: ["test"] },
          ],
          gates: [],
        };
      }

      if (values["dry-run"]) {
        if (useJson) {
          printJson({ ok: true, kind: "better.pipeline.dry-run", pipeline: config.name, stages: config.stages.map(s => s.name) });
        } else {
          printText(`Pipeline: ${config.name}`);
          printText(`Stages:\n${config.stages.map((s, i) => `  ${i+1}. ${s.name}`).join("\n")}`);
          printText("(dry-run: no stages executed)");
        }
        return;
      }

      // Execute pipeline stages sequentially
      const results = [];
      let success = true;
      const completed = new Set();

      for (const stage of config.stages) {
        // Check deps
        const depsOk = stage.depends_on.every(d => completed.has(d));
        if (!depsOk) {
          results.push({ name: stage.name, status: "skipped" });
          continue;
        }

        if (!useJson) printText(`  [→] ${stage.name}...`);

        const stageResult = await executeStage(stage.action, cwd, values["dry-run"]);
        if (stageResult.ok) {
          completed.add(stage.name);
          results.push({ name: stage.name, status: "completed" });
          if (!useJson) printText(`  [✓] ${stage.name}`);
        } else {
          results.push({ name: stage.name, status: "failed", error: stageResult.error });
          if (!useJson) printText(`  [✗] ${stage.name}: ${stageResult.error}`);
          success = false;
          if (config.rollback_on_failure) break;
        }
      }

      const out = { ok: success, kind: "better.pipeline.result", pipeline: config.name, stages: results };
      if (useJson) { printJson(out); }
      else {
        printText(`\nPipeline ${success ? "succeeded" : "FAILED"}: ${results.filter(r => r.status === "completed").length}/${config.stages.length} stages completed`);
      }
      if (!success) process.exitCode = 1;
    }
  }
}

async function executeStage(action, cwd, dryRun) {
  if (dryRun) return { ok: true };

  let cmd, args;
  switch (action.type) {
    case "Install":
      cmd = "better"; args = ["install"];
      if (action.frozen) args.push("--frozen");
      break;
    case "Test":
      const parts = (action.command || "npm test").split(" ");
      cmd = parts[0]; args = parts.slice(1);
      break;
    case "Build":
      cmd = "better"; args = ["run", "build"];
      break;
    case "Deploy":
      cmd = "better"; args = ["deploy", "--platform", action.platform || "auto", "--env", action.environment || "production"];
      break;
    case "Audit":
      cmd = "better"; args = ["audit"];
      break;
    case "Custom":
      const customParts = (action.command || "").split(" ");
      cmd = customParts[0]; args = customParts.slice(1);
      break;
    default:
      return { ok: false, error: `Unknown action type: ${action.type}` };
  }

  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: `Exited with code ${result.status}` };
  return { ok: true };
}
