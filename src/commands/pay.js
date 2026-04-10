/**
 * better pay — micropayments to package maintainers via Sardis wallet
 *
 * Usage:
 *   better pay lodash                        Pay lodash maintainer (prompts for amount)
 *   better pay lodash --amount 5USD          Pay $5 to lodash
 *   better pay --all --budget 50USD          Distribute $50 across all deps
 *   better pay lodash --recurring monthly    Set up recurring monthly payment
 *   better pay --json                        Structured output
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const HELP = `better pay — pay package maintainers via Sardis wallet

Usage:
  better pay <package>                        One-time payment to a package maintainer
  better pay <package> --amount AMOUNT        Specify amount (e.g. 5USD, 10USDC)
  better pay --all --budget AMOUNT            Distribute across all dependencies
  better pay --all --budget AMOUNT --strategy STRATEGY
  better pay <package> --recurring INTERVAL --amount AMOUNT

Arguments:
  package    npm package name (e.g. lodash, react)
  AMOUNT     Amount with currency: 5USD, 10USDC, 2.50EUR

Options:
  --amount AMOUNT      Payment amount (e.g. 5USD)
  --all                Pay all dependencies
  --budget AMOUNT      Total budget when using --all
  --strategy STRATEGY  Distribution: equal|weighted|depth (default: weighted)
  --recurring INTERVAL Set up recurring payment: monthly|weekly|yearly
  --org ORG            Pay from organisation budget
  --dry-run            Preview without charging
  --json               Machine-readable output
  -h, --help           Show this help

Examples:
  better pay lodash --amount 5USD
  better pay --all --budget 50USD
  better pay --all --budget 100USD --strategy equal
  better pay react --recurring monthly --amount 2USD
`;

export async function cmdPay(argv) {
  const runtime = getRuntimeConfig();
  if (argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      amount:    { type: "string" },
      all:       { type: "boolean", default: false },
      budget:    { type: "string" },
      strategy:  { type: "string", default: "weighted" },
      recurring: { type: "string" },
      org:       { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json:      { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const pkg = positionals[0];

  if (!pkg && !values.all) {
    printText("error: specify a package name or use --all\n\nUsage: better pay <package> [--amount N] or better pay --all --budget N");
    process.exitCode = 1;
    return;
  }

  if (values.all && !values.budget) {
    printText("error: --all requires --budget AMOUNT\n\nExample: better pay --all --budget 50USD");
    process.exitCode = 1;
    return;
  }

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.sardis.pay", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["pay"];
  if (pkg) coreArgs.push(pkg);
  if (values.amount)    coreArgs.push("--amount", values.amount);
  if (values.all)       coreArgs.push("--all");
  if (values.budget)    coreArgs.push("--budget", values.budget);
  if (values.strategy)  coreArgs.push("--strategy", values.strategy);
  if (values.recurring) coreArgs.push("--recurring", values.recurring);
  if (values.org)       coreArgs.push("--org", values.org);
  if (values["dry-run"]) coreArgs.push("--dry-run");
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
