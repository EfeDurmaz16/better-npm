/**
 * better package-size-map — visualize node_modules size as a treemap
 *
 * Shows a ASCII treemap visualization of node_modules sizes to
 * quickly identify which packages dominate disk usage.
 *
 * Usage:
 *   better package-size-map
 *   better package-size-map --depth 2
 *   better package-size-map --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${n}B`;
}

async function getDirSize(dir) {
  let size = 0;
  async function walk(p) {
    let entries;
    try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) { try { const st = await fs.stat(full); size += st.size; } catch {} }
    }
  }
  await walk(dir);
  return size;
}

function renderTreemap(items, totalSize, width = 60) {
  const lines = [];
  const maxSize = items[0]?.size || 1;

  for (const item of items) {
    const fraction = item.size / totalSize;
    const pct = (fraction * 100).toFixed(1);
    const barLen = Math.round(fraction * width);
    const bar = "█".repeat(barLen) + "░".repeat(Math.max(0, width - barLen));

    const sizeStr = fmtBytes(item.size).padStart(6);
    const pctStr = `${pct}%`.padStart(6);
    const name = item.name.length > 30 ? item.name.slice(0, 27) + "..." : item.name;

    lines.push(`  \x1b[${item.size > totalSize * 0.1 ? "31" : item.size > totalSize * 0.05 ? "33" : "90"}m${bar.slice(0, Math.min(barLen, 30))}\x1b[0m ${sizeStr}  ${pctStr}  ${name}`);
  }
  return lines;
}

export async function cmdPackageSizeMap(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      top:   { type: "string", default: "25" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better package-size-map [options]

Visualize node_modules disk usage as an ASCII size map.

Options:
  --top <n>    Show top N packages (default: 25)
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  try { await fs.access(nmPath); } catch {
    const msg = "node_modules not found";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const topN = Math.max(5, Math.min(100, parseInt(values.top) || 25));

  if (!values.json) {
    printText(`\n\x1b[1mbetter package-size-map\x1b[0m\n`);
    process.stderr.write(`\x1b[90mMeasuring package sizes...\x1b[0m\n`);
  }

  // Get top-level packages
  let entries;
  try { entries = await fs.readdir(nmPath, { withFileTypes: true }); } catch { entries = []; }

  const toMeasure = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (!e.isDirectory()) continue;
    if (e.name.startsWith("@")) {
      let subEntries;
      try { subEntries = await fs.readdir(path.join(nmPath, e.name), { withFileTypes: true }); } catch { continue; }
      for (const sub of subEntries) {
        if (sub.isDirectory()) toMeasure.push({ name: `${e.name}/${sub.name}`, dir: path.join(nmPath, e.name, sub.name) });
      }
    } else {
      toMeasure.push({ name: e.name, dir: path.join(nmPath, e.name) });
    }
  }

  const BATCH = 8;
  const sizes = [];
  for (let i = 0; i < toMeasure.length; i += BATCH) {
    const batch = toMeasure.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async ({ name, dir }) => ({
      name,
      size: await getDirSize(dir),
    })));
    sizes.push(...results);
  }

  sizes.sort((a, b) => b.size - a.size);
  const top = sizes.slice(0, topN);
  const totalSize = sizes.reduce((s, p) => s + p.size, 0);
  const topSize = top.reduce((s, p) => s + p.size, 0);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.package-size-map",
      totalPackages: sizes.length,
      totalSize,
      topPackages: top.map(p => ({ name: p.name, size: p.size, percent: +(p.size / totalSize * 100).toFixed(1) })),
    });
    return;
  }

  printText(`  Total: ${fmtBytes(totalSize)} across ${sizes.length} packages  |  Top ${topN}: ${fmtBytes(topSize)} (${(topSize/totalSize*100).toFixed(0)}%)\n`);

  const lines = renderTreemap(top, totalSize, 30);
  for (const line of lines) printText(line);
  printText("");
}
