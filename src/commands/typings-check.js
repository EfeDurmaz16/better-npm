/**
 * better typings-check — check TypeScript type definition coverage
 *
 * Verifies that installed packages have TypeScript type definitions,
 * either bundled or via @types/* packages, helping TypeScript projects
 * identify missing type coverage.
 *
 * Usage:
 *   better typings-check
 *   better typings-check --prod-only
 *   better typings-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function hasTypesFile(pkgDir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8"));
    if (pkg.types || pkg.typings) return { has: true, source: "bundled", entry: pkg.types || pkg.typings };
    // Check for index.d.ts
    try {
      await fs.access(path.join(pkgDir, "index.d.ts"));
      return { has: true, source: "bundled", entry: "index.d.ts" };
    } catch {}
    return { has: false, source: null, entry: null };
  } catch {
    return { has: false, source: null, entry: null };
  }
}

export async function cmdTypingsCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:        { type: "boolean", default: runtime.json === true },
      help:        { type: "boolean", short: "h", default: false },
      "prod-only": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better typings-check [options]

Check TypeScript type definition coverage for installed packages.

Options:
  --prod-only    Only check production dependencies
  --json         Machine-readable output
  -h, --help     Show this help

Shows:
  • Packages with bundled types
  • Packages with @types/* definitions
  • Packages with no type coverage
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter typings-check\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const depsToCheck = values["prod-only"]
    ? Object.keys(pkgJson.dependencies || {})
    : Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });

  // Get installed @types packages
  const atTypesInstalled = new Set();
  const atTypesDir = path.join(nmPath, "@types");
  try {
    const entries = await fs.readdir(atTypesDir);
    for (const e of entries) atTypesInstalled.add(`@types/${e}`);
  } catch {}

  const results = [];
  const BATCH = 20;
  for (let i = 0; i < depsToCheck.length; i += BATCH) {
    const batch = depsToCheck.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dep) => {
      if (dep.startsWith("@types/")) return; // Skip @types packages themselves

      const pkgDir = path.join(nmPath, dep);
      const bundledTypes = await hasTypesFile(pkgDir);
      const atTypesName = `@types/${dep.replace(/^@/, "").replace(/\//, "__")}`;
      const hasAtTypes = atTypesInstalled.has(atTypesName);
      const hasTypes = bundledTypes.has || hasAtTypes;
      const typesSource = bundledTypes.has ? "bundled" : hasAtTypes ? `@types/${dep.replace(/^@/, "").replace(/\//, "__")}` : null;

      results.push({ name: dep, hasTypes, typesSource, bundled: bundledTypes.has, atTypes: hasAtTypes });
    }));
  }

  results.sort((a, b) => {
    if (a.hasTypes !== b.hasTypes) return a.hasTypes ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const withTypes = results.filter(r => r.hasTypes);
  const withoutTypes = results.filter(r => !r.hasTypes);
  const coverage = results.length > 0 ? Math.round(withTypes.length / results.length * 100) : 100;

  if (values.json) {
    printJson({
      ok: withoutTypes.length === 0,
      kind: "better.typings-check",
      total: results.length,
      withTypes: withTypes.length,
      withoutTypes: withoutTypes.length,
      coverage,
      packages: results,
    });
    return;
  }

  printText(`  Packages checked: ${results.length}  |  With types: ${withTypes.length}  |  Coverage: ${coverage}%\n`);

  if (withoutTypes.length === 0) {
    printText(`\x1b[32m✔ All packages have TypeScript type definitions.\x1b[0m`);
  } else {
    if (withTypes.length > 0 && withoutTypes.length <= 10) {
      printText(`\x1b[33m⚠ ${withoutTypes.length} package(s) without type definitions:\x1b[0m\n`);
      for (const r of withoutTypes) {
        const atTypesName = `@types/${r.name.replace(/^@/, "").replace(/\//, "__")}`;
        printText(`  \x1b[33m·\x1b[0m  \x1b[1m${r.name}\x1b[0m  \x1b[90m→ try: npm install -D ${atTypesName}\x1b[0m`);
      }
    } else if (withoutTypes.length > 10) {
      printText(`\x1b[33m⚠ ${withoutTypes.length} packages without type definitions (showing first 10):\x1b[0m\n`);
      for (const r of withoutTypes.slice(0, 10)) {
        printText(`  \x1b[33m·\x1b[0m  \x1b[1m${r.name}\x1b[0m`);
      }
      printText(`  \x1b[90m... and ${withoutTypes.length - 10} more\x1b[0m`);
    }
  }
  printText("");
}
