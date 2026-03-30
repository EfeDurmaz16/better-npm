/**
 * better install-order — show package installation dependency order
 *
 * Performs a topological sort of a package's dependency tree to show
 * the order in which packages would need to be installed.
 *
 * Usage:
 *   better install-order
 *   better install-order --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function readDeps(nmPath, name) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(nmPath, ...name.split("/"), "package.json"), "utf8"));
    return { deps: Object.keys(pkg.dependencies || {}), version: pkg.version };
  } catch {
    return { deps: [], version: null };
  }
}

// Kahn's algorithm for topological sort
async function topoSort(rootDeps, nmPath, maxPkg = 200) {
  const inDegree = new Map(); // name → count of packages that depend on it
  const adjacency = new Map(); // name → [dependencies]
  const visited = new Set();
  const queue = [...rootDeps];

  // BFS to build graph
  while (queue.length > 0 && visited.size < maxPkg) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);

    const { deps } = await readDeps(nmPath, name);
    adjacency.set(name, deps);
    if (!inDegree.has(name)) inDegree.set(name, 0);

    for (const dep of deps) {
      inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  // Kahn's BFS topological sort (packages with no deps first)
  const result = [];
  const noIncoming = [...inDegree.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  const workQueue = [...noIncoming];

  while (workQueue.length > 0) {
    const node = workQueue.shift();
    result.push(node);
    for (const dep of (adjacency.get(node) || [])) {
      const newDeg = (inDegree.get(dep) || 1) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) workQueue.push(dep);
    }
  }

  // Any remaining nodes are in a cycle
  const remaining = [...visited].filter(n => !result.includes(n));
  return { order: result, cycles: remaining };
}

export async function cmdInstallOrder(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      limit:  { type: "string", default: "50" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better install-order [options]

Show topological installation order of dependencies.

Options:
  --limit <n>  Max packages to show (default: 50)
  --json       Machine-readable output
  -h, --help   Show this help

Packages with no dependencies are shown first (leaf packages),
followed by packages that depend on them.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter install-order\x1b[0m\n`);
  }

  let pkgJson = {};
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const rootDeps = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });
  if (rootDeps.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.install-order", order: [] }); return; }
    printText(`  \x1b[90mNo dependencies found.\x1b[0m\n`);
    return;
  }

  const maxPkg = parseInt(values.limit, 10) || 50;
  const { order, cycles } = await topoSort(rootDeps, nmPath, maxPkg);

  const limit = parseInt(values.limit, 10) || 50;
  const shown = order.slice(0, limit);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.install-order",
      total: order.length,
      cycles: cycles.length,
      order: shown,
      cyclePackages: cycles,
    });
    return;
  }

  printText(`  Total packages: ${order.length}  |  Cycles: ${cycles.length}\n`);
  printText(`  \x1b[1mInstall order (leaves first):\x1b[0m`);
  for (let i = 0; i < shown.length; i++) {
    const num = String(i + 1).padStart(3);
    printText(`  \x1b[90m${num}\x1b[0m  ${shown[i]}`);
  }
  if (order.length > limit) {
    printText(`  \x1b[90m... and ${order.length - limit} more\x1b[0m`);
  }
  if (cycles.length > 0) {
    printText(`\n  \x1b[33m⚠ ${cycles.length} package(s) in circular dependencies: ${cycles.slice(0, 5).join(", ")}\x1b[0m`);
  }
  printText("");
}
