/**
 * better compliance — generate compliance reports for OSP service usage
 *
 * Usage:
 *   better compliance report                       Report for current project
 *   better compliance report --org ORGNAME         Report for organisation
 *   better compliance report --period 90           Report for last 90 days
 *   better compliance check                        Check compliance status
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const HELP = `better compliance — OSP service compliance reports

Usage:
  better compliance report                   Generate compliance report
  better compliance report --org ORGNAME     Org-level compliance report
  better compliance report --period N        Report for last N days (default: 30)
  better compliance check                    Check compliance status (pass/fail)

Options:
  --org ORG          Organisation name for enterprise compliance reports
  --period N         Reporting period in days (default: 30)
  --format FORMAT    Output format: text|json|csv|pdf-path (default: text)
  --json             Machine-readable output
  -h, --help         Show this help

Enterprise features:
  Requires org admin access via Sardis enterprise plan.
  Reports include service usage, spend, SLA compliance, and GDPR/SOC2 status.

Examples:
  better compliance report
  better compliance report --org mycompany --period 90
  better compliance report --org mycompany --json
  better compliance check
`;

export async function cmdCompliance(argv) {
  const runtime = getRuntimeConfig();
  if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  if (!["report", "check"].includes(sub)) {
    printText(`Unknown compliance subcommand '${sub}'. Run 'better compliance --help' for usage.`);
    process.exitCode = 1;
    return;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      org:    { type: "string" },
      period: { type: "string", default: "30" },
      format: { type: "string", default: "text" },
      json:   { type: "boolean", default: runtime.json === true },
    },
    strict: false,
  });

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: `better.compliance.${sub}`, error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["compliance", sub, "--period", values.period];
  if (values.org)    coreArgs.push("--org", values.org);
  if (values.format) coreArgs.push("--format", values.format);
  if (values.json)   coreArgs.push("--json");

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
