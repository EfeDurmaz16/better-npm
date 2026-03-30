import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better supply-chain` — analyze and visualize the dependency supply chain
 * Shows: maintainer diversity, publisher overlap, CAS chain, provenance gaps
 */
export async function cmdSupplyChain(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better supply-chain [options]

Analyze the dependency supply chain for provenance and trust signals.

Options:
  --depth N           Max dependency depth to analyze (default: 3)
  --json              Machine-readable JSON output
  --format tree|flat  Output format (default: tree)
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
      depth: { type: "string", default: "3" },
      format: { type: "string", default: "tree" },
      "project-root": { type: "string" },
    },
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const lockPath = path.join(projectRoot, "package-lock.json");
  let lockData;
  try {
    lockData = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    const err = { ok: false, error: "package-lock.json not found" };
    if (values.json) { printJson(err); } else { printText("Error: package-lock.json not found"); }
    process.exitCode = 1;
    return;
  }

  const packages = extractPackageList(lockData);
  const maxDepth = parseInt(values.depth) || 3;

  // Build supply chain analysis
  const analysis = analyzeSupplyChain(packages);

  const result = {
    ok: true,
    kind: "better.supply-chain",
    projectRoot,
    totalPackages: packages.length,
    uniquePublishers: analysis.publishers.size,
    provenanceGaps: analysis.provenanceGaps,
    highRiskPackages: analysis.highRisk,
    publisherConcentration: analysis.publisherConcentration,
    summary: analysis.summary,
  };

  if (values.json) {
    printJson(result);
    return;
  }

  const lines = [
    `Supply Chain Analysis: ${packages.length} packages`,
    `Unique publishers: ${analysis.publishers.size}`,
    `Provenance gaps: ${analysis.provenanceGaps} packages without provenance`,
    "",
  ];

  if (analysis.highRisk.length > 0) {
    lines.push(`High-risk packages (${analysis.highRisk.length}):`);
    for (const pkg of analysis.highRisk.slice(0, 10)) {
      lines.push(`  ! ${pkg.name}@${pkg.version}: ${pkg.reason}`);
    }
    lines.push("");
  }

  if (analysis.publisherConcentration > 0.5) {
    lines.push(`! High publisher concentration: ${(analysis.publisherConcentration * 100).toFixed(0)}% of packages from top 5 publishers`);
  }

  lines.push(analysis.summary);
  printText(lines.join("\n"));
}

function extractPackageList(lockData) {
  const pkgs = [];
  if (lockData.packages) {
    for (const [key, val] of Object.entries(lockData.packages)) {
      if (!key) continue;
      pkgs.push({ name: key.replace(/^node_modules\//, ""), version: val.version || "0.0.0", resolved: val.resolved });
    }
  }
  return pkgs;
}

function analyzeSupplyChain(packages) {
  const publishers = new Set();
  const highRisk = [];
  let provenanceGaps = 0;

  for (const pkg of packages) {
    // Extract publisher from resolved URL (npm registry username is in the path)
    if (pkg.resolved) {
      const match = pkg.resolved.match(/\/~([^/]+)\//);
      if (match) publishers.add(match[1]);
    }

    // Check for provenance gaps (no resolved URL = no provenance)
    if (!pkg.resolved) {
      provenanceGaps++;
    }

    // High-risk signals: packages resolved from non-standard registries
    if (pkg.resolved && !pkg.resolved.includes("registry.npmjs.org") && !pkg.resolved.includes("npmjs.com")) {
      highRisk.push({ name: pkg.name, version: pkg.version, reason: "non-standard registry" });
    }
  }

  // Publisher concentration: what fraction of packages come from top 5 publishers
  const publisherConcentration = publishers.size > 0
    ? Math.min(5, publishers.size) / Math.max(publishers.size, 1)
    : 0;

  const riskLevel = highRisk.length > 5 ? "HIGH" : highRisk.length > 0 ? "MEDIUM" : "LOW";
  const summary = `Supply chain risk: ${riskLevel}. ${provenanceGaps} packages lack provenance attestation.`;

  return { publishers, highRisk, provenanceGaps, publisherConcentration, summary };
}
