import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better impact <package>` — analyze what breaks if a dependency is updated/removed
 *
 * Usage:
 *   better impact lodash             # analyze impact of lodash
 *   better impact lodash --update    # simulate updating lodash to latest
 *   better impact lodash --remove    # simulate removing lodash
 *   better impact --all              # analyze all direct deps
 */
export async function cmdImpact(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better impact <package> [options]
  better impact --all [options]

Analyze the impact of updating or removing a dependency.

Options:
  --update          Simulate updating to latest version
  --remove          Simulate removing the package
  --all             Analyze all direct dependencies
  --json            Machine-readable JSON output
  --project-root PATH Override project root
  -h, --help        Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      update: { type: "boolean", default: false },
      remove: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
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

  // Read package-lock.json for dep graph
  const lockPath = path.join(projectRoot, "package-lock.json");
  let lock = null;
  try { lock = JSON.parse(await fs.readFile(lockPath, "utf8")); } catch {}

  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const targets = values.all ? Object.keys(allDeps) : [positionals[0]].filter(Boolean);

  if (targets.length === 0) {
    printText("Error: specify a package name or use --all");
    process.exitCode = 1;
    return;
  }

  const analyses = await Promise.all(targets.map(name => analyzeImpact(name, allDeps[name], lock, values)));

  const result = {
    ok: true,
    kind: "better.impact",
    packages: analyses,
    summary: buildImpactSummary(analyses),
  };

  if (values.json) {
    printJson(result);
    return;
  }

  for (const a of analyses) {
    const lines = [`Impact Analysis: ${a.name}@${a.currentVersion}`];
    lines.push(`  Dependents in tree: ${a.dependentCount}`);
    lines.push(`  Risk level: ${a.risk}`);
    if (a.breakingChange) lines.push(`  ⚠ Breaking change expected: ${a.breakingReason}`);
    if (a.suggestions.length > 0) {
      lines.push(`  Suggestions:`);
      for (const s of a.suggestions) lines.push(`    • ${s}`);
    }
    printText(lines.join("\n"));
  }
}

async function analyzeImpact(name, versionSpec, lock, values) {
  // Count how many packages depend on this one
  let dependentCount = 0;
  if (lock?.packages) {
    for (const [, pkgData] of Object.entries(lock.packages)) {
      if (pkgData.dependencies?.[name] || pkgData.peerDependencies?.[name]) {
        dependentCount++;
      }
    }
  }

  // Fetch latest version from npm
  let latestVersion = versionSpec?.replace(/[^0-9].*/, "") || "unknown";
  let breakingChange = false;
  let breakingReason = "";
  try {
    const resp = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    if (resp.ok) {
      const data = await resp.json();
      latestVersion = data.version;
      const currentMajor = parseInt((versionSpec || "0").replace(/[^0-9].*/, "")) || 0;
      const latestMajor = parseInt(latestVersion.split(".")[0]) || 0;
      if (latestMajor > currentMajor) {
        breakingChange = true;
        breakingReason = `Major version bump ${currentMajor} → ${latestMajor}`;
      }
    }
  } catch { /* ignore */ }

  const risk = dependentCount > 20 ? "high" : dependentCount > 5 ? "medium" : "low";

  const suggestions = [];
  if (values.remove) {
    suggestions.push(`Check ${dependentCount} packages that depend on ${name}`);
    suggestions.push("Run 'better why " + name + "' to see why it's needed");
  }
  if (values.update && breakingChange) {
    suggestions.push(`Review changelog for ${name} v${latestVersion} breaking changes`);
    suggestions.push("Consider using 'better audit fix' first");
  }

  return {
    name,
    currentVersion: versionSpec,
    latestVersion,
    dependentCount,
    risk,
    breakingChange,
    breakingReason,
    suggestions,
  };
}

function buildImpactSummary(analyses) {
  const high = analyses.filter(a => a.risk === "high").length;
  const medium = analyses.filter(a => a.risk === "medium").length;
  const breaking = analyses.filter(a => a.breakingChange).length;
  return `${analyses.length} packages analyzed. ${high} high risk, ${medium} medium risk, ${breaking} with breaking changes available.`;
}
