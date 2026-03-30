import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
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

  // Forward to Rust binary if available
  const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin");
  let binPath = null;
  for (const name of ["better-core", "better"]) {
    try { await fs.access(join(binDir, name)); binPath = join(binDir, name); break; } catch {}
  }

  if (binPath) {
    const args = ["heal", "--project-root", projectRoot];
    if (values["dry-run"]) args.push("--dry-run");
    if (useJson) args.push("--json");
    const result = spawnSync(binPath, args, { encoding: "utf8" });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status) process.exitCode = result.status;
    return;
  }

  // JS fallback healing
  const actions = [];

  // Check: missing node_modules
  try {
    await fs.access(path.join(projectRoot, "node_modules"));
  } catch {
    if (await fileExists(path.join(projectRoot, "package-lock.json"))) {
      actions.push({ issue: "node_modules missing", action: "better install --frozen", applied: false });
      if (!values["dry-run"]) {
        spawnSync("node", [join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js"), "install", "--frozen", "--project-root", projectRoot], { stdio: "inherit" });
        actions[actions.length - 1].applied = true;
      }
    }
  }

  // Check: .env.example but no .env
  const hasEnvExample = await fileExists(path.join(projectRoot, ".env.example"));
  const hasEnv = await fileExists(path.join(projectRoot, ".env"));
  if (hasEnvExample && !hasEnv) {
    actions.push({ issue: ".env missing", action: "cp .env.example .env", applied: false });
    if (!values["dry-run"]) {
      await fs.copyFile(path.join(projectRoot, ".env.example"), path.join(projectRoot, ".env"));
      actions[actions.length - 1].applied = true;
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
