/**
 * better duplicate-files — find duplicate files in node_modules
 *
 * Detects packages that ship identical files across multiple installs,
 * helping identify deduplication opportunities and wasted disk space.
 *
 * Usage:
 *   better duplicate-files
 *   better duplicate-files --min-size 10kb
 *   better duplicate-files --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parseSize(s) {
  if (!s) return 0;
  const m = String(s).toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(gb|mb|kb|b)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case "gb": return Math.round(n * 1024 * 1024 * 1024);
    case "mb": return Math.round(n * 1024 * 1024);
    case "kb": return Math.round(n * 1024);
    default:   return Math.round(n);
  }
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

async function hashFile(filePath) {
  try {
    const data = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
}

async function scanDir(dir, minSize, results, depth = 0) {
  if (depth > 3) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymlink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === ".cache") continue;
      await scanDir(full, minSize, results, depth + 1);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full);
        if (stat.size >= minSize) {
          results.push({ path: full, size: stat.size });
        }
      } catch {}
    }
  }
}

export async function cmdDuplicateFiles(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      "min-size": { type: "string", default: "1kb" },
      top:        { type: "string", default: "10" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better duplicate-files [options]

Find duplicate files across node_modules packages.

Options:
  --min-size <s>   Minimum file size to check (default: 1kb)
  --top <n>        Show top N duplicate groups (default: 10)
  --json           Machine-readable output
  -h, --help       Show this help

Detects files with identical content across different packages,
which may indicate deduplication opportunities.
`);
    return;
  }

  const minSize = parseSize(values["min-size"]) || 1024;
  const topN = parseInt(values.top, 10) || 10;

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter duplicate-files\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning node_modules for duplicate files (min size: ${fmtBytes(minSize)})...\x1b[0m\n`);
  }

  // Collect top-level packages first
  let topPkgs = [];
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() || e.isSymlink()) {
        if (e.name.startsWith("@")) {
          // scoped packages
          const scopeDir = path.join(nmPath, e.name);
          try {
            const scoped = await fs.readdir(scopeDir, { withFileTypes: true });
            for (const s of scoped) {
              if (s.isDirectory()) topPkgs.push(path.join(scopeDir, s.name));
            }
          } catch {}
        } else {
          topPkgs.push(path.join(nmPath, e.name));
        }
      }
    }
  } catch {
    const msg = "Cannot read node_modules";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // Scan files from each package (limit to avoid too long scan)
  const allFiles = [];
  const BATCH = 10;
  for (let i = 0; i < Math.min(topPkgs.length, 200); i += BATCH) {
    const batch = topPkgs.slice(i, i + BATCH);
    await Promise.all(batch.map(async (pkgDir) => {
      const pkgFiles = [];
      await scanDir(pkgDir, minSize, pkgFiles, 0);
      allFiles.push(...pkgFiles);
    }));
  }

  // Group by size first (quick filter)
  const bySize = new Map();
  for (const f of allFiles) {
    const key = f.size;
    if (!bySize.has(key)) bySize.set(key, []);
    bySize.get(key).push(f);
  }

  // Only hash files where size matches
  const candidates = [...bySize.values()].filter(g => g.length > 1);
  const byHash = new Map();

  for (const group of candidates) {
    const HBATCH = 8;
    for (let i = 0; i < group.length; i += HBATCH) {
      const batch = group.slice(i, i + HBATCH);
      await Promise.all(batch.map(async (f) => {
        const hash = await hashFile(f.path);
        if (hash) {
          if (!byHash.has(hash)) byHash.set(hash, []);
          byHash.get(hash).push(f);
        }
      }));
    }
  }

  // Filter to actual duplicates
  const duplicateGroups = [...byHash.values()]
    .filter(g => g.length > 1)
    .sort((a, b) => (b.length * b[0].size) - (a.length * a[0].size))
    .slice(0, topN);

  const totalWasted = duplicateGroups.reduce((sum, g) => sum + g[0].size * (g.length - 1), 0);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.duplicate-files",
      totalGroups: duplicateGroups.length,
      totalWasted,
      groups: duplicateGroups.map(g => ({
        hash: byHash.entries ? undefined : undefined,
        size: g[0].size,
        count: g.length,
        wasted: g[0].size * (g.length - 1),
        files: g.map(f => f.path),
      })),
    });
    return;
  }

  if (duplicateGroups.length === 0) {
    printText(`\x1b[32m✔ No duplicate files found above ${fmtBytes(minSize)}.\x1b[0m`);
    printText("");
    return;
  }

  printText(`  Found ${duplicateGroups.length} duplicate group(s)  |  Potential savings: \x1b[33m${fmtBytes(totalWasted)}\x1b[0m\n`);

  for (const group of duplicateGroups) {
    const wasted = group[0].size * (group.length - 1);
    printText(`  \x1b[33m⚠\x1b[0m  ${fmtBytes(group[0].size)} × ${group.length} copies  \x1b[90m(${fmtBytes(wasted)} wasted)\x1b[0m`);
    for (const f of group) {
      const rel = path.relative(nmPath, f.path);
      printText(`       \x1b[90m${rel}\x1b[0m`);
    }
    printText("");
  }

  printText(`  \x1b[90mRun \`npm dedupe\` to reduce duplication.\x1b[0m`);
  printText("");
}
