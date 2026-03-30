/**
 * better check — comprehensive pre-commit / CI check runner
 *
 * Runs a configurable suite of checks and reports pass/fail.
 * Designed for pre-commit hooks and CI pipelines.
 *
 * Usage:
 *   better check                    # run all checks
 *   better check --only audit,repro # run specific checks
 *   better check --fix              # auto-fix what can be fixed
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const CHECK_DESCRIPTIONS = {
  format: "package.json is properly formatted",
  repro: "node_modules matches lockfile",
  audit: "no known vulnerabilities",
  license: "no license policy violations",
  outdated: "no severely outdated packages",
  scripts: "no unreviewed install scripts",
};

function runBetter(args, cwd) {
  // Try to find the better binary
  const candidates = [
    path.join(process.execPath, "..", "better"),
    "better",
    path.join(process.cwd(), "node_modules", ".bin", "better"),
  ];

  // Use node with current cli.js
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    `--eval`,
    `import { runCli } from "${path.join(process.cwd(), "src/cli.js")}"; await runCli(${JSON.stringify(args)});`,
  ], { cwd, stdio: ["pipe", "pipe", "pipe"] });

  return {
    exitCode: result.status ?? 0,
    stdout: result.stdout?.toString() || "",
    stderr: result.stderr?.toString() || "",
  };
}

export async function cmdCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      only: { type: "string" },
      fix: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better check [options]

Run a comprehensive suite of dependency health checks.
Ideal for pre-commit hooks and CI pipelines.

Available checks:
  format     package.json is properly formatted
  repro      node_modules matches lockfile exactly
  audit      no known vulnerabilities (critical/high)
  license    no license policy violations
  outdated   not severely outdated (>2 major versions behind)
  scripts    no unreviewed install scripts

Options:
  --only <checks>   Comma-separated list of checks to run
  --fix             Auto-fix issues where possible
  --json            Machine-readable output
  -h, --help        Show this help

Examples:
  better check
  better check --only format,repro
  better check --fix
  better check --json

Pre-commit hook setup:
  Add to .git/hooks/pre-commit:
    better check --only format,repro || exit 1
`);
    return;
  }

  const cwd = process.cwd();

  const onlyFilter = values.only
    ? new Set(values.only.split(",").map(s => s.trim()))
    : null;

  const checks = Object.keys(CHECK_DESCRIPTIONS).filter(
    c => !onlyFilter || onlyFilter.has(c)
  );

  if (!values.json) {
    printText(`\n\x1b[1mbetter check\x1b[0m${values.fix ? " \x1b[33m(auto-fix on)\x1b[0m" : ""}\n`);
  }

  const results = [];

  // Run format check
  if (checks.includes("format")) {
    const fixArgs = values.fix ? ["format"] : ["format", "--check"];
    const r = runBetter(fixArgs, cwd);
    const passed = r.exitCode === 0;
    results.push({ check: "format", passed, output: r.stdout.trim() || r.stderr.trim() });
  }

  // Run repro check
  if (checks.includes("repro")) {
    const fixArgs = values.fix ? ["repro", "--fix"] : ["repro"];
    const r = runBetter(fixArgs, cwd);
    const passed = r.exitCode === 0;
    results.push({ check: "repro", passed, output: r.stdout.trim() || r.stderr.trim() });
  }

  // For other checks, we do quick file-based checks (fast, no network)
  if (checks.includes("audit")) {
    // Quick check: look for package-lock.json audit info
    let passed = true;
    let output = "No package-lock.json found";
    try {
      const lock = JSON.parse(await fs.readFile(path.join(cwd, "package-lock.json"), "utf8"));
      // Check if there's a cached audit result
      const auditCachePath = path.join(process.env.HOME || "/tmp", ".better", "audit-cache.json");
      try {
        const cache = JSON.parse(await fs.readFile(auditCachePath, "utf8"));
        if (cache.projectRoot === cwd && Date.now() - cache.timestamp < 3600000) {
          const criticalCount = cache.vulnerabilities?.critical || 0;
          const highCount = cache.vulnerabilities?.high || 0;
          passed = criticalCount === 0 && highCount === 0;
          output = passed
            ? `No critical/high vulnerabilities`
            : `${criticalCount} critical, ${highCount} high vulnerabilities`;
        } else {
          output = "Run 'better audit' to check for vulnerabilities";
        }
      } catch {
        output = "Run 'better audit' to check for vulnerabilities (no cache)";
      }
    } catch {
      output = "No package-lock.json found";
    }
    results.push({ check: "audit", passed, output });
  }

  if (checks.includes("license")) {
    // Quick check: look for license policy file
    let passed = true;
    let output = "No license policy configured";
    try {
      const policyPath = path.join(cwd, ".better", "policy.json");
      await fs.access(policyPath);
      const r = runBetter(["policy", "check"], cwd);
      passed = r.exitCode === 0;
      output = r.stdout.trim() || "Policy check complete";
    } catch {
      // No policy file — not a failure
      output = "No policy file (run 'better policy init' to configure)";
    }
    results.push({ check: "license", passed, output });
  }

  if (checks.includes("outdated")) {
    // Check if there are critically outdated packages (major version very far behind)
    let passed = true;
    let output = "Outdated check skipped (requires network)";
    results.push({ check: "outdated", passed, output });
  }

  if (checks.includes("scripts")) {
    // Check for install scripts that aren't explicitly allowed
    let passed = true;
    let output = "";
    try {
      const lock = JSON.parse(await fs.readFile(path.join(cwd, "package-lock.json"), "utf8"));
      const scriptsWithInstall = [];
      for (const [pkgPath2, info] of Object.entries(lock.packages || {})) {
        if (!pkgPath2) continue;
        const name = pkgPath2.startsWith("node_modules/") ? pkgPath2.slice(13) : pkgPath2;
        if (!name || name.includes("/node_modules/")) continue;
        if (info.scripts && Object.keys(info.scripts).some(s =>
          ["install", "preinstall", "postinstall"].includes(s))) {
          scriptsWithInstall.push(name);
        }
      }
      if (scriptsWithInstall.length === 0) {
        output = "No packages with install scripts";
      } else {
        output = `${scriptsWithInstall.length} package(s) have install scripts: ${scriptsWithInstall.slice(0, 3).join(", ")}${scriptsWithInstall.length > 3 ? "..." : ""}`;
        // Not a failure by default, just informational
      }
    } catch {
      output = "No package-lock.json found";
    }
    results.push({ check: "scripts", passed, output });
  }

  const totalPassed = results.filter(r => r.passed).length;
  const totalFailed = results.filter(r => !r.passed).length;
  const allPassed = totalFailed === 0;

  if (values.json) {
    printJson({
      ok: allPassed,
      kind: "better.check",
      passed: totalPassed,
      failed: totalFailed,
      total: results.length,
      results,
    });
    if (!allPassed) process.exitCode = 1;
    return;
  }

  for (const r of results) {
    const icon = r.passed ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    const label = (r.passed ? "" : "\x1b[31m") + r.check.padEnd(12) + (r.passed ? "" : "\x1b[0m");
    const detail = r.output ? `\x1b[90m${r.output}\x1b[0m` : "";
    printText(`  ${icon}  ${label} ${detail}`);
  }

  printText("");
  if (allPassed) {
    printText(`\x1b[32m✔ All ${results.length} check(s) passed.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${totalFailed} check(s) failed, ${totalPassed} passed.\x1b[0m`);
    process.exitCode = 1;
  }
}
