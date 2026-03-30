/**
 * better find — find which packages depend on a given package
 *
 * Performs a reverse dependency lookup: given a package name,
 * shows all packages in your dependency tree that require it.
 * Similar to "why" but with more detail about version requirements.
 *
 * Usage:
 *   better find lodash
 *   better find lodash --all
 *   better find lodash --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function buildReverseIndex(nmPath) {
  // Map: package name -> [{dependent, requiredRange}]
  const reverseIndex = {};

  let entries;
  try { entries = await fs.readdir(nmPath, { withFileTypes: true }); } catch { return reverseIndex; }

  const BATCH = 20;
  const names = entries
    .filter(e => e.isDirectory() && !e.name.startsWith("."))
    .map(e => e.name);

  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    await Promise.all(batch.map(async (name) => {
      const pkgPath = name.startsWith("@")
        ? null // handle scoped separately
        : path.join(nmPath, name, "package.json");

      if (!pkgPath) return;

      let pkg;
      try { pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")); } catch { return; }

      const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
      for (const [dep, range] of Object.entries(deps)) {
        if (!reverseIndex[dep]) reverseIndex[dep] = [];
        reverseIndex[dep].push({ dependent: name, range, type: pkg.dependencies?.[dep] ? "dep" : "peer" });
      }
    }));
  }

  // Handle scoped packages
  const scopedDirs = entries.filter(e => e.isDirectory() && e.name.startsWith("@"));
  for (const scopeDir of scopedDirs) {
    let subEntries;
    try { subEntries = await fs.readdir(path.join(nmPath, scopeDir.name), { withFileTypes: true }); } catch { continue; }
    for (const se of subEntries.filter(e => e.isDirectory())) {
      const scopedName = `${scopeDir.name}/${se.name}`;
      let pkg;
      try {
        pkg = JSON.parse(await fs.readFile(path.join(nmPath, scopeDir.name, se.name, "package.json"), "utf8"));
      } catch { continue; }

      const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
      for (const [dep, range] of Object.entries(deps)) {
        if (!reverseIndex[dep]) reverseIndex[dep] = [];
        reverseIndex[dep].push({ dependent: scopedName, range, type: pkg.dependencies?.[dep] ? "dep" : "peer" });
      }
    }
  }

  return reverseIndex;
}

export async function cmdFind(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      all:   { type: "boolean", default: false },
      depth: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printText(`Usage: better find <package> [options]

Find which installed packages depend on a given package.

Options:
  --all        Include dev dependencies in search
  --depth <N>  Max reverse-dep depth to show (default: 1)
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better find lodash
  better find semver --all
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const target = positionals[0];
  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    process.stderr.write(`\x1b[90mBuilding reverse dependency index…\x1b[0m\n`);
  }

  const reverseIndex = await buildReverseIndex(nmPath);
  const directDependents = reverseIndex[target] || [];

  // Check if it's a direct dependency
  const isDirect = Boolean(pkgJson.dependencies?.[target] || pkgJson.devDependencies?.[target]);

  // Get installed version
  let installedVersion = null;
  try {
    const depPkg = JSON.parse(await fs.readFile(path.join(nmPath, target, "package.json"), "utf8"));
    installedVersion = depPkg.version;
  } catch {}

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.find",
      package: target,
      installedVersion,
      isDirect,
      dependentCount: directDependents.length,
      dependents: directDependents,
    });
    return;
  }

  printText(`\n\x1b[1mbetter find — ${target}\x1b[0m${installedVersion ? `@${installedVersion}` : ""}\n`);

  if (!installedVersion) {
    printText(`\x1b[33m⚠ "${target}" is not installed in node_modules.\x1b[0m`);
    return;
  }

  if (isDirect) {
    const range = pkgJson.dependencies?.[target] || pkgJson.devDependencies?.[target];
    const depType = pkgJson.dependencies?.[target] ? "dependencies" : "devDependencies";
    printText(`  \x1b[32m✔ Direct dependency\x1b[0m in ${depType}: "${range}"\n`);
  }

  if (directDependents.length === 0) {
    if (!isDirect) {
      printText(`\x1b[33m⚠ No packages in node_modules depend on "${target}".\x1b[0m`);
    } else {
      printText(`\x1b[90mNo other packages in node_modules depend on "${target}".\x1b[0m`);
    }
    return;
  }

  printText(`\x1b[90m${directDependents.length} package(s) depend on ${target}:\x1b[0m\n`);

  // Sort: deps first, then peers
  const sorted = [...directDependents].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dep" ? -1 : 1;
    return a.dependent.localeCompare(b.dependent);
  });

  for (const { dependent, range, type } of sorted.slice(0, 30)) {
    const typeLabel = type === "peer" ? " \x1b[90m(peer)\x1b[0m" : "";
    printText(`  ${dependent.padEnd(30)} requires ${range}${typeLabel}`);
  }

  if (sorted.length > 30) {
    printText(`\n  \x1b[90m...and ${sorted.length - 30} more\x1b[0m`);
  }
}
