/**
 * better lockfile-fix — diagnose and fix package-lock.json issues
 *
 * Detects and repairs common lockfile problems: missing entries,
 * version mismatches, corrupted integrity hashes, and format issues.
 *
 * Usage:
 *   better lockfile-fix
 *   better lockfile-fix --dry-run
 *   better lockfile-fix --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function cmdLockfileFix(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      "dry-run":{ type: "boolean", default: false },
      force:    { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better lockfile-fix [options]

Diagnose and repair package-lock.json issues.

Checks performed:
  • Lockfile exists
  • Lockfile version (should be v2 or v3)
  • Lockfile is parseable JSON
  • All declared dependencies have entries
  • Integrity hashes present for registry packages
  • No packages resolved from suspicious URLs

Options:
  --dry-run    Show what would be fixed without making changes
  --force      Re-generate lockfile even if no issues found
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const lockPath = path.join(projectRoot, "package-lock.json");

  const issues = [];
  const fixes = [];

  // Check 1: Does lockfile exist?
  const lockExists = await fileExists(lockPath);
  if (!lockExists) {
    issues.push({ id: "no-lockfile", severity: "error", message: "package-lock.json does not exist" });
    fixes.push({ id: "no-lockfile", action: "run npm install to generate lockfile" });
  }

  let lockData = null;
  if (lockExists) {
    // Check 2: Is it valid JSON?
    try {
      const content = await fs.readFile(lockPath, "utf8");
      lockData = JSON.parse(content);
    } catch (err) {
      issues.push({ id: "invalid-json", severity: "error", message: `Lockfile is invalid JSON: ${err.message}` });
      fixes.push({ id: "invalid-json", action: "delete lockfile and run npm install" });
    }
  }

  if (lockData) {
    // Check 3: Lockfile version
    const lockVersion = lockData.lockfileVersion;
    if (!lockVersion || lockVersion < 2) {
      issues.push({
        id: "old-lockfile-version",
        severity: "warning",
        message: `Lockfile version ${lockVersion ?? "missing"} (should be 2 or 3)`,
      });
      fixes.push({ id: "old-lockfile-version", action: "run npm install to upgrade lockfile format" });
    }

    // Check 4: Missing integrity hashes
    const packages = lockData.packages || {};
    let missingIntegrity = 0;
    let untrustedUrls = 0;
    const TRUSTED = ["https://registry.npmjs.org/", "https://registry.yarnpkg.com/"];

    for (const [pkgPath, info] of Object.entries(packages)) {
      if (!pkgPath) continue;
      if (info.resolved?.startsWith("https://") && !info.integrity) {
        missingIntegrity++;
      }
      if (info.resolved && !TRUSTED.some(t => info.resolved.startsWith(t)) && info.resolved.startsWith("https://")) {
        untrustedUrls++;
      }
    }

    if (missingIntegrity > 0) {
      issues.push({
        id: "missing-integrity",
        severity: "warning",
        message: `${missingIntegrity} package(s) missing integrity hashes`,
      });
      fixes.push({ id: "missing-integrity", action: "run npm install to regenerate integrity hashes" });
    }

    if (untrustedUrls > 0) {
      issues.push({
        id: "untrusted-urls",
        severity: "warning",
        message: `${untrustedUrls} package(s) resolved from non-standard registries`,
      });
    }

    // Check 5: package.json vs lockfile consistency
    let pkgJson;
    try {
      pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    } catch {}

    if (pkgJson) {
      const declared = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
      const missingFromLock = [];

      for (const dep of Object.keys(declared)) {
        const entry = packages[`node_modules/${dep}`];
        if (!entry && !dep.startsWith("@types/")) {
          missingFromLock.push(dep);
        }
      }

      if (missingFromLock.length > 0) {
        issues.push({
          id: "missing-entries",
          severity: "error",
          message: `${missingFromLock.length} package(s) in package.json missing from lockfile: ${missingFromLock.slice(0, 5).join(", ")}${missingFromLock.length > 5 ? "…" : ""}`,
        });
        fixes.push({ id: "missing-entries", action: "run npm install to sync lockfile" });
      }
    }
  }

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  const needsFix = issues.length > 0 || values.force;

  if (values.json) {
    printJson({
      ok: errors.length === 0,
      kind: "better.lockfile-fix",
      issues,
      errors: errors.length,
      warnings: warnings.length,
      fixesAvailable: fixes.length,
    });
    if (errors.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter lockfile-fix\x1b[0m\n`);

  if (issues.length === 0 && !values.force) {
    printText(`\x1b[32m✔ Lockfile looks healthy. No issues found.\x1b[0m\n`);
    return;
  }

  for (const issue of issues) {
    const icon = issue.severity === "error" ? "\x1b[31m✖\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    printText(`  ${icon}  ${issue.message}`);
  }

  printText("");

  if (values["dry-run"]) {
    printText(`\x1b[90mFixes available:\x1b[0m`);
    for (const fix of fixes) {
      printText(`  \x1b[90m→ ${fix.action}\x1b[0m`);
    }
    printText(`\n\x1b[90mRun without --dry-run to apply the recommended fix.\x1b[0m`);
    return;
  }

  // Apply the primary fix: re-run npm install
  if (needsFix) {
    const fixAction = !lockExists ? "npm install" : "npm install";
    printText(`\x1b[90mRunning ${fixAction} to fix lockfile…\x1b[0m\n`);

    const result = spawnSync("npm", ["install"], {
      cwd: projectRoot,
      stdio: "inherit",
    });

    if (result.status === 0) {
      printText(`\n\x1b[32m✔ Lockfile regenerated successfully.\x1b[0m`);
    } else {
      printText(`\n\x1b[31m✖ npm install failed with exit code ${result.status}.\x1b[0m`);
      process.exitCode = 1;
    }
  }
}
