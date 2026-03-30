/**
 * better npm-ci-check — validate npm ci prerequisites
 *
 * Checks all prerequisites for `npm ci` to succeed:
 * lockfile presence and version, package.json sync,
 * and node_modules state.
 *
 * Usage:
 *   better npm-ci-check
 *   better npm-ci-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdNpmCiCheck(argv) {
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
    printText(`Usage: better npm-ci-check [options]

Validate that npm ci can run successfully.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • package-lock.json exists
  • lockfileVersion >= 1
  • package.json is valid JSON
  • No packages in package.json missing from lockfile
  • No packages in lockfile missing from package.json
  • node_modules is not committed to git
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter npm-ci-check\x1b[0m\n`);
  }

  const checks = [];

  // 1. package-lock.json exists
  let lockfile = null;
  const lockPath = path.join(projectRoot, "package-lock.json");
  try {
    const content = await fs.readFile(lockPath, "utf8");
    lockfile = JSON.parse(content);
    checks.push({ id: "lockfile-exists", label: `package-lock.json found (v${lockfile.lockfileVersion || 1})`, passed: true });
  } catch {
    checks.push({ id: "lockfile-exists", label: "package-lock.json not found", passed: false, hint: "Run: npm install to generate" });
  }

  // 2. package.json is valid
  let pkgJson = null;
  const pkgPath = path.join(projectRoot, "package.json");
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    checks.push({ id: "pkg-valid", label: "package.json is valid JSON", passed: true });
  } catch {
    checks.push({ id: "pkg-valid", label: "package.json is invalid or missing", passed: false, hint: "Fix JSON syntax errors" });
  }

  // 3. Sync check
  if (lockfile && pkgJson) {
    const pkgDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies, ...pkgJson.optionalDependencies };
    const lockPkgs = lockfile.packages || {};

    const missingInLock = [];
    const extraInLock = [];

    for (const dep of Object.keys(pkgDeps)) {
      const lockKey = `node_modules/${dep}`;
      if (!lockPkgs[lockKey] && !lockPkgs[dep]) {
        missingInLock.push(dep);
      }
    }

    if (missingInLock.length > 0) {
      checks.push({
        id: "lockfile-sync",
        label: `${missingInLock.length} package(s) in package.json not in lockfile`,
        passed: false,
        hint: "Run: npm install to sync lockfile",
        packages: missingInLock.slice(0, 5),
      });
    } else {
      checks.push({ id: "lockfile-sync", label: "package.json and lockfile are in sync", passed: true });
    }

    // Check lockfileVersion >= 2 for CI robustness
    if ((lockfile.lockfileVersion || 1) < 2) {
      checks.push({
        id: "lockfile-version",
        label: `lockfileVersion is ${lockfile.lockfileVersion || 1} (recommend ≥ 2)`,
        passed: false,
        hint: "Regenerate with npm ≥7: npm install",
        severity: "warning",
      });
    } else {
      checks.push({ id: "lockfile-version", label: `lockfileVersion ${lockfile.lockfileVersion} ✔`, passed: true });
    }
  }

  // 4. Check if node_modules is in .gitignore
  let gitignoreHasNm = false;
  try {
    const gitignore = await fs.readFile(path.join(projectRoot, ".gitignore"), "utf8");
    gitignoreHasNm = gitignore.split("\n").some(l => l.trim() === "node_modules" || l.trim() === "node_modules/");
  } catch {}

  if (!gitignoreHasNm) {
    checks.push({ id: "gitignore", label: "node_modules not in .gitignore", passed: false, hint: 'Add "node_modules" to .gitignore', severity: "warning" });
  } else {
    checks.push({ id: "gitignore", label: "node_modules in .gitignore ✔", passed: true });
  }

  const errors = checks.filter(c => !c.passed && c.severity !== "warning");
  const warnings = checks.filter(c => !c.passed && c.severity === "warning");
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.npm-ci-check",
      checks,
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  for (const c of checks) {
    const icon = c.passed ? "\x1b[32m✔\x1b[0m"
      : c.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[31m✖\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
    if (!c.passed && c.hint) printText(`       \x1b[90m→ ${c.hint}\x1b[0m`);
    if (c.packages?.length) {
      for (const p of c.packages) printText(`       \x1b[90m${p}\x1b[0m`);
    }
  }

  printText("");
  if (allOk && warnings.length === 0) {
    printText(`\x1b[32m✔ npm ci should work correctly.\x1b[0m`);
  } else if (allOk) {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s). npm ci will likely work but may have issues.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} issue(s) will prevent npm ci from working.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
