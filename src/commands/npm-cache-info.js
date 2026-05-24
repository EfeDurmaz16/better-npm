/**
 * better npm-cache-info — inspect and manage the npm cache
 *
 * Shows npm cache location, size, and count of cached packages.
 * Supports cache verification and cleanup.
 *
 * Usage:
 *   better npm-cache-info
 *   better npm-cache-info --verify
 *   better npm-cache-info --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000 });
  return { ok: r.status === 0, output: (r.stdout || "").trim() };
}

function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

async function getDirInfo(dir) {
  let totalSize = 0;
  let fileCount = 0;
  let dirCount = 0;
  async function walk(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        dirCount++;
        await walk(full);
      } else if (e.isFile()) {
        fileCount++;
        try { totalSize += (await fs.stat(full)).size; } catch {}
      }
    }
  }
  await walk(dir);
  return { totalSize, fileCount, dirCount };
}

export async function cmdNpmCacheInfo(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      verify:  { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better npm-cache-info [options]

Inspect npm cache usage.

Options:
  --verify     Run npm cache verify to check integrity
  --json       Machine-readable output
  -h, --help   Show this help

Shows:
  • Cache location and total size
  • Cached package count
  • Cache integrity (with --verify)
`);
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter npm-cache-info\x1b[0m\n`);
    process.stderr.write(`\x1b[90mAnalyzing npm cache...\x1b[0m\n`);
  }

  const cacheDir = run("npm", ["config", "get", "cache"]);
  if (!cacheDir.ok || !cacheDir.output) {
    const msg = "Cannot determine npm cache directory";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const cachePath = cacheDir.output;
  let dirInfo = { totalSize: 0, fileCount: 0, dirCount: 0 };
  let cacheExists = true;
  try {
    await fs.access(cachePath);
    dirInfo = await getDirInfo(cachePath);
  } catch {
    cacheExists = false;
  }

  // Count cached tarballs in content-v2
  let cachedPkgs = 0;
  const contentDir = path.join(cachePath, "content-v2", "sha512");
  try {
    const top = await fs.readdir(contentDir);
    for (const d1 of top) {
      try {
        const d2s = await fs.readdir(path.join(contentDir, d1));
        for (const d2 of d2s) {
          try {
            const files = await fs.readdir(path.join(contentDir, d1, d2));
            cachedPkgs += files.length;
          } catch {}
        }
      } catch {}
    }
  } catch {}

  let verifyResult = null;
  if (values.verify) {
    process.stderr.write(`\x1b[90mRunning npm cache verify...\x1b[0m\n`);
    const vr = run("npm", ["cache", "verify"]);
    verifyResult = { ok: vr.ok, output: vr.output };
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.npm-cache-info",
      cachePath,
      cacheExists,
      totalSize: dirInfo.totalSize,
      fileCount: dirInfo.fileCount,
      cachedPackages: cachedPkgs,
      verifyResult,
    });
    return;
  }

  printText(`  Cache directory: \x1b[1m${cachePath}\x1b[0m`);
  if (!cacheExists) {
    printText(`  \x1b[90mCache directory does not exist (empty cache)\x1b[0m`);
  } else {
    printText(`  Total size:     ${fmtBytes(dirInfo.totalSize)}`);
    printText(`  Files:          ${dirInfo.fileCount.toLocaleString()}`);
    if (cachedPkgs > 0) printText(`  Cached tarballs: ${cachedPkgs.toLocaleString()}`);
  }

  if (verifyResult) {
    printText("");
    if (verifyResult.ok) {
      printText(`\x1b[32m✔ Cache integrity verified.\x1b[0m`);
    } else {
      printText(`\x1b[33m⚠ Cache verify output:\x1b[0m`);
      for (const line of verifyResult.output.split("\n").slice(0, 10)) {
        if (line.trim()) printText(`  \x1b[90m${line}\x1b[0m`);
      }
    }
  }

  printText("");
  printText(`  \x1b[90mTo clear cache: npm cache clean --force\x1b[0m`);
  printText("");
}
