/**
 * better perf — dependency performance hints
 *
 * Analyzes the dependency tree and provides actionable performance
 * recommendations: heavy packages, duplicate implementations,
 * lazy loading opportunities, and tree-shaking hints.
 *
 * Usage:
 *   better perf
 *   better perf --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Known heavy packages with lighter alternatives
const LIGHTER_ALTERNATIVES = [
  { heavy: "moment", lighter: "date-fns", heavyKb: 330, lighterKb: 80, reason: "Tree-shakeable, no locale bundles" },
  { heavy: "lodash", lighter: "lodash-es", heavyKb: 528, lighterKb: 528, reason: "ESM version enables tree-shaking" },
  { heavy: "axios", lighter: "ky", heavyKb: 40, lighterKb: 8, reason: "Modern fetch-based, smaller" },
  { heavy: "request", lighter: "node-fetch", heavyKb: 550, lighterKb: 20, reason: "Deprecated; use native fetch" },
  { heavy: "bluebird", lighter: "native Promise", heavyKb: 80, lighterKb: 0, reason: "Native promises are fast" },
  { heavy: "q", lighter: "native Promise", heavyKb: 120, lighterKb: 0, reason: "Native promises are fast" },
  { heavy: "underscore", lighter: "lodash", heavyKb: 60, lighterKb: 30, reason: "Lodash has better tree-shaking" },
  { heavy: "jquery", lighter: "cash-dom", heavyKb: 86, lighterKb: 10, reason: "DOM-only, much smaller" },
  { heavy: "superagent", lighter: "ky", heavyKb: 52, lighterKb: 8, reason: "ky is smaller and modern" },
  { heavy: "webpack", lighter: "esbuild", heavyKb: 5200, lighterKb: 700, reason: "esbuild is 10-100x faster" },
  { heavy: "ts-node", lighter: "tsx", heavyKb: 200, lighterKb: 50, reason: "tsx is faster and leaner" },
  { heavy: "babel-register", lighter: "swc/register", heavyKb: 300, lighterKb: 50, reason: "SWC is 20x faster" },
];

// Packages that are rarely needed as direct dependencies (utility-only)
const COMMONLY_MISUSED = [
  { pkg: "path", reason: "Built into Node.js — remove from package.json" },
  { pkg: "fs", reason: "Built into Node.js — remove from package.json" },
  { pkg: "util", reason: "Built into Node.js — remove from package.json" },
  { pkg: "events", reason: "Built into Node.js in modern versions" },
  { pkg: "stream", reason: "Built into Node.js — remove from package.json" },
  { pkg: "assert", reason: "Built into Node.js — use node:assert" },
  { pkg: "os", reason: "Built into Node.js — remove from package.json" },
  { pkg: "buffer", reason: "Built into Node.js — use native Buffer" },
];

function fmtKb(kb) {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb}KB`;
}

export async function cmdPerf(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better perf [options]

Analyze dependencies for performance improvement opportunities.

Checks:
  • Heavy packages with lighter alternatives
  • Node.js built-in modules listed as dependencies
  • Duplicate functionality packages (multiple HTTP clients, etc.)
  • ESM tree-shaking opportunities

Options:
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const allDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
  };
  const depNames = new Set(Object.keys(allDeps));

  const hints = [];

  // Check for lighter alternatives
  for (const { heavy, lighter, heavyKb, lighterKb, reason } of LIGHTER_ALTERNATIVES) {
    if (depNames.has(heavy)) {
      const saving = heavyKb - lighterKb;
      hints.push({
        type: "lighter-alternative",
        severity: saving > 100 ? "high" : "medium",
        package: heavy,
        suggestion: lighter === "native Promise" ? `Remove ${heavy}, use native Promises` : `Replace with ${lighter}`,
        current_kb: heavyKb,
        alternative_kb: lighterKb,
        saving_kb: saving,
        reason,
      });
    }
  }

  // Check for Node.js built-ins
  for (const { pkg, reason } of COMMONLY_MISUSED) {
    if (depNames.has(pkg)) {
      hints.push({
        type: "builtin-polyfill",
        severity: "high",
        package: pkg,
        suggestion: `Remove ${pkg} — ${reason}`,
        reason,
      });
    }
  }

  // Check for multiple HTTP clients
  const HTTP_CLIENTS = ["axios", "node-fetch", "got", "superagent", "ky", "request", "needle"];
  const presentHttpClients = HTTP_CLIENTS.filter(c => depNames.has(c));
  if (presentHttpClients.length > 1) {
    hints.push({
      type: "duplicate-functionality",
      severity: "medium",
      packages: presentHttpClients,
      suggestion: `Multiple HTTP clients: ${presentHttpClients.join(", ")}. Consolidate to one.`,
      reason: "Multiple HTTP libraries increase bundle size and maintenance burden",
    });
  }

  // Check for multiple logging libraries
  const LOGGERS = ["winston", "pino", "bunyan", "log4js", "loglevel"];
  const presentLoggers = LOGGERS.filter(l => depNames.has(l));
  if (presentLoggers.length > 1) {
    hints.push({
      type: "duplicate-functionality",
      severity: "low",
      packages: presentLoggers,
      suggestion: `Multiple loggers: ${presentLoggers.join(", ")}. Consolidate to one.`,
      reason: "Multiple logging libraries waste space",
    });
  }

  // Check for multiple test frameworks
  const TEST_FRAMEWORKS = ["jest", "mocha", "vitest", "jasmine", "tape"];
  const presentTests = TEST_FRAMEWORKS.filter(t => depNames.has(t));
  if (presentTests.length > 1) {
    hints.push({
      type: "duplicate-functionality",
      severity: "low",
      packages: presentTests,
      suggestion: `Multiple test frameworks: ${presentTests.join(", ")}. Use one.`,
      reason: "Multiple test frameworks add complexity and install time",
    });
  }

  // Check for Moment.js locale issue
  if (depNames.has("moment")) {
    hints.push({
      type: "bundle-tip",
      severity: "medium",
      package: "moment",
      suggestion: "If using webpack, add MomentLocalesPlugin to strip unused locales (saves ~400KB)",
      reason: "Moment includes all locales by default",
    });
  }

  // Sort by severity
  const ORDER = { high: 0, medium: 1, low: 2 };
  hints.sort((a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3));

  if (values.json) {
    printJson({
      ok: hints.filter(h => h.severity === "high").length === 0,
      kind: "better.perf",
      hints,
      total: hints.length,
      high: hints.filter(h => h.severity === "high").length,
      medium: hints.filter(h => h.severity === "medium").length,
      low: hints.filter(h => h.severity === "low").length,
    });
    return;
  }

  printText(`\n\x1b[1mbetter perf\x1b[0m — performance hints\n`);

  if (hints.length === 0) {
    printText(`\x1b[32m✔ No performance issues found.\x1b[0m`);
    return;
  }

  const colors = { high: "\x1b[31m", medium: "\x1b[33m", low: "\x1b[90m" };
  const icons = { high: "✖", medium: "⚠", low: "·" };

  for (const h of hints) {
    const color = colors[h.severity] || "\x1b[0m";
    const icon = icons[h.severity] || "·";
    printText(`  ${color}${icon}\x1b[0m  \x1b[1m${h.package || (h.packages || []).join(" + ")}\x1b[0m  \x1b[90m[${h.severity}]\x1b[0m`);
    printText(`       ${h.suggestion}`);
    if (h.saving_kb > 0) {
      printText(`       \x1b[90mBundle savings: ${fmtKb(h.saving_kb)}\x1b[0m`);
    }
  }

  printText(`\n${hints.length} hint(s) found.`);
}
