import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { runAnalyzeOrgNapi, runScanProjectsNapi } from "../lib/core.js";

/**
 * `better cross-project <dir1> [dir2] [dir3...]` — analyze dependencies across multiple projects
 */
export async function cmdCrossProject(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better cross-project <dir1> [dir2...] [options]
  better cross-project --workspace-root PATH

Analyze dependency patterns across multiple projects.

Options:
  --workspace-root PATH  Scan all subdirectories for projects
  --drift                Show version drift analysis
  --shared               Show shared packages
  --json                 Machine-readable output
  -h, --help             Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "workspace-root": { type: "string" },
      drift: { type: "boolean", default: true },
      shared: { type: "boolean", default: true },
    },
    allowPositionals: true,
    strict: false
  });

  const useJson = values.json || runtime.json === true;

  let projectDirs = positionals.map(p => path.resolve(p));

  if (values["workspace-root"]) {
    // Auto-discover projects under workspace root
    const wsRoot = path.resolve(values["workspace-root"]);
    try {
      const entries = await fs.readdir(wsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(wsRoot, entry.name);
        const hasPkg = await fs.access(path.join(dir, "package.json")).then(() => true).catch(() => false);
        const hasGomod = await fs.access(path.join(dir, "go.mod")).then(() => true).catch(() => false);
        const hasCargo = await fs.access(path.join(dir, "Cargo.toml")).then(() => true).catch(() => false);
        if (hasPkg || hasGomod || hasCargo) projectDirs.push(dir);
      }
    } catch (err) {
      printText(`Error scanning workspace root: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  // When workspace-root is given, try NAPI fast path (Rust analyze_org)
  if (values["workspace-root"] && projectDirs.length > 0) {
    const wsRoot = path.resolve(values["workspace-root"]);
    const napiResult = runAnalyzeOrgNapi(wsRoot);
    if (napiResult?.ok && napiResult.data) {
      const r = napiResult.data;
      const result = {
        ok: true,
        kind: "better.cross-project",
        projectsScanned: r.projects_analyzed,
        uniquePackages: r.total_unique_deps,
        versionDrift: r.version_inconsistencies?.length ?? 0,
        consolidationOpportunities: r.consolidation_opportunities?.length ?? 0,
        standardizationScore: r.standardization_score,
        topShared: (r.version_inconsistencies ?? []).slice(0, 20).map(v => ({
          name: v.package,
          versions: Object.keys(v.versions),
          recommended: v.recommended,
        })),
        consolidations: r.consolidation_opportunities ?? [],
      };
      if (useJson) { printJson(result); }
      else {
        printText(`Cross-Project Analysis: ${r.projects_analyzed} projects, ${r.total_unique_deps} unique packages`);
        printText(`Standardization score: ${r.standardization_score}/100`);
        if (r.version_inconsistencies?.length > 0) {
          printText(`\nVersion drift (${r.version_inconsistencies.length} packages):`);
          for (const v of r.version_inconsistencies.slice(0, 10)) {
            printText(`  ${v.package}: recommend ${v.recommended}`);
          }
        }
        if (r.consolidation_opportunities?.length > 0) {
          printText(`\nConsolidation opportunities (${r.consolidation_opportunities.length}):`);
          for (const c of r.consolidation_opportunities.slice(0, 5)) {
            printText(`  ${c.category}: ${c.packages.join(", ")} — ${c.reason}`);
          }
        }
      }
      return;
    }
  }

  if (projectDirs.length === 0) {
    printText("Error: specify project directories or --workspace-root");
    process.exitCode = 1;
    return;
  }

  // Try Rust cross-project scan NAPI (richer version drift + shared package analysis)
  const scanResult = runScanProjectsNapi(projectDirs);
  if (scanResult?.ok && scanResult.data) {
    const r = scanResult.data;
    const result = {
      ok: true, kind: "better.cross-project",
      projectsScanned: r.projects_scanned,
      totalPackages: r.total_packages,
      sharedPackages: r.shared_packages ?? [],
      versionDrift: r.version_drift ?? [],
      upgradeOpportunities: r.upgrade_opportunities ?? [],
    };
    if (useJson) { printJson(result); }
    else {
      printText(`Cross-Project Scan: ${r.projects_scanned} projects, ${r.total_packages} packages`);
      if (r.version_drift?.length > 0) {
        printText(`\nVersion drift (${r.version_drift.length} packages):`);
        for (const d of r.version_drift.slice(0, 10)) {
          printText(`  ${d.package}: ${d.min_version} → ${d.max_version}${d.drift_major ? " (MAJOR)" : ""}`);
        }
      }
      if (r.upgrade_opportunities?.length > 0) {
        printText(`\nUpgrade opportunities (${r.upgrade_opportunities.length}):`);
        for (const u of r.upgrade_opportunities.slice(0, 5)) {
          printText(`  ${u.package}: → ${u.latest_version} [${u.update_type}] (${u.projects_affected} projects)`);
        }
      }
    }
    return;
  }

  if (!useJson) printText(`Analyzing ${projectDirs.length} project(s)...`);

  // Aggregate package data
  const allPackages = {};
  let totalProjects = 0;

  for (const dir of projectDirs) {
    const lockPath = path.join(dir, "package-lock.json");
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
      totalProjects++;
      if (lock.packages) {
        for (const [key, val] of Object.entries(lock.packages)) {
          if (!key) continue;
          const name = key.replace(/^node_modules\//, "");
          if (!allPackages[name]) allPackages[name] = {};
          allPackages[name][val.version] = (allPackages[name][val.version] || 0) + 1;
        }
      }
    } catch { /* not an npm project */ }
  }

  const sharedPackages = Object.entries(allPackages)
    .filter(([, versions]) => Object.keys(versions).length > 1 || Object.values(versions).some(c => c > 1))
    .map(([name, versions]) => ({
      name,
      versions: Object.keys(versions),
      projectCount: Object.values(versions).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.projectCount - a.projectCount)
    .slice(0, 20);

  const driftPackages = sharedPackages.filter(p => p.versions.length > 1);

  const result = {
    ok: true,
    kind: "better.cross-project",
    projectsScanned: totalProjects,
    uniquePackages: Object.keys(allPackages).length,
    versionDrift: driftPackages.length,
    topShared: sharedPackages,
  };

  if (useJson) {
    printJson(result);
    return;
  }

  printText(`Cross-Project Analysis: ${totalProjects} projects, ${Object.keys(allPackages).length} unique packages`);
  if (driftPackages.length > 0) {
    printText(`\nVersion Drift (${driftPackages.length} packages):`);
    for (const pkg of driftPackages.slice(0, 10)) {
      printText(`  ${pkg.name}: ${pkg.versions.join(", ")}`);
    }
  }
}
