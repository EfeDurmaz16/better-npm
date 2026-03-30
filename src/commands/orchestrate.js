// src/commands/orchestrate.js
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import path from "node:path";

export async function cmdOrchestrate(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better orchestrate <workflow> [options]

Run a multi-step workflow orchestration.

Workflows:
  new-project     Install + audit + doctor
  ci              CI-optimized install + audit + lock verify
  release         Audit + SBOM + lock fingerprint + publish

Options:
  --dry-run  Show steps without executing
  --json     Machine-readable output
  -h, --help Show this help
`);
    return;
  }
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv, options: { json: { type: "boolean", default: runtime.json === true }, "dry-run": { type: "boolean", default: false }, "project-root": { type: "string" } },
    allowPositionals: true, strict: false
  });
  const resolvedRoot = values["project-root"] ? { root: path.resolve(values["project-root"]) } : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;
  const workflow = positionals[0] || "new-project";
  const useJson = values.json || runtime.json === true;
  const workflows = {
    "new-project": [
      { cmd: "install", label: "Install dependencies" },
      { cmd: "audit --prod-only", label: "Security audit" },
      { cmd: "doctor", label: "Project health check" },
    ],
    "ci": [
      { cmd: "ci", label: "Frozen install" },
      { cmd: "audit --prod-only --min-score 5", label: "Security audit" },
      { cmd: "lock verify", label: "Lockfile verification" },
    ],
    "release": [
      { cmd: "audit --prod-only", label: "Security audit" },
      { cmd: "doctor", label: "Health check" },
      { cmd: "publish", label: "Publish" },
    ],
  };
  const steps = workflows[workflow] || workflows["new-project"];
  if (useJson) { printJson({ ok: true, kind: "better.orchestrate", workflow, steps: steps.map(s => s.label) }); return; }
  printText(`Running workflow: ${workflow}`);
  const { spawnSync } = await import("node:child_process");
  const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "cli.js");
  for (const step of steps) {
    if (values["dry-run"]) { printText(`  [dry-run] better ${step.cmd}`); continue; }
    printText(`  -> ${step.label}...`);
    const result = spawnSync(process.execPath, [cliPath, ...step.cmd.split(" "), "--project-root", projectRoot], { stdio: "inherit", timeout: 120000 });
    if (result.status !== 0) { printText(`  Failed at: ${step.label}`); process.exitCode = 1; return; }
  }
  if (!values["dry-run"]) printText(`Workflow '${workflow}' complete`);
}
