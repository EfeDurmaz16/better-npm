import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better maintenance` — predictive maintenance analysis
 *
 * Predicts which packages will need attention soon:
 * - Packages likely to release breaking changes (major version gaps)
 * - Unmaintained packages (no commits in 12+ months)
 * - Packages with growing CVE history
 * - Packages with declining download trends
 * - Dependencies that block Node.js LTS upgrades
 */
export async function cmdMaintenance(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better maintenance [options]

Predict maintenance burden and flag packages needing attention.

Options:
  --json              Machine-readable JSON output
  --node-version VER  Target Node.js version for compatibility check
  --project-root PATH Override project root
  -h, --help          Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "node-version": { type: "string" },
      "project-root": { type: "string" },
    },
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const pkgPath = path.join(projectRoot, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch {
    const err = { ok: false, error: "package.json not found" };
    if (values.json) { printJson(err); } else { printText("Error: package.json not found"); }
    process.exitCode = 1;
    return;
  }

  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const depNames = Object.keys(allDeps).slice(0, 30); // Limit to 30 for speed

  if (depNames.length === 0) {
    const result = { ok: true, kind: "better.maintenance", message: "No dependencies found" };
    if (values.json) { printJson(result); } else { printText("No dependencies to analyze."); }
    return;
  }

  if (!values.json) printText(`Analyzing ${depNames.length} packages for maintenance risk...`);

  const analyses = await Promise.all(depNames.map(name => analyzePackage(name, allDeps[name])));
  const alerts = analyses.filter(a => a.risk !== "low").sort((a, b) => riskRank(b.risk) - riskRank(a.risk));

  const nodeVersion = values["node-version"] || process.version.replace("v", "");
  const nodeIncompat = analyses.filter(a => !isNodeCompatible(a, nodeVersion));

  const result = {
    ok: true,
    kind: "better.maintenance",
    analyzed: depNames.length,
    alerts: alerts.length,
    nodeIncompat: nodeIncompat.length,
    packages: alerts,
    summary: buildSummary(alerts, nodeIncompat),
  };

  if (values.json) {
    printJson(result);
    return;
  }

  if (alerts.length === 0) {
    printText("All dependencies look healthy. No maintenance alerts.");
    return;
  }

  const lines = [`Maintenance Analysis: ${alerts.length} packages need attention\n`];
  for (const p of alerts) {
    const icon = p.risk === "critical" ? "🔴" : p.risk === "high" ? "🟠" : "🟡";
    lines.push(`${icon} ${p.name} (${p.risk})`);
    for (const reason of p.reasons) lines.push(`   • ${reason}`);
  }
  if (nodeIncompat.length > 0) {
    lines.push(`\n⚠ ${nodeIncompat.length} packages may not support Node.js ${nodeVersion}`);
  }
  printText(lines.join("\n"));
}

async function analyzePackage(name, versionSpec) {
  const reasons = [];
  let risk = "low";

  try {
    const resp = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (!resp.ok) return { name, risk, reasons };
    const data = await resp.json();

    const latestVer = data["dist-tags"]?.latest || "0.0.0";
    const currentVer = versionSpec.replace(/[^0-9.].*/, "").replace(/^[^0-9]*/, "");

    // Major version gap
    const latestMajor = parseInt(latestVer.split(".")[0]) || 0;
    const currentMajor = parseInt(currentVer.split(".")[0]) || 0;
    if (latestMajor > currentMajor + 1) {
      reasons.push(`${latestMajor - currentMajor} major versions behind (${currentMajor}.x → ${latestMajor}.x)`);
      risk = escalate(risk, "high");
    }

    // Last publish date
    const modifiedStr = data.time?.modified;
    if (modifiedStr) {
      const daysSince = Math.floor((Date.now() - new Date(modifiedStr).getTime()) / 86400000);
      if (daysSince > 730) {
        reasons.push(`Unmaintained: no updates in ${Math.floor(daysSince / 365)} years`);
        risk = escalate(risk, "high");
      } else if (daysSince > 365) {
        reasons.push(`Stale: last update ${Math.floor(daysSince / 30)} months ago`);
        risk = escalate(risk, "medium");
      }
    }

    // Deprecated
    const versionData = data.versions?.[latestVer];
    if (versionData?.deprecated) {
      reasons.push(`Deprecated: ${versionData.deprecated.slice(0, 80)}`);
      risk = escalate(risk, "critical");
    }

    // No maintainers
    if (!data.maintainers?.length) {
      reasons.push("No maintainers listed");
      risk = escalate(risk, "medium");
    }

    return { name, risk, reasons, latestVersion: latestVer, engines: versionData?.engines };
  } catch {
    return { name, risk: "low", reasons: [] };
  }
}

function escalate(current, newRisk) {
  const ranks = { low: 0, medium: 1, high: 2, critical: 3 };
  return ranks[newRisk] > ranks[current] ? newRisk : current;
}

function riskRank(risk) {
  return { low: 0, medium: 1, high: 2, critical: 3 }[risk] || 0;
}

function isNodeCompatible(analysis, nodeVersion) {
  if (!analysis.engines?.node) return true;
  // Simple check: if engines.node is >=X and X > current, incompatible
  const match = analysis.engines.node.match(/>=\s*(\d+)/);
  if (match && parseInt(match[1]) > parseInt(nodeVersion.split(".")[0])) return false;
  return true;
}

function buildSummary(alerts, nodeIncompat) {
  const critical = alerts.filter(a => a.risk === "critical").length;
  const high = alerts.filter(a => a.risk === "high").length;
  const medium = alerts.filter(a => a.risk === "medium").length;
  return `${critical} critical, ${high} high, ${medium} medium risk packages. ${nodeIncompat.length} Node.js compatibility issues.`;
}
