/**
 * better shrinkwrap-check — validate npm-shrinkwrap.json
 *
 * Checks for presence, version consistency, integrity hashes,
 * and whether shrinkwrap is in sync with package.json.
 *
 * Usage:
 *   better shrinkwrap-check
 *   better shrinkwrap-check --strict
 *   better shrinkwrap-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdShrinkwrapCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      strict: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better shrinkwrap-check [options]

Validate npm-shrinkwrap.json integrity and consistency.

Options:
  --strict     Fail if shrinkwrap is absent or has warnings
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • shrinkwrap file exists
  • lockfileVersion >= 2 (integrity hashes)
  • All package.json deps appear in shrinkwrap
  • No packages without integrity hash
  • No conflicts with package-lock.json
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const shrinkwrapPath = path.join(projectRoot, "npm-shrinkwrap.json");
  const pkgLockPath = path.join(projectRoot, "package-lock.json");
  const pkgJsonPath = path.join(projectRoot, "package.json");

  if (!values.json) {
    printText(`\n\x1b[1mbetter shrinkwrap-check\x1b[0m\n`);
  }

  const issues = [];
  const infos = [];

  // Check if shrinkwrap exists
  let sw;
  try {
    sw = JSON.parse(await fs.readFile(shrinkwrapPath, "utf8"));
    infos.push(`shrinkwrap present (lockfileVersion: ${sw.lockfileVersion || "1"})`);
  } catch {
    const msg = "npm-shrinkwrap.json not found";
    if (values.strict) {
      issues.push({ severity: "error", message: msg, hint: "Run: npm shrinkwrap" });
    } else {
      issues.push({ severity: "warning", message: msg, hint: "Run: npm shrinkwrap to lock dependencies for deployment" });
    }

    // Check if package-lock exists instead
    try {
      await fs.access(pkgLockPath);
      infos.push("package-lock.json exists (use npm shrinkwrap to create shrinkwrap)");
    } catch {}

    const errors = issues.filter(i => i.severity === "error");
    const warnings = issues.filter(i => i.severity === "warning");

    if (values.json) {
      printJson({ ok: errors.length === 0, kind: "better.shrinkwrap-check", issues, infos });
      if (errors.length > 0) process.exitCode = 1;
      return;
    }

    for (const iss of issues) {
      const icon = iss.severity === "error" ? "\x1b[31m✖\x1b[0m" : "\x1b[33m⚠\x1b[0m";
      printText(`  ${icon}  ${iss.message}`);
      if (iss.hint) printText(`       \x1b[90m→ ${iss.hint}\x1b[0m`);
    }
    printText("");
    if (errors.length > 0) {
      printText(`\x1b[31m✖ ${errors.length} issue(s) found.\x1b[0m`);
      process.exitCode = 1;
    } else {
      printText(`\x1b[33m⚠ ${warnings.length} warning(s).\x1b[0m`);
    }
    printText("");
    return;
  }

  // Check lockfileVersion
  const lfv = sw.lockfileVersion || 1;
  if (lfv < 2) {
    issues.push({
      severity: "warning",
      message: `lockfileVersion is ${lfv} (recommend ≥ 2 for integrity hashes)`,
      hint: "Regenerate with npm 7+: npm install --lockfile-version=2",
    });
  }

  // Check for conflict with package-lock
  try {
    await fs.access(pkgLockPath);
    issues.push({
      severity: "warning",
      message: "Both npm-shrinkwrap.json and package-lock.json exist",
      hint: "Remove package-lock.json — shrinkwrap takes precedence",
    });
  } catch {}

  // Check packages without integrity
  const packages = sw.packages || {};
  let noIntegrity = 0;
  let totalPkgs = 0;
  for (const [key, pkg] of Object.entries(packages)) {
    if (key === "") continue; // root package
    totalPkgs++;
    if (!pkg.integrity && !pkg.bundled && !pkg.inBundle) {
      noIntegrity++;
    }
  }

  if (noIntegrity > 0) {
    issues.push({
      severity: "warning",
      message: `${noIntegrity} package(s) missing integrity hash`,
      hint: "Regenerate: npm install --lockfile-version=2",
    });
  }

  infos.push(`${totalPkgs} packages in shrinkwrap`);

  // Check package.json deps are covered
  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
    const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
    const missing = [];
    for (const dep of Object.keys(allDeps)) {
      const key = `node_modules/${dep}`;
      if (!packages[key] && !packages[dep]) {
        missing.push(dep);
      }
    }
    if (missing.length > 0) {
      issues.push({
        severity: "error",
        message: `${missing.length} package(s) in package.json not in shrinkwrap: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`,
        hint: "Run: npm install to update shrinkwrap",
      });
    }
  } catch {}

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  const allOk = errors.length === 0 && (!values.strict || warnings.length === 0);

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.shrinkwrap-check",
      lockfileVersion: lfv,
      totalPackages: totalPkgs,
      noIntegrityCount: noIntegrity,
      issues,
      infos,
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  for (const info of infos) {
    printText(`  \x1b[90m·  ${info}\x1b[0m`);
  }

  if (issues.length > 0) {
    printText("");
    for (const iss of issues) {
      const icon = iss.severity === "error" ? "\x1b[31m✖\x1b[0m" : "\x1b[33m⚠\x1b[0m";
      printText(`  ${icon}  ${iss.message}`);
      if (iss.hint) printText(`       \x1b[90m→ ${iss.hint}\x1b[0m`);
    }
  }

  printText("");
  if (allOk) {
    printText(`\x1b[32m✔ Shrinkwrap is valid.\x1b[0m`);
  } else if (errors.length > 0) {
    printText(`\x1b[31m✖ ${errors.length} issue(s) need attention.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s).\x1b[0m`);
    if (values.strict) process.exitCode = 1;
  }
  printText("");
}
