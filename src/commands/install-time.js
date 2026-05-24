/**
 * better install-time — estimate npm install time based on dependency count
 *
 * Analyzes your dependency tree to estimate install times, identifies
 * the heaviest packages contributing to install time, and suggests
 * optimizations to speed up CI and developer installs.
 *
 * Usage:
 *   better install-time
 *   better install-time --json
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
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) return;
      if (e.isDirectory()) {
        total += await getDirSize(full);
      } else if (e.isFile()) {
        try { total += (await fs.stat(full)).size; } catch {}
      }
    }));
  } catch {}
  return total;
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function fmtTime(ms) {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}min`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Rough install time model based on package size and count
// Based on empirical npm install benchmarks
function estimateInstallTime(totalSizeMB, pkgCount) {
  // Network: ~5MB/s on typical CI (100Mbps limited by registry)
  const networkMs = (totalSizeMB / 5) * 1000;
  // Extraction: ~50MB/s
  const extractMs = (totalSizeMB / 50) * 1000;
  // Package resolution overhead: ~10ms per package
  const resolutionMs = pkgCount * 10;
  return Math.round(networkMs + extractMs + resolutionMs);
}

export async function cmdInstallTime(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      top:   { type: "string", default: "10" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better install-time [options]

Estimate npm install time and find optimization opportunities.

Options:
  --top <n>    Show top N heaviest packages (default: 10)
  --json       Machine-readable output
  -h, --help   Show this help

Shows:
  • Estimated install time (fresh + cached)
  • Top packages by size
  • node_modules total size and package count
  • Suggestions for reducing install time
`);
    return;
  }

  const topN = parseInt(values.top, 10) || 10;

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter install-time\x1b[0m\n`);
    process.stderr.write(`\x1b[90mAnalyzing node_modules...\x1b[0m\n`);
  }

  // Get all top-level packages
  let pkgDirs = [];
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name.startsWith("@")) {
        const scopeDir = path.join(nmPath, e.name);
        try {
          const scoped = await fs.readdir(scopeDir, { withFileTypes: true });
          for (const s of scoped) {
            if (s.isDirectory() || s.isSymbolicLink()) pkgDirs.push(path.join(scopeDir, s.name));
          }
        } catch {}
      } else {
        pkgDirs.push(path.join(nmPath, e.name));
      }
    }
  } catch {
    const msg = "Cannot read node_modules";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // Measure sizes in batches
  const packages = [];
  const BATCH = 8;
  for (let i = 0; i < pkgDirs.length; i += BATCH) {
    const batch = pkgDirs.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dir) => {
      const size = await getDirSize(dir);
      const pkgName = dir.replace(nmPath + path.sep, "");
      packages.push({ name: pkgName, size, dir });
    }));
  }

  packages.sort((a, b) => b.size - a.size);

  const totalSize = packages.reduce((s, p) => s + p.size, 0);
  const totalSizeMB = totalSize / 1024 / 1024;
  const pkgCount = packages.length;

  const freshEstimate = estimateInstallTime(totalSizeMB, pkgCount);
  const cachedEstimate = Math.round(freshEstimate * 0.3); // cache reduces ~70% of network time

  // Check for optimizations
  const suggestions = [];
  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  if (!pkgJson.scripts?.["ci"] && pkgJson.packageManager?.startsWith("npm")) {
    suggestions.push("Use `npm ci` instead of `npm install` in CI for faster, reproducible installs");
  }
  if (pkgJson.devDependencies && Object.keys(pkgJson.devDependencies).length > 0) {
    suggestions.push("Use `npm ci --omit=dev` in production deployments");
  }
  if (totalSizeMB > 500) {
    suggestions.push(`node_modules is ${fmtBytes(totalSize)} — consider reviewing large packages`);
  }

  const top = packages.slice(0, topN);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.install-time",
      packageCount: pkgCount,
      totalSize,
      freshEstimateMs: freshEstimate,
      cachedEstimateMs: cachedEstimate,
      topPackages: top.map(p => ({ name: p.name, size: p.size })),
      suggestions,
    });
    return;
  }

  printText(`  Packages: ${pkgCount}  |  Total size: ${fmtBytes(totalSize)}\n`);
  printText(`  \x1b[1mEstimated install time:\x1b[0m`);
  printText(`    Fresh (no cache):  \x1b[33m${fmtTime(freshEstimate)}\x1b[0m`);
  printText(`    With npm cache:    \x1b[32m${fmtTime(cachedEstimate)}\x1b[0m`);
  printText("");

  printText(`\x1b[1mTop ${Math.min(topN, top.length)} packages by size:\x1b[0m`);
  for (const p of top) {
    const pct = ((p.size / totalSize) * 100).toFixed(1);
    const barLen = Math.round((p.size / (packages[0]?.size || 1)) * 20);
    const bar = "█".repeat(barLen) + "░".repeat(20 - barLen);
    const color = p.size > 50 * 1024 * 1024 ? "\x1b[31m" : p.size > 10 * 1024 * 1024 ? "\x1b[33m" : "\x1b[90m";
    printText(`  ${color}${bar}\x1b[0m  ${p.name.padEnd(30)}  ${fmtBytes(p.size).padStart(8)}  \x1b[90m${pct}%\x1b[0m`);
  }

  if (suggestions.length > 0) {
    printText(`\n\x1b[1mOptimization suggestions:\x1b[0m`);
    for (const s of suggestions) {
      printText(`  \x1b[36m→\x1b[0m  ${s}`);
    }
  }
  printText("");
}
