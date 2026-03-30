/**
 * better coverage-check — check code coverage thresholds
 *
 * Reads coverage reports (Istanbul/V8 JSON format) and checks
 * whether coverage thresholds are met, providing a summary of
 * coverage by file and overall percentages.
 *
 * Usage:
 *   better coverage-check
 *   better coverage-check --threshold 80
 *   better coverage-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function findCoverageReport(projectRoot) {
  const candidates = [
    "coverage/coverage-summary.json",
    "coverage/coverage-final.json",
    ".nyc_output/processinfo/index.json",
  ];
  for (const f of candidates) {
    try {
      const content = await fs.readFile(path.join(projectRoot, f), "utf8");
      return { path: f, content: JSON.parse(content) };
    } catch {}
  }
  return null;
}

function getCoverageSummary(data) {
  // Istanbul coverage-summary.json format
  if (data.total) {
    return {
      lines: data.total.lines?.pct || 0,
      statements: data.total.statements?.pct || 0,
      functions: data.total.functions?.pct || 0,
      branches: data.total.branches?.pct || 0,
    };
  }
  // Try coverage-final.json - aggregate manually
  let stmtTotal = 0, stmtCovered = 0;
  let lineTotal = 0, lineCovered = 0;
  let fnTotal = 0, fnCovered = 0;
  let branchTotal = 0, branchCovered = 0;

  for (const file of Object.values(data)) {
    if (!file.s) continue;
    const stmts = Object.values(file.s || {});
    stmtTotal += stmts.length;
    stmtCovered += stmts.filter(v => v > 0).length;

    const fns = Object.values(file.f || {});
    fnTotal += fns.length;
    fnCovered += fns.filter(v => v > 0).length;

    const branches = Object.values(file.b || {}).flat();
    branchTotal += branches.length;
    branchCovered += branches.filter(v => v > 0).length;
  }

  return {
    lines: lineTotal > 0 ? Math.round(lineCovered / lineTotal * 100) : 0,
    statements: stmtTotal > 0 ? Math.round(stmtCovered / stmtTotal * 100) : 0,
    functions: fnTotal > 0 ? Math.round(fnCovered / fnTotal * 100) : 0,
    branches: branchTotal > 0 ? Math.round(branchCovered / branchTotal * 100) : 0,
  };
}

function bar(pct, threshold) {
  const width = 20;
  const filled = Math.round(pct / 100 * width);
  const color = pct >= threshold ? "\x1b[32m" : pct >= threshold * 0.9 ? "\x1b[33m" : "\x1b[31m";
  return `${color}${"█".repeat(filled)}${"░".repeat(width - filled)}\x1b[0m`;
}

export async function cmdCoverageCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:      { type: "boolean", default: runtime.json === true },
      help:      { type: "boolean", short: "h", default: false },
      threshold: { type: "string", default: "80" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better coverage-check [options]

Check code coverage against thresholds.

Options:
  --threshold <n>  Minimum coverage % (default: 80)
  --json           Machine-readable output
  -h, --help       Show this help

Reads coverage from:
  • coverage/coverage-summary.json (Istanbul)
  • coverage/coverage-final.json
  
Run tests with coverage first: npm test -- --coverage
`);
    return;
  }

  const threshold = parseFloat(values.threshold) || 80;

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter coverage-check\x1b[0m  (threshold: ${threshold}%)\n`);
  }

  const report = await findCoverageReport(projectRoot);

  if (!report) {
    const msg = "No coverage report found. Run tests with coverage first.";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m\n`); }
    process.exitCode = 1;
    return;
  }

  const summary = getCoverageSummary(report.content);
  const checks = [
    { name: "statements", pct: summary.statements },
    { name: "lines",      pct: summary.lines },
    { name: "functions",  pct: summary.functions },
    { name: "branches",   pct: summary.branches },
  ];

  const allPassing = checks.every(c => c.pct >= threshold);

  if (values.json) {
    printJson({
      ok: allPassing,
      kind: "better.coverage-check",
      threshold,
      reportFile: report.path,
      coverage: summary,
      checks: checks.map(c => ({ ...c, ok: c.pct >= threshold })),
    });
    if (!allPassing) process.exitCode = 1;
    return;
  }

  for (const c of checks) {
    const icon = c.pct >= threshold ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    const b = bar(c.pct, threshold);
    printText(`  ${icon}  ${c.name.padEnd(12)}  ${b}  ${String(c.pct).padStart(3)}%`);
  }

  printText("");
  if (allPassing) {
    printText(`\x1b[32m✔ Coverage meets ${threshold}% threshold.\x1b[0m`);
  } else {
    const failing = checks.filter(c => c.pct < threshold);
    printText(`\x1b[31m✘ Coverage below ${threshold}% threshold: ${failing.map(c => c.name).join(", ")}\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
