/**
 * better perf-budget — enforce performance budgets for dependencies
 *
 * Checks that your project's dependency footprint doesn't exceed
 * defined budgets for install size, pack size, and dep count.
 * Budgets are configured in package.json under "better.budget".
 *
 * Usage:
 *   better perf-budget
 *   better perf-budget --init
 *   better perf-budget --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function parseSize(s) {
  if (!s) return null;
  const m = String(s).toLowerCase().match(/^([\d.]+)\s*(gb|mb|kb|b)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2] || "b";
  if (u === "gb") return Math.round(n * 1024 * 1024 * 1024);
  if (u === "mb") return Math.round(n * 1024 * 1024);
  if (u === "kb") return Math.round(n * 1024);
  return Math.round(n);
}

async function getDirSize(dirPath) {
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
  await walk(dirPath);
  return size;
}

const DEFAULT_BUDGET = {
  installSize: "50MB",
  packSize: "1MB",
  maxDeps: 200,
  maxDevDeps: 500,
};

export async function cmdPerfBudget(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      init:   { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better perf-budget [options]

Enforce performance budgets for your project's dependency footprint.

Options:
  --init       Create default budget config in package.json
  --json       Machine-readable output
  -h, --help   Show this help

Budget config in package.json:
  {
    "better": {
      "budget": {
        "installSize": "50MB",
        "packSize": "1MB",
        "maxDeps": 200,
        "maxDevDeps": 500
      }
    }
  }

Metrics checked:
  • node_modules install size
  • npm pack size (tarball)
  • Production dependency count
  • Dev dependency count
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const pkgJsonPath = path.join(projectRoot, "package.json");

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // --init: write default budget to package.json
  if (values.init) {
    if (!pkgJson.better) pkgJson.better = {};
    pkgJson.better.budget = { ...DEFAULT_BUDGET };
    await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");
    printText(`\x1b[32m✔ Default budget added to package.json under "better.budget"\x1b[0m`);
    printText(`\x1b[90m  Edit the values to match your project's constraints.\x1b[0m`);
    return;
  }

  const budget = pkgJson.better?.budget;
  if (!budget) {
    const msg = 'No budget configured. Run: better perf-budget --init';
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter perf-budget\x1b[0m\n`);
    process.stderr.write(`\x1b[90mMeasuring project footprint…\x1b[0m\n`);
  }

  const checks = [];

  // 1. Install size
  if (budget.installSize) {
    const nmPath = path.join(projectRoot, "node_modules");
    let installSize = null;
    try {
      await fs.access(nmPath);
      installSize = await getDirSize(nmPath);
    } catch {}
    const limit = parseSize(budget.installSize);
    if (installSize !== null && limit !== null) {
      const passed = installSize <= limit;
      checks.push({
        id: "install-size",
        label: "Install size",
        value: installSize,
        limit,
        passed,
        severity: passed ? "ok" : "error",
        display: `${fmtBytes(installSize)} / ${fmtBytes(limit)}`,
      });
    }
  }

  // 2. Pack size
  if (budget.packSize) {
    const packResult = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    let packSize = null;
    try { packSize = JSON.parse(packResult.stdout)?.[0]?.size || null; } catch {}
    const limit = parseSize(budget.packSize);
    if (packSize !== null && limit !== null) {
      const passed = packSize <= limit;
      checks.push({
        id: "pack-size",
        label: "Pack size",
        value: packSize,
        limit,
        passed,
        severity: passed ? "ok" : "error",
        display: `${fmtBytes(packSize)} / ${fmtBytes(limit)}`,
      });
    }
  }

  // 3. Dep count
  if (budget.maxDeps !== undefined) {
    const depCount = Object.keys(pkgJson.dependencies || {}).length;
    const limit = parseInt(budget.maxDeps) || 0;
    const passed = depCount <= limit;
    checks.push({
      id: "dep-count",
      label: "Production deps",
      value: depCount,
      limit,
      passed,
      severity: passed ? "ok" : "error",
      display: `${depCount} / ${limit}`,
    });
  }

  // 4. Dev dep count
  if (budget.maxDevDeps !== undefined) {
    const devDepCount = Object.keys(pkgJson.devDependencies || {}).length;
    const limit = parseInt(budget.maxDevDeps) || 0;
    const passed = devDepCount <= limit;
    checks.push({
      id: "dev-dep-count",
      label: "Dev deps",
      value: devDepCount,
      limit,
      passed,
      severity: passed ? "ok" : "error",
      display: `${devDepCount} / ${limit}`,
    });
  }

  const failed = checks.filter(c => !c.passed);
  const allOk = failed.length === 0;

  if (values.json) {
    printJson({ ok: allOk, kind: "better.perf-budget", checks, failed: failed.length });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\x1b[90m${"─".repeat(50)}\x1b[0m`);
  for (const c of checks) {
    const icon = c.passed ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    const color = c.passed ? "\x1b[32m" : "\x1b[31m";
    printText(`  ${icon}  ${c.label.padEnd(20)} ${color}${c.display}\x1b[0m`);
  }
  printText(`\x1b[90m${"─".repeat(50)}\x1b[0m`);

  printText("");
  if (allOk) {
    printText(`\x1b[32m✔ All performance budgets satisfied.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${failed.length} budget(s) exceeded.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
