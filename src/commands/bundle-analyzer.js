/**
 * better bundle-analyzer — analyze JavaScript bundle sizes
 *
 * Inspects built bundle files (dist/, build/, .next/) to report
 * sizes, identify large files, and flag potential optimizations.
 *
 * Usage:
 *   better bundle-analyzer
 *   better bundle-analyzer --dir dist
 *   better bundle-analyzer --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function bar(fraction, width = 20) {
  const filled = Math.round(fraction * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function scanDir(dirPath, extensions, maxFiles) {
  const files = [];
  async function walk(dir, depth) {
    if (depth > 5 || files.length >= maxFiles * 2) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", "coverage"].includes(entry.name)) {
          await walk(full, depth + 1);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          try {
            const stat = await fs.stat(full);
            files.push({ path: full, size: stat.size, name: entry.name });
          } catch {}
        }
      }
    }
  }
  await walk(dirPath, 0);
  return files;
}

const BUNDLE_DIRS = ["dist", "build", ".next/static", "out", "public/build", "www", "lib"];
const BUNDLE_EXTS = [".js", ".mjs", ".cjs", ".css", ".wasm"];

export async function cmdBundleAnalyzer(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      dir:   { type: "string", default: "" },
      top:   { type: "string", default: "20" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better bundle-analyzer [options]

Analyze JavaScript/CSS bundle sizes in your build output.

Options:
  --dir <path>    Directory to scan (default: auto-detect dist/build/.next)
  --top <n>       Show top N files by size (default: 20)
  --json          Machine-readable output
  -h, --help      Show this help

Examples:
  better bundle-analyzer
  better bundle-analyzer --dir dist
  better bundle-analyzer --top 10
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const topN = Math.max(5, Math.min(100, parseInt(values.top) || 20));

  if (!values.json) {
    printText(`\n\x1b[1mbetter bundle-analyzer\x1b[0m\n`);
  }

  // Find bundle directory
  let bundleDir = values.dir ? path.resolve(cwd, values.dir) : null;
  let foundDir = null;

  if (bundleDir) {
    try { await fs.access(bundleDir); foundDir = bundleDir; } catch {
      const msg = `Directory not found: ${bundleDir}`;
      if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
      process.exitCode = 1;
      return;
    }
  } else {
    for (const dir of BUNDLE_DIRS) {
      const candidate = path.join(projectRoot, dir);
      try { await fs.access(candidate); foundDir = candidate; break; } catch {}
    }
  }

  if (!foundDir) {
    const msg = `No build output found. Checked: ${BUNDLE_DIRS.join(", ")}`;
    if (values.json) { printJson({ ok: false, error: msg, hint: "Run your build first (e.g., npm run build)" }); }
    else { printText(`\x1b[33m⚠ ${msg}\x1b[0m\n  \x1b[90mRun your build first: npm run build\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mScanning ${path.relative(projectRoot, foundDir) || foundDir}…\x1b[0m\n`);
  }

  const allFiles = await scanDir(foundDir, BUNDLE_EXTS, 500);
  allFiles.sort((a, b) => b.size - a.size);

  const totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
  const jsSizeTotal = allFiles.filter(f => [".js", ".mjs", ".cjs"].includes(path.extname(f.name))).reduce((s, f) => s + f.size, 0);
  const cssSizeTotal = allFiles.filter(f => f.name.endsWith(".css")).reduce((s, f) => s + f.size, 0);

  const top = allFiles.slice(0, topN);
  const largestFile = allFiles[0];

  // Detect potential issues
  const issues = [];
  if (largestFile?.size > 1024 * 1024) {
    issues.push({ severity: "warning", message: `Largest file is ${fmtBytes(largestFile.size)} — consider code splitting`, file: path.relative(foundDir, largestFile.path) });
  }
  if (jsSizeTotal > 5 * 1024 * 1024) {
    issues.push({ severity: "warning", message: `Total JS size is ${fmtBytes(jsSizeTotal)} — may affect load performance` });
  }
  const unminfied = allFiles.filter(f => !f.name.includes(".min.") && [".js", ".mjs"].includes(path.extname(f.name)) && f.size > 100 * 1024);
  if (unminfied.length > 0) {
    issues.push({ severity: "info", message: `${unminfied.length} large JS file(s) appear unminified (no .min. in name)` });
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.bundle-analyzer",
      dir: foundDir,
      totalFiles: allFiles.length,
      totalSize,
      jsSizeTotal,
      cssSizeTotal,
      topFiles: top.map(f => ({ path: path.relative(foundDir, f.path), size: f.size })),
      issues,
    });
    return;
  }

  printText(`  Dir:    ${path.relative(projectRoot, foundDir) || foundDir}`);
  printText(`  Files:  ${allFiles.length}  (${BUNDLE_EXTS.join(", ")})`);
  printText(`  JS:     ${fmtBytes(jsSizeTotal)}  CSS: ${fmtBytes(cssSizeTotal)}  Total: ${fmtBytes(totalSize)}\n`);

  printText(`\x1b[90mTop ${Math.min(topN, top.length)} files by size:\x1b[0m`);
  for (const f of top) {
    const rel = path.relative(foundDir, f.path);
    const fraction = totalSize > 0 ? f.size / totalSize : 0;
    const pct = (fraction * 100).toFixed(1);
    const b = bar(fraction, 15);
    printText(`  \x1b[90m${b}\x1b[0m  ${pct.padStart(5)}%  ${fmtBytes(f.size).padStart(10)}  ${rel}`);
  }

  if (issues.length > 0) {
    printText("");
    for (const iss of issues) {
      const icon = iss.severity === "warning" ? "\x1b[33m⚠\x1b[0m" : "\x1b[90m·\x1b[0m";
      printText(`  ${icon}  ${iss.message}`);
      if (iss.file) printText(`       \x1b[90m${iss.file}\x1b[0m`);
    }
  }
  printText("");
}
