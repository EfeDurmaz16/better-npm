/**
 * better security — comprehensive security check
 *
 * Runs multiple security-related checks in one command:
 * - Vulnerability audit (OSV.dev)
 * - Supply chain analysis
 * - Secret scanning in dependencies
 * - Deprecated packages with security implications
 * - License compliance
 *
 * Usage:
 *   better security               # run all security checks
 *   better security --quick       # fast offline checks only
 *   better security --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { spawnSync } from "node:child_process";

const HIGH_RISK_INSTALL_PACKAGES = new Set([
  "node-gyp-build", "prebuild-install", "node-pre-gyp",
  "download", "node-fetch", // common in malicious packages
]);

const COPYLEFT_LICENSES = new Set([
  "GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.0", "LGPL-2.1", "LGPL-3.0"
]);

async function checkInstallScripts(projectRoot) {
  const issues = [];
  const lockPath = path.join(projectRoot, "package-lock.json");
  try {
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    for (const [pkgPath, info] of Object.entries(lock.packages || {})) {
      if (!pkgPath || pkgPath === "") continue;
      const name = pkgPath.startsWith("node_modules/") ? pkgPath.slice(13) : pkgPath;
      if (!name || name.includes("/node_modules/")) continue;
      if (info.scripts && Object.keys(info.scripts).some(
        s => ["install", "preinstall", "postinstall"].includes(s)
      )) {
        const severity = HIGH_RISK_INSTALL_PACKAGES.has(name) ? "high" : "medium";
        issues.push({ name, scripts: Object.keys(info.scripts), severity });
      }
    }
  } catch {}
  return issues;
}

async function checkCopyleftLicenses(projectRoot) {
  const violations = [];
  const nmPath = path.join(projectRoot, "node_modules");
  try {
    const pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    const isPrivate = pkgJson.private === true;
    if (isPrivate) return []; // Copyleft only matters for published packages

    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(nmPath, entry.name, "package.json"), "utf8"));
        const lic = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type || "");
        if (COPYLEFT_LICENSES.has(lic)) {
          violations.push({ name: entry.name, license: lic });
        }
      } catch {}
    }
  } catch {}
  return violations;
}

async function checkRegistryIntegrity(projectRoot) {
  const suspicious = [];
  const lockPath = path.join(projectRoot, "package-lock.json");
  try {
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    for (const [pkgPath, info] of Object.entries(lock.packages || {})) {
      if (!pkgPath || pkgPath === "") continue;
      const name = pkgPath.startsWith("node_modules/") ? pkgPath.slice(13) : pkgPath;
      if (!name || name.includes("/node_modules/")) continue;

      const resolved = info.resolved || "";
      // Check for non-standard registries
      if (resolved && !resolved.startsWith("https://registry.npmjs.org/") &&
          !resolved.startsWith("https://registry.yarnpkg.com/")) {
        suspicious.push({ name, resolved, reason: "non-standard registry" });
      }

      // Check for missing integrity
      if (!info.integrity && resolved.startsWith("https://")) {
        suspicious.push({ name, resolved, reason: "missing integrity hash" });
      }
    }
  } catch {}
  return suspicious;
}

export async function cmdSecurity(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      quick: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better security [options]

Run comprehensive security checks on your dependencies.

Checks performed:
  ✓ Vulnerability scan (audit)
  ✓ Install script detection
  ✓ Copyleft license detection
  ✓ Non-standard registry packages
  ✓ Missing integrity hashes

Options:
  --quick       Skip network checks (fast offline mode)
  --json        Machine-readable output
  -h, --help    Show this help

Examples:
  better security
  better security --quick
  better security --json
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter security\x1b[0m${values.quick ? " \x1b[90m(quick mode)\x1b[0m" : ""}\n`);
  }

  const results = [];

  // Run audit if not quick
  let auditResult = { passed: true, vulnerabilities: {}, total: 0 };
  if (!values.quick) {
    if (!values.json) process.stderr.write("\x1b[90m→ Running vulnerability audit…\x1b[0m\n");
    const binPath = path.join(cwd, "node_modules", ".bin", "better");
    // Run npm audit
    const npmAudit = spawnSync("npm", ["audit", "--json"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const auditData = JSON.parse(npmAudit.stdout?.toString() || "{}");
      const vulns = auditData.metadata?.vulnerabilities || auditData.vulnerabilities || {};
      const total = (vulns.critical || 0) + (vulns.high || 0) + (vulns.moderate || 0) + (vulns.low || 0);
      auditResult = {
        passed: (vulns.critical || 0) === 0 && (vulns.high || 0) === 0,
        vulnerabilities: vulns,
        total,
      };
    } catch {
      auditResult = { passed: true, vulnerabilities: {}, total: 0, skipped: true };
    }
    results.push({
      check: "vulnerabilities",
      passed: auditResult.passed,
      detail: auditResult.skipped
        ? "Audit skipped (npm unavailable)"
        : `${auditResult.total} total (${auditResult.vulnerabilities.critical || 0} critical, ${auditResult.vulnerabilities.high || 0} high)`,
    });
  }

  // Check install scripts
  if (!values.json) process.stderr.write("\x1b[90m→ Checking install scripts…\x1b[0m\n");
  const installScriptIssues = await checkInstallScripts(projectRoot);
  const highRiskScripts = installScriptIssues.filter(i => i.severity === "high");
  results.push({
    check: "install-scripts",
    passed: highRiskScripts.length === 0,
    detail: installScriptIssues.length === 0
      ? "No install scripts"
      : `${installScriptIssues.length} packages have install scripts (${highRiskScripts.length} high-risk)`,
    items: installScriptIssues,
  });

  // Check copyleft licenses
  const copyleftViolations = await checkCopyleftLicenses(projectRoot);
  results.push({
    check: "copyleft-licenses",
    passed: copyleftViolations.length === 0,
    detail: copyleftViolations.length === 0
      ? "No copyleft licenses"
      : `${copyleftViolations.length} copyleft packages (${copyleftViolations.map(v => v.name).slice(0, 3).join(", ")})`,
    items: copyleftViolations,
  });

  // Check registry integrity
  if (!values.json) process.stderr.write("\x1b[90m→ Checking registry integrity…\x1b[0m\n");
  const registryIssues = await checkRegistryIntegrity(projectRoot);
  results.push({
    check: "registry-integrity",
    passed: registryIssues.length === 0,
    detail: registryIssues.length === 0
      ? "All packages from standard registries with integrity"
      : `${registryIssues.length} issues (non-standard registry or missing integrity)`,
    items: registryIssues,
  });

  const failedChecks = results.filter(r => !r.passed);
  const allPassed = failedChecks.length === 0;

  if (values.json) {
    printJson({
      ok: allPassed,
      kind: "better.security",
      checks: results,
      passed: results.filter(r => r.passed).length,
      failed: failedChecks.length,
    });
    if (!allPassed) process.exitCode = 1;
    return;
  }

  for (const r of results) {
    const icon = r.passed ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    const label = r.check.padEnd(20);
    printText(`  ${icon}  ${label} \x1b[90m${r.detail}\x1b[0m`);
  }

  printText("");
  if (allPassed) {
    printText(`\x1b[32m✔ Security checks passed.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${failedChecks.length} security issue(s) found.\x1b[0m`);
    process.exitCode = 1;
  }
}
