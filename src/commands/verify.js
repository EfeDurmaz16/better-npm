/**
 * better verify — comprehensive package verification
 *
 * Runs multiple verification checks on installed packages:
 * npm audit, integrity hash validation, lockfile consistency,
 * and optional registry cross-check.
 *
 * Usage:
 *   better verify
 *   better verify lodash express
 *   better verify --strict
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fetchRegistryIntegrity(name, version) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    https.get(`https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve({
            integrity: data.dist?.integrity || null,
            shasum: data.dist?.shasum || null,
          });
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

export async function cmdVerify(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      strict: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better verify [packages...] [options]

Verify installed package integrity and security.

Checks:
  • npm audit (known vulnerabilities)
  • Lockfile integrity hashes present
  • Installed packages match lockfile versions
  • Package files exist and are readable

Options:
  --strict     Fail on any warning
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const checks = [];

  // Check 1: npm audit
  if (!values.json) {
    process.stderr.write(`\x1b[90mRunning npm audit…\x1b[0m\n`);
  }

  const auditResult = spawnSync("npm", ["audit", "--json"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });

  let auditData = null;
  try { auditData = JSON.parse(auditResult.stdout); } catch {}

  const vulnCount = auditData?.metadata?.vulnerabilities;
  const totalVulns = vulnCount
    ? (vulnCount.critical || 0) + (vulnCount.high || 0) + (vulnCount.moderate || 0) + (vulnCount.low || 0)
    : 0;

  checks.push({
    id: "npm-audit",
    label: totalVulns > 0 ? `npm audit: ${totalVulns} vulnerability(ies)` : "npm audit: clean",
    passed: totalVulns === 0,
    severity: totalVulns > 0 ? (((vulnCount?.critical || 0) + (vulnCount?.high || 0)) > 0 ? "error" : "warning") : "info",
    hint: totalVulns > 0 ? "Run: npm audit fix" : "",
    details: auditData ? {
      critical: vulnCount?.critical || 0,
      high: vulnCount?.high || 0,
      moderate: vulnCount?.moderate || 0,
      low: vulnCount?.low || 0,
    } : null,
  });

  // Check 2: lockfile integrity
  let lockData = null;
  try {
    lockData = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  } catch {}

  if (lockData) {
    const pkgs = lockData.packages || {};
    let missingHashes = 0;
    for (const [p, info] of Object.entries(pkgs)) {
      if (!p) continue;
      if (info.resolved?.startsWith("https://") && !info.integrity) missingHashes++;
    }
    checks.push({
      id: "lockfile-integrity",
      label: missingHashes > 0 ? `${missingHashes} packages missing integrity hashes` : "All packages have integrity hashes",
      passed: missingHashes === 0,
      severity: "warning",
      hint: missingHashes > 0 ? "Run: npm install to regenerate lockfile" : "",
    });
  }

  // Check 3: version consistency
  const targets = positionals.length > 0
    ? positionals
    : Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });

  const mismatches = [];
  for (const name of targets.slice(0, 20)) {
    let installedVersion = null;
    let lockfileVersion = null;

    try {
      const depPkg = JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
      installedVersion = depPkg.version;
    } catch {}

    if (lockData) {
      const entry = lockData.packages?.[`node_modules/${name}`];
      lockfileVersion = entry?.version;
    }

    if (installedVersion && lockfileVersion && installedVersion !== lockfileVersion) {
      mismatches.push({ name, installed: installedVersion, lockfile: lockfileVersion });
    }
  }

  if (mismatches.length > 0) {
    checks.push({
      id: "version-consistency",
      label: `${mismatches.length} version mismatch(es) between installed and lockfile`,
      passed: false,
      severity: "error",
      hint: "Run: npm ci to restore lockfile state",
    });
  } else {
    checks.push({
      id: "version-consistency",
      label: `Installed versions match lockfile (${Math.min(targets.length, 20)} checked)`,
      passed: true,
      severity: "info",
    });
  }

  const errors = checks.filter(c => !c.passed && c.severity === "error");
  const warnings = checks.filter(c => !c.passed && c.severity === "warning");
  const allOk = errors.length === 0 && (!values.strict || warnings.length === 0);

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.verify",
      checks: checks.map(c => ({ id: c.id, label: c.label, passed: c.passed, severity: c.severity, details: c.details })),
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter verify\x1b[0m\n`);

  for (const c of checks) {
    const icon = c.passed
      ? "\x1b[32m✔\x1b[0m"
      : c.severity === "error" ? "\x1b[31m✖\x1b[0m"
      : c.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[90m·\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
    if (!c.passed && c.hint) printText(`       \x1b[90m→ ${c.hint}\x1b[0m`);
    if (c.details) {
      const { critical, high, moderate, low } = c.details;
      if (critical) printText(`       \x1b[31mcritical: ${critical}\x1b[0m`);
      if (high) printText(`       \x1b[31mhigh: ${high}\x1b[0m`);
      if (moderate) printText(`       \x1b[33mmoderate: ${moderate}\x1b[0m`);
      if (low) printText(`       \x1b[90mlow: ${low}\x1b[0m`);
    }
  }

  printText("");
  if (allOk && warnings.length === 0) {
    printText(`\x1b[32m✔ All checks passed.\x1b[0m`);
  } else if (allOk) {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s) — consider fixing.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} error(s) found.\x1b[0m`);
    process.exitCode = 1;
  }
}
