/**
 * better build-diff — compare build output before and after changes
 *
 * Captures a snapshot of build output (file sizes, counts) and compares
 * it to the current state, helping detect unexpected bundle size changes.
 *
 * Usage:
 *   better build-diff --snapshot        Save current build as baseline
 *   better build-diff                   Compare to saved baseline
 *   better build-diff --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function fmtDiff(diff) {
  if (diff > 0) return `\x1b[31m+${fmtBytes(diff)}\x1b[0m`;
  if (diff < 0) return `\x1b[32m-${fmtBytes(Math.abs(diff))}\x1b[0m`;
  return `\x1b[90m=\x1b[0m`;
}

async function captureSnapshot(dir) {
  const files = {};
  async function walk(d, rel = "") {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await walk(full, relPath);
      } else if (e.isFile()) {
        try { files[relPath] = (await fs.stat(full)).size; } catch {}
      }
    }
  }
  await walk(dir);
  return files;
}

export async function cmdBuildDiff(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:      { type: "boolean", default: runtime.json === true },
      help:      { type: "boolean", short: "h", default: false },
      snapshot:  { type: "boolean", default: false },
      dir:       { type: "string", default: "dist" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better build-diff [options]

Compare build output before and after changes.

Options:
  --snapshot     Save current build as baseline
  --dir <d>      Build directory to monitor (default: dist)
  --json         Machine-readable output
  -h, --help     Show this help

Workflow:
  1. better build-diff --snapshot    (before changes)
  2. make changes and rebuild
  3. better build-diff               (shows size differences)
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const buildDir = path.resolve(projectRoot, values.dir);
  const snapshotPath = path.join(projectRoot, ".better-build-snapshot.json");

  // Check build dir exists
  try { await fs.access(buildDir); } catch {
    const msg = `Build directory not found: ${values.dir}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter build-diff\x1b[0m  (${values.dir}/)\n`);
  }

  const current = await captureSnapshot(buildDir);
  const currentTotal = Object.values(current).reduce((s, n) => s + n, 0);

  if (values.snapshot) {
    await fs.writeFile(snapshotPath, JSON.stringify({ dir: values.dir, files: current, total: currentTotal, timestamp: new Date().toISOString() }, null, 2), "utf8");
    if (values.json) {
      printJson({ ok: true, kind: "better.build-diff", action: "snapshot", files: Object.keys(current).length, total: currentTotal });
    } else {
      printText(`\x1b[32m✔ Snapshot saved (${Object.keys(current).length} files, ${fmtBytes(currentTotal)})\x1b[0m\n`);
    }
    return;
  }

  // Load baseline
  let baseline;
  try {
    baseline = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  } catch {
    const msg = "No baseline snapshot found. Run with --snapshot first.";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m\n`); }
    process.exitCode = 1;
    return;
  }

  const baseFiles = baseline.files;
  const baseTotal = baseline.total;

  // Compare
  const allFiles = new Set([...Object.keys(current), ...Object.keys(baseFiles)]);
  const diffs = [];
  for (const file of [...allFiles].sort()) {
    const before = baseFiles[file] ?? null;
    const after = current[file] ?? null;
    if (before === after) continue;
    diffs.push({ file, before, after, diff: (after || 0) - (before || 0), type: before === null ? "added" : after === null ? "removed" : "changed" });
  }

  const totalDiff = currentTotal - baseTotal;

  if (values.json) {
    printJson({ ok: true, kind: "better.build-diff", baseline: { total: baseTotal, files: Object.keys(baseFiles).length }, current: { total: currentTotal, files: Object.keys(current).length }, totalDiff, diffs });
    return;
  }

  const diffColor = totalDiff > 0 ? "\x1b[31m" : totalDiff < 0 ? "\x1b[32m" : "\x1b[90m";
  const sign = totalDiff > 0 ? "+" : "";
  printText(`  Total: ${fmtBytes(baseTotal)} → ${fmtBytes(currentTotal)}  (${diffColor}${sign}${fmtBytes(Math.abs(totalDiff))}\x1b[0m)\n`);

  if (diffs.length === 0) {
    printText(`\x1b[32m✔ No changes in build output.\x1b[0m`);
  } else {
    for (const d of diffs) {
      const typeIcon = d.type === "added" ? "\x1b[32m+\x1b[0m" : d.type === "removed" ? "\x1b[31m-\x1b[0m" : "\x1b[33m~\x1b[0m";
      const beforeStr = d.before !== null ? fmtBytes(d.before) : "(new)";
      const afterStr = d.after !== null ? fmtBytes(d.after) : "(removed)";
      const diffStr = d.type === "changed" ? `  ${fmtDiff(d.diff)}` : "";
      printText(`  ${typeIcon}  ${d.file.padEnd(40)}  ${beforeStr} → ${afterStr}${diffStr}`);
    }
  }
  printText("");
}
