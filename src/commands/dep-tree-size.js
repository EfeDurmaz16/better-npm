/**
 * better dep-tree-size — show cumulative size of dependency subtrees
 *
 * For each direct dependency, computes the total disk size including
 * all of its transitive dependencies. Helps identify which top-level
 * packages bring the most weight.
 *
 * Usage:
 *   better dep-tree-size
 *   better dep-tree-size --top 10
 *   better dep-tree-size --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const sizeCache = new Map();

async function getDirSize(dir) {
  if (sizeCache.has(dir)) return sizeCache.get(dir);
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await getDirSize(p);
      else if (e.isFile()) { try { total += (await fs.stat(p)).size; } catch {} }
    }));
  } catch {}
  sizeCache.set(dir, total);
  return total;
}

async function subtreeSize(nmPath, pkgName, visited = new Set()) {
  if (visited.has(pkgName)) return 0;
  visited.add(pkgName);

  const pkgDir = path.join(nmPath, pkgName);
  let size = await getDirSize(pkgDir);

  try {
    const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8"));
    for (const dep of Object.keys(pkg.dependencies || {})) {
      size += await subtreeSize(nmPath, dep, visited);
    }
  } catch {}

  return size;
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function bar(n, max, width = 16) {
  if (!max) return " ".repeat(width);
  const filled = Math.round((n / max) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export async function cmdDepTreeSize(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      top:   { type: "string", default: "20" },
      dev:   { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better dep-tree-size [packages...] [options]

Show the total disk size of each dependency's full subtree.

Options:
  --top <n>    Number of packages to show (default: 20)
  --dev        Include devDependencies
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better dep-tree-size
  better dep-tree-size --top 10
  better dep-tree-size webpack babel
`);
    return;
  }

  const topN = Math.max(1, parseInt(values.top) || 20);

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

  const depSections = values.dev
    ? [pkgJson.dependencies, pkgJson.devDependencies]
    : [pkgJson.dependencies];

  const allDeps = {};
  for (const section of depSections) {
    for (const [name] of Object.entries(section || {})) {
      allDeps[name] = true;
    }
  }

  const targets = positionals.length > 0 ? positionals : Object.keys(allDeps);

  if (!values.json) {
    process.stderr.write(`\x1b[90mComputing subtree sizes for ${targets.length} packages…\x1b[0m\n`);
  }

  const BATCH = 4;
  const results = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (name) => {
      const totalSize = await subtreeSize(nmPath, name);
      const ownSize = await getDirSize(path.join(nmPath, name));
      return { name, totalSize, ownSize, transitiveSize: totalSize - ownSize };
    }));
    results.push(...batchResults.filter(r => r.totalSize > 0));
  }

  results.sort((a, b) => b.totalSize - a.totalSize);
  const top = results.slice(0, topN);

  const grandTotal = results.reduce((s, r) => s + r.totalSize, 0);
  const maxSize = top[0]?.totalSize || 1;

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.dep-tree-size",
      totalPackages: targets.length,
      grandTotalSize: grandTotal,
      packages: top,
    });
    return;
  }

  printText(`\n\x1b[1mbetter dep-tree-size\x1b[0m — top ${top.length} by subtree size\n`);
  printText(`  ${"Package".padEnd(30)} ${"Total".padEnd(12)} ${"Own".padEnd(10)}  Chart`);
  printText(`  ${"─".repeat(30)} ${"─".repeat(12)} ${"─".repeat(10)}  ${"─".repeat(16)}`);

  for (const r of top) {
    const totalStr = fmtBytes(r.totalSize);
    const ownStr = fmtBytes(r.ownSize);
    const barStr = `\x1b[36m${bar(r.totalSize, maxSize)}\x1b[0m`;
    printText(`  \x1b[1m${r.name.padEnd(30)}\x1b[0m ${totalStr.padEnd(12)} ${ownStr.padEnd(10)}  ${barStr}`);
  }

  printText(`\n  \x1b[90mGrand total (subtrees): ${fmtBytes(grandTotal)}\x1b[0m`);
  printText(`  \x1b[90mNote: subtrees may overlap — sizes are not additive\x1b[0m\n`);
}
