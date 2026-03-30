import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";

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

  if (projectDirs.length === 0) {
    printText("Error: specify project directories or --workspace-root");
    process.exitCode = 1;
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
