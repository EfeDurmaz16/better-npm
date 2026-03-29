import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { runCommand } from "../lib/spawn.js";

export async function cmdSuggest(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better suggest [--json] [--project-root <path>]

Analyze source code imports and cross-reference with package manifests.
Reports missing dependencies (imported but not declared) and unused
dependencies (declared but never imported).

Supports: JS/TS (package.json) and Python (pyproject.toml, requirements.txt)
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const projectRoot = values["project-root"] || process.cwd();
  const jsonOutput = values.json;

  const corePath = await findBetterCore();
  if (!corePath) {
    const err = { ok: false, kind: "better.suggest", reason: "better-core binary not found" };
    if (jsonOutput) printJson(err);
    else printText("error: better-core binary not found");
    process.exitCode = 1;
    return;
  }

  const args = ["suggest", "--project-root", projectRoot];
  if (jsonOutput) args.push("--json");

  const res = await runCommand(corePath, args, {
    cwd: projectRoot,
    passthroughStdio: !jsonOutput,
    captureLimitBytes: 10 * 1024 * 1024,
    timeoutMs: 30_000,
  });

  if (jsonOutput && res.stdout) {
    try {
      const parsed = JSON.parse(res.stdout);
      printJson(parsed);
    } catch {
      printText(res.stdout);
    }
  }

  if (res.exitCode !== 0) {
    process.exitCode = res.exitCode;
  }
}
