/**
 * better services — manage provisioned OSP services
 *
 * Usage:
 *   better services list                        List all provisioned services
 *   better services status supabase/postgres    Live status for a service
 *   better services status --all                Check all services
 *   better services credentials supabase/postgres  Show masked credentials
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const HELP = `better services — manage provisioned OSP services

Usage:
  better services list                             List all provisioned services
  better services list --json                      Machine-readable list
  better services status <provider/offering>       Live status for a service
  better services status --all                     Check all services
  better services credentials <provider/offering>  Show masked credentials

Options:
  --all      Apply to all provisioned services (for status)
  --json     Machine-readable output
  -h, --help Show this help

Examples:
  better services list
  better services status supabase.com/postgres
  better services status --all
  better services credentials upstash.com/redis
`;

export async function cmdServices(argv) {
  const runtime = getRuntimeConfig();
  if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  if (!["list", "status", "credentials"].includes(sub)) {
    printText(`Unknown services subcommand '${sub}'. Run 'better services --help' for usage.`);
    process.exitCode = 1;
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      all:  { type: "boolean", default: false },
      json: { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.osp.services", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["services", sub];
  if (positionals[0]) coreArgs.push(positionals[0]);
  if (values.all)  coreArgs.push("--all");
  if (values.json) coreArgs.push("--json");

  const result = spawnSync(corePath, coreArgs, {
    stdio: values.json ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });

  if (values.json && result.stdout) {
    try {
      printJson(JSON.parse(result.stdout.trim()));
    } catch {
      printText(result.stdout.trim());
    }
  }
  process.exitCode = result.status ?? 0;
}
