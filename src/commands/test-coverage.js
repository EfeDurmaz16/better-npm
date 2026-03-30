/**
 * better test-coverage — check and enforce test coverage thresholds
 *
 * Reads existing coverage reports (lcov/json) from common coverage
 * output directories and checks them against configurable thresholds.
 * Supports Jest, Vitest, nyc/c8, and Istanbul output.
 *
 * Usage:
 *   better test-coverage
 *   better test-coverage --threshold 80
 *   better test-coverage --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const DEFAULT_THRESHOLD = 80;

// Common locations for coverage summary JSON
const COVERAGE_PATHS = [
  "coverage/coverage-summary.json",
  "coverage/coverage-final.json",
  ".nyc_output/coverage-summary.json",
  "coverage-report/coverage-summary.json",
];

async function findCoverageJson(projectRoot) {
  for (const rel of COVERAGE_PATHS) {
    const p = path.join(projectRoot, rel);
    try {
      const content = await fs.readFile(p, "utf8");
      const data = JSON.parse(content);
      return { path: p, data };
    } catch {}
  }
  return null;
}

function parseCoverageSummary(data) {
  // Jest/Vitest coverage-summary.json format: { total: { lines: { pct }, ... }, ... }
  if (data.total) {
    const t = data.total;
    return {
      lines:      t.lines?.pct ?? null,
      statements: t.statements?.pct ?? null,
      functions:  t.functions?.pct ?? null,
      branches:   t.branches?.pct ?? null,
      fileCount:  Object.keys(data).filter(k => k !== "total").length,
    };
  }

  // nyc coverage-final.json — compute aggregate
  const files = Object.values(data);
  if (!files.length || !files[0].s) return null;

  function sumCov(map) {
    const vals = Object.values(map);
    const total = vals.length;
    const covered = vals.filter(v => v > 0).length;
    return total === 0 ? 100 : (covered / total) * 100;
  }

  const lines = files.map(f => sumCov(f.l || {}));
  const stmts = files.map(f => sumCov(f.s || {}));
  const fns   = files.map(f => sumCov(f.f || {}));
  const brs   = files.map(f => sumCov(f.b || {}));

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    lines:      avg(lines),
    statements: avg(stmts),
    functions:  avg(fns),
    branches:   avg(brs),
    fileCount:  files.length,
  };
}

function colorPct(pct, threshold) {
  if (pct === null) return "\x1b[90m—\x1b[0m";
  const str = `${pct.toFixed(1)}%`;
  if (pct >= threshold) return `\x1b[32m${str}\x1b[0m`;
  if (pct >= threshold - 10) return `\x1b[33m${str}\x1b[0m`;
  return `\x1b[31m${str}\x1b[0m`;
}

export async function cmdTestCoverage(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:      { type: "boolean", default: runtime.json === true },
      help:      { type: "boolean", short: "h", default: false },
      threshold: { type: "string", default: String(DEFAULT_THRESHOLD) },
      "fail-under": { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better test-coverage [options]

Check test coverage from existing coverage reports.

Reads coverage from:
  coverage/coverage-summary.json (Jest/Vitest)
  .nyc_output/coverage-summary.json (nyc)
  coverage/coverage-final.json (Istanbul/c8)

Options:
  --threshold <n>    Minimum coverage percentage (default: ${DEFAULT_THRESHOLD})
  --fail-under <n>   Alias for --threshold
  --json             Machine-readable output
  -h, --help         Show this help

Examples:
  better test-coverage
  better test-coverage --threshold 90
`);
    return;
  }

  const threshold = parseFloat(values["fail-under"] || values.threshold) || DEFAULT_THRESHOLD;

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const found = await findCoverageJson(projectRoot);

  if (!found) {
    const msg = "No coverage report found. Run your test suite with coverage first (e.g. jest --coverage or vitest run --coverage).";
    if (values.json) {
      printJson({ ok: false, kind: "better.test-coverage", error: msg });
    } else {
      printText(`\n\x1b[1mbetter test-coverage\x1b[0m\n\n\x1b[33m⚠ ${msg}\x1b[0m\n`);
      printText(`\x1b[90mLooked for:\x1b[0m`);
      for (const p of COVERAGE_PATHS) printText(`  \x1b[90m${p}\x1b[0m`);
    }
    process.exitCode = 1;
    return;
  }

  const summary = parseCoverageSummary(found.data);

  if (!summary) {
    const msg = "Could not parse coverage report format";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const metrics = [
    { name: "Lines",      value: summary.lines },
    { name: "Statements", value: summary.statements },
    { name: "Functions",  value: summary.functions },
    { name: "Branches",   value: summary.branches },
  ].filter(m => m.value !== null);

  const failed = metrics.filter(m => m.value < threshold);
  const allOk = failed.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.test-coverage",
      threshold,
      reportPath: found.path,
      fileCount: summary.fileCount,
      coverage: {
        lines:      summary.lines,
        statements: summary.statements,
        functions:  summary.functions,
        branches:   summary.branches,
      },
      failing: failed.map(m => m.name.toLowerCase()),
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter test-coverage\x1b[0m  (threshold: ${threshold}%)\n`);
  printText(`\x1b[90mReport: ${path.relative(process.cwd(), found.path)}\x1b[0m`);
  printText(`\x1b[90mFiles:  ${summary.fileCount}\x1b[0m\n`);

  for (const m of metrics) {
    const icon = m.value >= threshold ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    printText(`  ${icon}  ${m.name.padEnd(12)}  ${colorPct(m.value, threshold)}`);
  }

  printText("");
  if (allOk) {
    printText(`\x1b[32m✔ All coverage thresholds met.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${failed.length} metric(s) below ${threshold}% threshold: ${failed.map(m => m.name).join(", ")}\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
