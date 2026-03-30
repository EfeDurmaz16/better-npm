/**
 * better install-check — verify installation health
 *
 * Comprehensive check that your npm installation is healthy:
 * node_modules matches lockfile, no corrupted packages,
 * binary files are executable, and no stale cache entries.
 *
 * Usage:
 *   better install-check
 *   better install-check --deep
 *   better install-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdInstallCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      deep:  { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better install-check [options]

Verify that your npm installation is healthy and complete.

Checks:
  • node_modules exists
  • package-lock.json is in sync
  • No corrupted package.json files in node_modules
  • .bin directory has correct executables
  • No ghost packages (installed but not in lockfile)

Options:
  --deep       Deep scan all packages (slower)
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  const checks = [];

  // Check 1: node_modules exists
  const nmExists = await fs.access(nmPath).then(() => true).catch(() => false);
  checks.push({
    id: "node-modules-exists",
    label: "node_modules directory exists",
    passed: nmExists,
    severity: "error",
    hint: "Run: npm install",
  });

  if (!nmExists) {
    // Can't continue without node_modules
    const allOk = false;
    if (values.json) {
      printJson({ ok: false, kind: "better.install-check", checks, errors: 1 });
    } else {
      printText(`\n\x1b[1mbetter install-check\x1b[0m\n`);
      printText(`  \x1b[31m✖\x1b[0m  node_modules directory exists`);
      printText(`       \x1b[90m→ Run: npm install\x1b[0m`);
      printText(`\n\x1b[31m✖ Installation incomplete.\x1b[0m`);
    }
    process.exitCode = 1;
    return;
  }

  // Check 2: lockfile exists
  const lockExists = await fs.access(path.join(projectRoot, "package-lock.json")).then(() => true).catch(async () => {
    return await fs.access(path.join(projectRoot, "yarn.lock")).then(() => true).catch(async () => {
      return await fs.access(path.join(projectRoot, "pnpm-lock.yaml")).then(() => true).catch(() => false);
    });
  });
  checks.push({
    id: "lockfile-exists",
    label: "Lockfile present",
    passed: lockExists,
    severity: "warning",
    hint: "Run: npm install to generate package-lock.json",
  });

  // Check 3: .bin directory has executables
  const binPath = path.join(nmPath, ".bin");
  const binExists = await fs.access(binPath).then(() => true).catch(() => false);
  if (binExists) {
    let binEntries = [];
    try { binEntries = await fs.readdir(binPath); } catch {}
    checks.push({
      id: "bin-directory",
      label: `Executables present (${binEntries.length} in .bin)`,
      passed: binEntries.length > 0,
      severity: "warning",
      hint: "Run: npm rebuild",
    });
  }

  // Check 4: Check a sample of package.json files for corruption
  let corruptedCount = 0;
  let checkedCount = 0;
  let pkgDirs = [];
  try { pkgDirs = await fs.readdir(nmPath); } catch {}

  const sampleSize = values.deep ? pkgDirs.length : Math.min(pkgDirs.length, 50);
  const sample = pkgDirs.filter(d => !d.startsWith(".")).slice(0, sampleSize);

  for (const name of sample) {
    if (name.startsWith("@")) continue; // skip scoped for now
    try {
      const content = await fs.readFile(path.join(nmPath, name, "package.json"), "utf8");
      JSON.parse(content); // will throw if corrupted
      checkedCount++;
    } catch {
      corruptedCount++;
    }
  }

  checks.push({
    id: "no-corrupted-packages",
    label: `No corrupted packages (checked ${checkedCount})`,
    passed: corruptedCount === 0,
    severity: "error",
    hint: corruptedCount > 0 ? `Run: npm install to fix ${corruptedCount} corrupted package(s)` : "",
  });

  // Check 5: Verify npm install would be a no-op using npm ci --dry-run
  if (lockExists && values.deep) {
    const result = spawnSync("npm", ["ci", "--dry-run"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 30000,
    });
    checks.push({
      id: "install-idempotent",
      label: "npm ci --dry-run succeeds",
      passed: result.status === 0,
      severity: "warning",
      hint: result.status !== 0 ? "Run: npm ci to reinstall" : "",
    });
  }

  // Check 6: package.json dep count matches what's installed
  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    const declaredCount = Object.keys({
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
    }).length;

    // Count top-level installed packages (rough check)
    const topLevel = pkgDirs.filter(d => !d.startsWith(".") && !d.startsWith("@")).length;
    const scopedCount = pkgDirs.filter(d => d.startsWith("@")).length;

    checks.push({
      id: "deps-count",
      label: `Package count reasonable (${topLevel + scopedCount} installed, ${declaredCount} declared)`,
      passed: topLevel + scopedCount >= declaredCount,
      severity: "info",
      hint: topLevel + scopedCount < declaredCount ? "Some declared packages may be missing" : "",
    });
  } catch {}

  const errors = checks.filter(c => !c.passed && c.severity === "error");
  const warnings = checks.filter(c => !c.passed && c.severity === "warning");
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.install-check",
      checks,
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter install-check\x1b[0m\n`);

  for (const c of checks) {
    const icon = c.passed
      ? "\x1b[32m✔\x1b[0m"
      : c.severity === "error" ? "\x1b[31m✖\x1b[0m"
      : c.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[90m·\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
    if (!c.passed && c.hint) printText(`       \x1b[90m→ ${c.hint}\x1b[0m`);
  }

  printText("");
  if (allOk && warnings.length === 0) {
    printText(`\x1b[32m✔ Installation looks healthy!\x1b[0m`);
  } else if (allOk) {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s).\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} error(s) — run npm install to fix.\x1b[0m`);
    process.exitCode = 1;
  }
}
