/**
 * better env generate — resolve .env.osp template to .env
 *
 * Usage:
 *   better env generate                   Resolve .env.osp -> .env
 *   better env generate --template FILE   Custom template path
 *   better env generate --output FILE     Custom output path (default: .env)
 *   better env generate --dry-run         Print resolved values without writing
 *   better env generate --json            Output as JSON instead of .env format
 */

import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const HELP = `better env generate — resolve .env.osp to .env

Usage:
  better env generate                       Resolve .env.osp → .env
  better env generate --template FILE       Use custom template file
  better env generate --output FILE         Write to custom output (default: .env)
  better env generate --dry-run             Print resolved values without writing
  better env generate --json                Output as JSON

Options:
  --template FILE    Path to .env.osp template (default: .env.osp in project root)
  --output FILE      Output path (default: .env in project root)
  --dry-run          Print without writing
  --project-root     Override project root detection
  --json             Machine-readable output
  -h, --help         Show this help

How it works:
  .env.osp is a template where osp:// URIs are replaced by credentials
  from your provisioned services vault.

  DATABASE_URL=osp://supabase.com/postgres/connection_string
  REDIS_URL=osp://upstash.com/redis/url
  PORT=3000   (static values pass through unchanged)
`;

export async function cmdEnvGenerate(argv) {
  const runtime = getRuntimeConfig();
  if (argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      template:       { type: "string" },
      output:         { type: "string" },
      "dry-run":      { type: "boolean", default: false },
      "project-root": { type: "string" },
      json:           { type: "boolean", default: runtime.json === true },
    },
    strict: false,
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.env.generate", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["env", "generate", "--project-root", projectRoot];
  if (values.template)  coreArgs.push("--template", values.template);
  if (values.output)    coreArgs.push("--output", values.output);
  if (values["dry-run"]) coreArgs.push("--dry-run");
  if (values.json)      coreArgs.push("--json");

  const result = spawnSync(corePath, coreArgs, {
    stdio: values.json ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });

  if (values.json && result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      printJson(parsed);
    } catch {
      printText(result.stdout.trim());
    }
  }
  process.exitCode = result.status ?? 0;
}
