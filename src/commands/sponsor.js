/**
 * better sponsor — sponsor package maintainers via Sardis wallet
 *
 * Usage:
 *   better sponsor lodash --amount 10USD           One-time $10
 *   better sponsor lodash --amount 5USD --monthly  Recurring monthly $5
 *   better sponsors list                           List active sponsorships
 *   better sponsor pause lodash                    Pause sponsorship
 *   better sponsor cancel lodash                   Cancel sponsorship
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const HELP = `better sponsor — sponsor package maintainers

Usage:
  better sponsor <package> --amount AMOUNT       One-time sponsorship
  better sponsor <package> --amount N --monthly  Recurring monthly sponsorship
  better sponsors list                           List active sponsorships
  better sponsor pause <package>                 Pause a recurring sponsorship
  better sponsor cancel <package>                Cancel a recurring sponsorship

Arguments:
  package   npm package name (e.g. lodash, react)
  AMOUNT    Amount with currency: 10USD, 5USDC

Options:
  --amount AMOUNT   Sponsorship amount (e.g. 10USD)
  --monthly         Set up recurring monthly sponsorship
  --weekly          Set up recurring weekly sponsorship
  --yearly          Set up recurring yearly sponsorship
  --message MSG     Optional public message for the maintainer
  --json            Machine-readable output
  -h, --help        Show this help

Examples:
  better sponsor lodash --amount 10USD
  better sponsor react --amount 5USD --monthly
  better sponsors list
  better sponsor cancel lodash
`;

export async function cmdSponsor(argv) {
  const runtime = getRuntimeConfig();

  if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  // Handle "better sponsors list" alias
  if (argv[0] === "list" || (argv[0] === "s" && argv[1] === "list")) {
    return cmdSponsorList(argv.slice(1), runtime);
  }

  const sub = argv[0];
  if (sub === "pause" || sub === "cancel") {
    return cmdSponsorManage(sub, argv.slice(1), runtime);
  }

  // Default: better sponsor <package> [options]
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      amount:  { type: "string" },
      monthly: { type: "boolean", default: false },
      weekly:  { type: "boolean", default: false },
      yearly:  { type: "boolean", default: false },
      message: { type: "string" },
      json:    { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const pkg = positionals[0];
  if (!pkg) {
    printText("error: 'sponsor' requires a package name\n\nUsage: better sponsor <package> --amount AMOUNT");
    process.exitCode = 1;
    return;
  }

  if (!values.amount) {
    printText("error: 'sponsor' requires --amount\n\nExample: better sponsor lodash --amount 10USD");
    process.exitCode = 1;
    return;
  }

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.sardis.sponsor", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["sponsor", pkg, "--amount", values.amount];
  if (values.monthly) coreArgs.push("--monthly");
  if (values.weekly)  coreArgs.push("--weekly");
  if (values.yearly)  coreArgs.push("--yearly");
  if (values.message) coreArgs.push("--message", values.message);
  if (values.json)    coreArgs.push("--json");

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

async function cmdSponsorList(argv, runtime) {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: runtime.json === true } },
    strict: false,
  });

  const corePath = await findBetterCore();
  if (!corePath) {
    if (values.json) { printJson({ ok: false, kind: "better.sardis.sponsors", error: "better-core not found" }); }
    else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["sponsors", "list"];
  if (values.json) coreArgs.push("--json");

  const result = spawnSync(corePath, coreArgs, {
    stdio: values.json ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });

  if (values.json && result.stdout) {
    try { printJson(JSON.parse(result.stdout.trim())); } catch { printText(result.stdout.trim()); }
  }
  process.exitCode = result.status ?? 0;
}

async function cmdSponsorManage(action, argv, runtime) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: runtime.json === true } },
    allowPositionals: true,
    strict: false,
  });

  const pkg = positionals[0];
  if (!pkg) {
    printText(`error: 'sponsor ${action}' requires a package name`);
    process.exitCode = 1;
    return;
  }

  const corePath = await findBetterCore();
  if (!corePath) {
    if (values.json) { printJson({ ok: false, kind: `better.sardis.sponsor.${action}`, error: "better-core not found" }); }
    else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["sponsor", action, pkg];
  if (values.json) coreArgs.push("--json");

  const result = spawnSync(corePath, coreArgs, {
    stdio: values.json ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });

  if (values.json && result.stdout) {
    try { printJson(JSON.parse(result.stdout.trim())); } catch { printText(result.stdout.trim()); }
  }
  process.exitCode = result.status ?? 0;
}
