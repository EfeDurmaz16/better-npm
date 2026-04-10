/**
 * better earnings — view revenue from monetized packages
 *
 * Usage:
 *   better earnings                  Last 30 days summary
 *   better earnings --breakdown      Per-package, per-day breakdown
 *   better earnings --period 90      Last 90 days
 *   better earnings --json           JSON output
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const HELP = `better earnings — view revenue from monetized packages

Usage:
  better earnings                    Summary for last 30 days
  better earnings --breakdown        Per-package, per-day breakdown
  better earnings --period N         Summary for last N days
  better earnings --json             Machine-readable JSON output

Options:
  --breakdown        Include per-package and per-day breakdown
  --period N         Number of days (default: 30)
  --json             Machine-readable output
  -h, --help         Show this help

Requires:
  Sardis authentication (run 'better login --sardis' first)
  Published package(s) with --monetize flag

Examples:
  better earnings
  better earnings --period 90
  better earnings --breakdown --json
`;

export async function cmdEarnings(argv) {
  const runtime = getRuntimeConfig();
  if (argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      breakdown: { type: "boolean", default: false },
      period:    { type: "string",  default: "30" },
      json:      { type: "boolean", default: runtime.json === true },
    },
    strict: false,
  });

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.sardis.earnings", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["earnings", "--period", values.period];
  if (values.breakdown) coreArgs.push("--breakdown");
  if (values.json)      coreArgs.push("--json");

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
