/**
 * better npm-audit-fix-check — preview what npm audit fix would change
 *
 * Runs `npm audit --json` and analyzes which vulnerabilities can be
 * auto-fixed vs require manual intervention, showing the exact
 * version changes that would occur.
 *
 * Usage:
 *   better npm-audit-fix-check
 *   better npm-audit-fix-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const SEVERITY_COLOR = {
  critical: "\x1b[35m",
  high:     "\x1b[31m",
  moderate: "\x1b[33m",
  low:      "\x1b[36m",
  info:     "\x1b[90m",
};

export async function cmdNpmAuditFixCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better npm-audit-fix-check [options]

Preview npm audit fix changes before applying them.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Shows:
  • All current vulnerabilities with severity
  • Which can be auto-fixed (minor/patch upgrades)
  • Which require manual intervention (major upgrades)
  • Breaking change warnings
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter npm-audit-fix-check\x1b[0m\n`);
    process.stderr.write(`\x1b[90mRunning npm audit...\x1b[0m\n`);
  }

  // Run npm audit --json
  const auditResult = spawnSync("npm", ["audit", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 60000,
  });

  let auditData = null;
  try {
    auditData = JSON.parse(auditResult.stdout);
  } catch {
    const msg = "Failed to run npm audit";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m\n`); }
    process.exitCode = 1;
    return;
  }

  const vulns = Object.values(auditData.vulnerabilities || {});

  if (vulns.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.npm-audit-fix-check", count: 0, vulnerabilities: [] }); return; }
    printText(`\x1b[32m✔ No vulnerabilities found.\x1b[0m\n`);
    return;
  }

  // Analyze fixability
  const fixable = vulns.filter(v => v.fixAvailable === true || (typeof v.fixAvailable === "object" && !v.fixAvailable.isSemVerMajor));
  const requiresBreaking = vulns.filter(v => typeof v.fixAvailable === "object" && v.fixAvailable.isSemVerMajor);
  const noFix = vulns.filter(v => !v.fixAvailable);

  const severityCounts = {};
  for (const v of vulns) {
    severityCounts[v.severity] = (severityCounts[v.severity] || 0) + 1;
  }

  if (values.json) {
    printJson({
      ok: vulns.length === 0,
      kind: "better.npm-audit-fix-check",
      count: vulns.length,
      fixable: fixable.length,
      requiresBreaking: requiresBreaking.length,
      noFix: noFix.length,
      severityCounts,
      vulnerabilities: vulns.map(v => ({
        name: v.name,
        severity: v.severity,
        via: (v.via || []).filter(x => typeof x === "object").map(x => x.title || x.url).slice(0, 2),
        fixAvailable: v.fixAvailable,
      })),
    });
    process.exitCode = 1;
    return;
  }

  // Summary
  const sevStr = Object.entries(severityCounts)
    .sort((a, b) => ["critical","high","moderate","low","info"].indexOf(a[0]) - ["critical","high","moderate","low","info"].indexOf(b[0]))
    .map(([s, n]) => `${SEVERITY_COLOR[s] || ""}${n} ${s}\x1b[0m`)
    .join("  ");
  printText(`  ${vulns.length} vulnerabilities: ${sevStr}\n`);
  printText(`  Auto-fixable:      \x1b[32m${fixable.length}\x1b[0m  (npm audit fix)`);
  printText(`  Breaking changes:  \x1b[33m${requiresBreaking.length}\x1b[0m  (npm audit fix --force)`);
  printText(`  No fix available:  \x1b[90m${noFix.length}\x1b[0m\n`);

  // Show details for high/critical
  const severe = vulns.filter(v => ["critical", "high"].includes(v.severity));
  if (severe.length > 0) {
    printText(`\x1b[1mCritical/High vulnerabilities:\x1b[0m`);
    for (const v of severe.slice(0, 10)) {
      const color = SEVERITY_COLOR[v.severity] || "";
      const via = (v.via || []).filter(x => typeof x === "object").map(x => x.title).filter(Boolean).slice(0, 1).join("");
      const fixStr = v.fixAvailable === true ? " \x1b[32m[fixable]\x1b[0m"
        : typeof v.fixAvailable === "object" && v.fixAvailable.isSemVerMajor ? " \x1b[33m[breaking]\x1b[0m"
        : " \x1b[90m[no fix]\x1b[0m";
      printText(`  ${color}[${v.severity}]\x1b[0m  \x1b[1m${v.name}\x1b[0m${fixStr}${via ? `  \x1b[90m${via}\x1b[0m` : ""}`);
    }
    printText("");
  }

  if (fixable.length > 0) printText(`  Run: \x1b[36mnpm audit fix\x1b[0m`);
  if (requiresBreaking.length > 0) printText(`  Run: \x1b[33mnpm audit fix --force\x1b[0m  (may break things)`);
  printText("");
  process.exitCode = 1;
}
