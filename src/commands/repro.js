/**
 * better repro — reproducibility check
 *
 * Verifies that installed packages match the lockfile exactly.
 * Detects drift between package-lock.json and what's actually in node_modules.
 *
 * Usage:
 *   better repro                     # check current install
 *   better repro --fix               # reinstall to restore reproducibility
 *   better repro --report            # detailed report of all mismatches
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { spawnSync } from "node:child_process";

async function readPkgVersion(nmPath, name) {
  try {
    const raw = await fs.readFile(path.join(nmPath, name, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return pkg.version || null;
  } catch {
    return null;
  }
}

export async function cmdRepro(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      fix: { type: "boolean", default: false },
      report: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better repro [options]

Verify that installed packages match the lockfile exactly.
Detects drift (manual edits, partial installs, etc.)

Options:
  --fix         Re-run install to restore exact lockfile state
  --report      Show all mismatches in detail
  --json        Machine-readable output
  -h, --help    Show this help

Examples:
  better repro               # quick check
  better repro --report      # full mismatch report
  better repro --fix         # restore clean state
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let lockData;
  try {
    lockData = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  } catch {
    const msg = "No package-lock.json found. Run 'better install' first.";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(msg); }
    process.exitCode = 1;
    return;
  }

  const nmPath = path.join(projectRoot, "node_modules");

  // Check if node_modules exists at all
  try {
    await fs.access(nmPath);
  } catch {
    const msg = "node_modules directory not found.";
    if (values.json) {
      printJson({ ok: false, error: msg, missing_modules: true });
    } else {
      printText(`\x1b[31m✖ ${msg}\x1b[0m`);
      printText("\x1b[90mRun `better install` to restore.\x1b[0m");
    }
    if (values.fix) {
      if (!values.json) printText("\n\x1b[1mRunning install to fix...\x1b[0m");
      spawnSync("npm", ["ci"], { cwd: projectRoot, stdio: "inherit" });
    }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    process.stderr.write("\x1b[90mChecking packages against lockfile…\x1b[0m\n");
  }

  // Get all packages from lockfile
  const lockPkgs = lockData.packages || {};
  const checks = [];

  for (const [pkgPath, info] of Object.entries(lockPkgs)) {
    if (!pkgPath || pkgPath === "") continue;
    const name = pkgPath.startsWith("node_modules/") ? pkgPath.slice(13) : pkgPath;
    if (!name || name.includes("/node_modules/")) continue; // skip nested
    const expectedVersion = info.version;
    if (!expectedVersion) continue;
    checks.push({ name, expectedVersion });
  }

  const BATCH = 20;
  const mismatches = [];
  const missing = [];

  for (let i = 0; i < checks.length; i += BATCH) {
    const batch = checks.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async ({ name, expectedVersion }) => {
        const actualVersion = await readPkgVersion(nmPath, name);
        if (actualVersion === null) return { name, type: "missing", expected: expectedVersion };
        if (actualVersion !== expectedVersion) {
          return { name, type: "version_mismatch", expected: expectedVersion, actual: actualVersion };
        }
        return null;
      })
    );
    for (const r of results) {
      if (!r) continue;
      if (r.type === "missing") missing.push(r);
      else mismatches.push(r);
    }
  }

  const isReproducible = missing.length === 0 && mismatches.length === 0;
  const totalChecked = checks.length;

  if (values.json) {
    printJson({
      ok: isReproducible,
      kind: "better.repro",
      reproducible: isReproducible,
      checked: totalChecked,
      missing: missing.length,
      mismatches: mismatches.length,
      missing_packages: values.report ? missing : missing.slice(0, 10),
      version_mismatches: values.report ? mismatches : mismatches.slice(0, 10),
    });
    if (!isReproducible) process.exitCode = 1;
    return;
  }

  if (isReproducible) {
    printText(`\x1b[32m✔ Reproducible\x1b[0m — all ${totalChecked} packages match the lockfile.`);
    return;
  }

  printText(`\n\x1b[31m✖ Not reproducible\x1b[0m — ${missing.length + mismatches.length} issue(s) found\n`);

  if (missing.length > 0) {
    const show = values.report ? missing : missing.slice(0, 5);
    printText(`\x1b[31mMissing packages (${missing.length}):\x1b[0m`);
    for (const p of show) {
      printText(`  \x1b[31m✖\x1b[0m  ${p.name}@${p.expected}`);
    }
    if (missing.length > 5 && !values.report) {
      printText(`  \x1b[90m...${missing.length - 5} more (use --report to see all)\x1b[0m`);
    }
  }

  if (mismatches.length > 0) {
    const show = values.report ? mismatches : mismatches.slice(0, 5);
    printText(`\n\x1b[33mVersion mismatches (${mismatches.length}):\x1b[0m`);
    for (const p of show) {
      printText(`  \x1b[33m⚠\x1b[0m  ${p.name.padEnd(32)} expected ${p.expected}, got ${p.actual}`);
    }
    if (mismatches.length > 5 && !values.report) {
      printText(`  \x1b[90m...${mismatches.length - 5} more (use --report to see all)\x1b[0m`);
    }
  }

  printText(`\n\x1b[90mChecked ${totalChecked} packages.\x1b[0m`);

  if (values.fix) {
    printText("\n\x1b[1mRunning clean install to restore reproducibility…\x1b[0m");
    const result = spawnSync("npm", ["ci"], { cwd: projectRoot, stdio: "inherit" });
    process.exitCode = result.status ?? 0;
  } else {
    printText("\x1b[90mRun `better repro --fix` to restore, or `better install` manually.\x1b[0m");
    process.exitCode = 1;
  }
}
