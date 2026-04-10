/**
 * better discover — discover OSP service providers
 *
 * Usage:
 *   better discover database              Search for database providers
 *   better discover supabase.com          Inspect a specific provider's offerings
 *   better discover --category storage    Filter by category
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const HELP = `better discover — find OSP service providers

Usage:
  better discover <query>                  Search by keyword or category
  better discover <domain>                 Inspect a specific provider
  better discover --category <type>        Filter by service category

Arguments:
  query   Keyword (e.g. "database", "redis", "auth") or provider domain

Options:
  --category TYPE  Filter by: database|hosting|auth|analytics|storage|compute|messaging|search|ai|email
  --free           Show only free-tier offerings
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better discover database
  better discover supabase.com
  better discover --category auth
  better discover redis --free
`;

export async function cmdDiscover(argv) {
  const runtime = getRuntimeConfig();
  if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      category: { type: "string" },
      free:     { type: "boolean", default: false },
      json:     { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const query = positionals[0];

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.osp.discover", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["discover"];
  if (query) coreArgs.push(query);
  if (values.category) coreArgs.push("--category", values.category);
  if (values.free)     coreArgs.push("--free");
  if (values.json)     coreArgs.push("--json");

  if (!values.json) printText(`Searching OSP registry for ${query ?? values.category ?? "all providers"}...`);

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
