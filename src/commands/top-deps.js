/**
 * better top-deps — show the most impactful dependencies
 *
 * Ranks installed packages by various metrics: download count,
 * transitive dependency count, disk size, and combined impact score.
 *
 * Usage:
 *   better top-deps
 *   better top-deps --by size
 *   better top-deps --limit 20
 *   better top-deps --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function getDirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        total += await getDirSize(p);
      } else if (e.isFile()) {
        try { total += (await fs.stat(p)).size; } catch {}
      }
    }));
  } catch {}
  return total;
}

async function countTransitiveDeps(nmPath, name, visited = new Set()) {
  if (visited.has(name)) return 0;
  visited.add(name);
  let count = 0;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
    const deps = Object.keys(pkg.dependencies || {});
    count += deps.length;
    for (const dep of deps) {
      count += await countTransitiveDeps(nmPath, dep, visited);
    }
  } catch {}
  return count;
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function bar(n, max, width = 12) {
  if (!max) return " ".repeat(width);
  const filled = Math.round((n / max) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export async function cmdTopDeps(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      by:    { type: "string", default: "size" },
      limit: { type: "string", default: "15" },
      dev:   { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better top-deps [options]

Rank your dependencies by impact metrics.

Options:
  --by <metric>   Sort by: size (default), deps, name
  --limit <n>     Number of packages to show (default: 15)
  --dev           Include devDependencies
  --json          Machine-readable output
  -h, --help      Show this help

Examples:
  better top-deps
  better top-deps --by deps
  better top-deps --limit 20 --dev
`);
    return;
  }

  const sortBy = values.by || "size";
  const limit = Math.max(1, parseInt(values.limit) || 15);

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

  const targets = values.dev
    ? Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies })
    : Object.keys(pkgJson.dependencies || {});

  if (!values.json) {
    process.stderr.write(`\x1b[90mAnalyzing ${targets.length} package(s)…\x1b[0m\n`);
  }

  const BATCH = 5;
  const results = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (name) => {
      let version = null;
      try {
        const p = JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
        version = p.version;
      } catch {}

      const [size, depCount] = await Promise.all([
        getDirSize(path.join(nmPath, name)),
        countTransitiveDeps(nmPath, name),
      ]);

      return { name, version, size, depCount };
    }));
    results.push(...batchResults.filter(r => r.size > 0 || r.depCount >= 0));
  }

  // Sort
  results.sort((a, b) => {
    if (sortBy === "deps") return b.depCount - a.depCount;
    if (sortBy === "name") return a.name.localeCompare(b.name);
    return b.size - a.size; // default: size
  });

  const top = results.slice(0, limit);
  const totalSize = results.reduce((s, r) => s + r.size, 0);
  const maxSize = Math.max(...top.map(r => r.size));
  const maxDeps = Math.max(...top.map(r => r.depCount));

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.top-deps",
      sortBy,
      totalPackages: results.length,
      totalSize,
      packages: top,
    });
    return;
  }

  printText(`\n\x1b[1mbetter top-deps\x1b[0m — top ${top.length} by ${sortBy} (${results.length} total)\n`);
  printText(`  ${"Package".padEnd(30)} ${"Size".padEnd(10)} ${"Deps".padEnd(6)}  Chart`);
  printText(`  ${"─".repeat(30)} ${"─".repeat(10)} ${"─".repeat(6)}  ${"─".repeat(12)}`);

  for (const r of top) {
    const sizeStr = fmtBytes(r.size);
    const depsStr = String(r.depCount);
    const barStr = sortBy === "deps"
      ? `\x1b[36m${bar(r.depCount, maxDeps)}\x1b[0m`
      : `\x1b[36m${bar(r.size, maxSize)}\x1b[0m`;
    printText(`  \x1b[1m${r.name.padEnd(30)}\x1b[0m ${sizeStr.padEnd(10)} ${depsStr.padEnd(6)}  ${barStr}`);
  }

  printText(`\n  \x1b[90mTotal node_modules size shown: ${fmtBytes(results.reduce((s, r) => s + r.size, 0))}\x1b[0m`);
  printText(`  \x1b[90mTop ${top.length} account for ${fmtBytes(top.reduce((s, r) => s + r.size, 0))} (${((top.reduce((s, r) => s + r.size, 0) / totalSize) * 100).toFixed(0)}%)\x1b[0m`);
  printText("");
}
