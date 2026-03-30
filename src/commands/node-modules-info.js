/**
 * better node-modules-info — detailed node_modules analysis
 *
 * Reports node_modules directory statistics: total size, package count,
 * deepest nesting, largest packages, and symlink count.
 *
 * Usage:
 *   better node-modules-info
 *   better node-modules-info --top 20
 *   better node-modules-info --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function bar(fraction, width = 20) {
  const filled = Math.round(fraction * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function getDirSizeAndCount(dirPath) {
  let size = 0;
  let fileCount = 0;
  let maxDepth = 0;
  async function walk(p, depth) {
    if (depth > 10) return;
    maxDepth = Math.max(maxDepth, depth);
    let entries;
    try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isSymbolicLink()) {
        fileCount++;
      } else if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        try { const st = await fs.stat(full); size += st.size; fileCount++; } catch {}
      }
    }
  }
  await walk(dirPath, 0);
  return { size, fileCount, maxDepth };
}

async function getTopPackages(nmPath, topN) {
  const pkgs = [];
  let entries;
  try { entries = await fs.readdir(nmPath, { withFileTypes: true }); } catch { return pkgs; }

  const BATCH = 8;
  const toProcess = [];

  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      if (e.name.startsWith("@")) {
        // Scoped packages
        let subEntries;
        try { subEntries = await fs.readdir(path.join(nmPath, e.name), { withFileTypes: true }); } catch { continue; }
        for (const sub of subEntries) {
          if (sub.isDirectory()) {
            toProcess.push({ name: `${e.name}/${sub.name}`, dir: path.join(nmPath, e.name, sub.name) });
          }
        }
      } else {
        toProcess.push({ name: e.name, dir: path.join(nmPath, e.name) });
      }
    }
  }

  for (let i = 0; i < toProcess.length; i += BATCH) {
    const batch = toProcess.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async ({ name, dir }) => {
      const { size } = await getDirSizeAndCount(dir);
      let version = "?";
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
        version = pkg.version || "?";
      } catch {}
      return { name, size, version };
    }));
    pkgs.push(...results);
  }

  return pkgs.sort((a, b) => b.size - a.size).slice(0, topN);
}

export async function cmdNodeModulesInfo(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      top:   { type: "string", default: "15" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better node-modules-info [options]

Show detailed statistics about the node_modules directory.

Options:
  --top <n>    Show top N packages by size (default: 15)
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");
  const topN = Math.max(5, Math.min(50, parseInt(values.top) || 15));

  try { await fs.access(nmPath); } catch {
    const msg = "node_modules not found — run npm install first";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter node-modules-info\x1b[0m\n`);
    process.stderr.write(`\x1b[90mAnalyzing node_modules…\x1b[0m\n`);
  }

  const [{ size: totalSize, fileCount, maxDepth }, topPkgs] = await Promise.all([
    getDirSizeAndCount(nmPath),
    getTopPackages(nmPath, topN),
  ]);

  // Count direct (top-level) packages
  let directCount = 0;
  let symlinkCount = 0;
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === ".bin") continue;
      if (e.isSymbolicLink()) symlinkCount++;
      else if (e.isDirectory()) {
        if (e.name.startsWith("@")) {
          try {
            const sub = await fs.readdir(path.join(nmPath, e.name));
            directCount += sub.length;
          } catch {}
        } else {
          directCount++;
        }
      }
    }
  } catch {}

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.node-modules-info",
      totalSize,
      fileCount,
      directPackages: directCount,
      maxDepth,
      symlinkCount,
      topPackages: topPkgs,
    });
    return;
  }

  printText(`  Total size:       ${fmtBytes(totalSize)}`);
  printText(`  Total files:      ${fileCount.toLocaleString()}`);
  printText(`  Direct packages:  ${directCount}`);
  printText(`  Max depth:        ${maxDepth}`);
  if (symlinkCount > 0) printText(`  Symlinks:         ${symlinkCount}`);

  if (topPkgs.length > 0) {
    const maxSize = topPkgs[0].size;
    printText(`\n\x1b[90mTop ${topPkgs.length} packages by size:\x1b[0m`);
    for (const pkg of topPkgs) {
      const frac = maxSize > 0 ? pkg.size / maxSize : 0;
      const b = bar(frac, 15);
      const pct = totalSize > 0 ? `${(pkg.size / totalSize * 100).toFixed(1)}%` : "?%";
      printText(`  \x1b[90m${b}\x1b[0m  ${pct.padStart(5)}  ${fmtBytes(pkg.size).padStart(10)}  ${pkg.name}@${pkg.version}`);
    }
  }
  printText("");
}
