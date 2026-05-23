import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runSelfHealNapi, runHealProjectNapi } from "../lib/core.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs/promises";

/**
 * `better heal` — automatically detect and fix common project issues
 *
 * Detects:
 * - Missing lockfile / node_modules
 * - Deprecated packages
 * - Missing .env from .env.example
 * - Node.js version mismatches
 * - Out-of-sync lock and package.json
 */
export async function cmdHeal(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better heal [options]

Automatically detect and fix common project dependency issues.

Options:
  --dry-run      Show what would be fixed without making changes
  --json         Machine-readable output
  --project-root PATH Override project root
  -h, --help     Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "dry-run": { type: "boolean", default: false },
      "project-root": { type: "string" },
    },
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;
  const useJson = values.json || runtime.json === true;

  // NAPI fast path: try richer healProject first, then SelfHealingEngine
  const healResult = runHealProjectNapi(projectRoot, values["dry-run"] === true);
  const napiResult = healResult?.ok
    ? { ok: true, actions: (healResult.data?.actions ?? []).map(a => ({
        issue: a.vulnerability,
        action: `${typeof a.action_type === "object" ? Object.values(a.action_type)[0]?.from ? `upgrade ${a.package} → ${Object.values(a.action_type)[0].to}` : a.action_type : a.action_type}`,
        applied: typeof a.status === "string" ? a.status === "Fixed" || a.status === "PrCreated" : false,
        details: typeof a.status === "object" ? Object.values(a.status)[0] : undefined,
      })) }
    : runSelfHealNapi(projectRoot, values["dry-run"] === true);
  let actions = [];

  if (napiResult?.ok && Array.isArray(napiResult.actions)) {
    actions = napiResult.actions;
    // Apply non-dry-run actions that weren't auto-applied by Rust (e.g. install)
    if (!values["dry-run"]) {
      for (const action of actions) {
        if (!action.applied && action.action === "better install --frozen") {
          const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
          spawnSync(process.execPath, [cliPath, "install", "--frozen", "--project-root", projectRoot], { stdio: "inherit" });
          action.applied = true;
        }
      }
    }
  } else {
    // JS fallback
    try {
      await fs.access(path.join(projectRoot, "node_modules"));
    } catch {
      if (await fileExists(path.join(projectRoot, "package-lock.json"))) {
        actions.push({ issue: "node_modules missing", action: "better install --frozen", applied: false });
        if (!values["dry-run"]) {
          const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
          spawnSync(process.execPath, [cliPath, "install", "--frozen", "--project-root", projectRoot], { stdio: "inherit" });
          actions[actions.length - 1].applied = true;
        }
      }
    }

    const hasEnvExample = await fileExists(path.join(projectRoot, ".env.example"));
    const hasEnv = await fileExists(path.join(projectRoot, ".env"));
    if (hasEnvExample && !hasEnv) {
      actions.push({ issue: ".env missing", action: "cp .env.example .env", applied: false });
      if (!values["dry-run"]) {
        await fs.copyFile(path.join(projectRoot, ".env.example"), path.join(projectRoot, ".env"));
        actions[actions.length - 1].applied = true;
      }
    }
  }

  const result = {
    ok: true,
    kind: "better.heal",
    actions,
    healed: actions.filter(a => a.applied).length,
    pending: actions.filter(a => !a.applied).length,
  };

  if (useJson) {
    printJson(result);
  } else {
    if (actions.length === 0) {
      printText("Project is healthy — nothing to heal.");
    } else {
      for (const a of actions) {
        const icon = a.applied ? "[healed]" : values["dry-run"] ? "[would fix]" : "[pending]";
        printText(`${icon} ${a.issue}: ${a.action}`);
      }
    }
  }
}

async function fileExists(p) {
  return fs.access(p).then(() => true).catch(() => false);
}
