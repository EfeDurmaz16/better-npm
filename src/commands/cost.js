import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runGenerateCostReportNapi } from "../lib/core.js";

/**
 * `better cost` — show cost breakdown for provisioned OSP services
 *
 * Reads from ~/.better/vault/ to list provisioned services
 * and queries Sardis wallet for cost data
 */
export async function cmdCost(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better cost [options]

Show cost breakdown for provisioned services.

Options:
  --breakdown        Show daily/monthly breakdown
  --since DATE       Show costs since date (YYYY-MM-DD)
  --json             Machine-readable JSON output
  -h, --help         Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      breakdown: { type: "boolean", default: false },
      since: { type: "string" },
    },
    strict: false
  });

  // Forward to Rust binary for wallet/vault access
  const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin");
  const binaryNames = ["better-core", "better"];
  let binPath = null;
  for (const name of binaryNames) {
    try {
      await fs.access(join(binDir, name));
      binPath = join(binDir, name);
      break;
    } catch {}
  }

  if (binPath) {
    const args = ["earnings", "--breakdown"];
    if (values.json) args.push("--json");
    if (values.since) args.push("--since", values.since);
    const result = spawnSync(binPath, args, { encoding: "utf8" });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status) process.exitCode = result.status;
    return;
  }

  // Fallback: read vault directory for service list
  const vaultDir = join(process.env.HOME || "/tmp", ".better", "vault");
  let services = [];
  try {
    const entries = await fs.readdir(vaultDir);
    services = entries.filter(e => e.endsWith(".json"));
  } catch {}

  if (services.length === 0) {
    const result = { ok: true, kind: "better.cost", services: [], totalMonthly: 0, message: "No provisioned services found. Run 'better provision' to add services." };
    if (values.json) { printJson(result); }
    else { printText("No provisioned services. Run 'better provision' to add services."); }
    return;
  }

  // Parse service costs from vault entries and generate cost report via NAPI
  const serviceCosts = [];
  for (const svcFile of services) {
    try {
      const raw = JSON.parse(await fs.readFile(join(vaultDir, svcFile), "utf8"));
      if (raw.monthly_usd != null) {
        serviceCosts.push({
          provider: raw.provider ?? "unknown",
          service: raw.service ?? svcFile.replace(".json", ""),
          tier: raw.tier ?? "free",
          environment: raw.environment ?? "production",
          monthly_usd: raw.monthly_usd ?? 0,
          usage_pct: raw.usage_pct ?? 0,
        });
      }
    } catch {}
  }
  const costReport = runGenerateCostReportNapi(serviceCosts, 0, new Date().getDate());
  if (costReport?.ok && costReport.data) {
    const r = costReport.data;
    const result = {
      ok: true, kind: "better.cost",
      totalMonthly: r.total_monthly_usd,
      services: serviceCosts,
      optimizations: r.optimizations ?? [],
      trend: r.trend,
    };
    if (values.json) { printJson(result); }
    else {
      printText(`Monthly cost: $${r.total_monthly_usd.toFixed(2)}`);
      if (r.optimizations?.length > 0) {
        printText(`\nOptimization opportunities (${r.optimizations.length}):`);
        for (const opt of r.optimizations.slice(0, 5)) {
          printText(`  ${opt.suggestion} — save $${opt.potential_savings_usd.toFixed(2)}/mo`);
        }
      }
    }
    return;
  }

  const result = {
    ok: true, kind: "better.cost",
    services: services.map(s => ({ name: s.replace(".json", ""), status: "provisioned" })),
    message: "Install Sardis CLI for cost breakdown: better login --sardis",
  };
  if (values.json) { printJson(result); }
  else { printText(`${services.length} provisioned service(s).\nRun 'better login --sardis' for cost breakdown.`); }
}
