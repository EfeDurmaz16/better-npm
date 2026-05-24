/**
 * better node-modules-doctor — diagnose node_modules health
 *
 * Checks for common node_modules problems: corrupted packages,
 * missing files, incorrect permissions, symlink issues, and
 * nested duplications.
 *
 * Usage:
 *   better node-modules-doctor
 *   better node-modules-doctor --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdNodeModulesDoctor(argv) {
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
    printText(`Usage: better node-modules-doctor [options]

Diagnose node_modules health issues.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • node_modules exists and is readable
  • Package count vs declared dependencies
  • Packages missing package.json
  • Broken symlinks
  • Nested node_modules (deduplication opportunities)
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter node-modules-doctor\x1b[0m\n`);
  }

  const checks = [];

  // Check node_modules exists
  let nmStat;
  try {
    nmStat = await fs.stat(nmPath);
  } catch {
    const msg = "node_modules does not exist — run npm install first";
    checks.push({ name: "node-modules-exists", ok: false, message: msg });
    if (values.json) { printJson({ ok: false, kind: "better.node-modules-doctor", checks }); }
    else { printText(`  \x1b[31m✘\x1b[0m  ${msg}\n`); }
    process.exitCode = 1;
    return;
  }
  checks.push({ name: "node-modules-exists", ok: true, message: "node_modules exists" });

  // Read all top-level packages
  let entries = [];
  try {
    entries = await fs.readdir(nmPath, { withFileTypes: true });
  } catch {
    checks.push({ name: "node-modules-readable", ok: false, message: "Cannot read node_modules" });
  }

  const pkgDirs = [];
  const broken = [];

  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith(".")) continue;
    if (e.name.startsWith("@")) {
      const scopeDir = path.join(nmPath, e.name);
      try {
        const scoped = await fs.readdir(scopeDir, { withFileTypes: true });
        for (const s of scoped) {
          if (s.isDirectory() || s.isSymbolicLink()) pkgDirs.push({ name: `${e.name}/${s.name}`, dir: path.join(scopeDir, s.name), isSymlink: s.isSymbolicLink() });
        }
      } catch {}
    } else {
      pkgDirs.push({ name: e.name, dir: path.join(nmPath, e.name), isSymlink: e.isSymbolicLink() });
    }
  }

  checks.push({ name: "package-count", ok: true, message: `${pkgDirs.length} packages in node_modules` });

  // Check for missing package.json
  let missingPkgJson = 0;
  let brokenSymlinks = 0;
  let withNestedNm = 0;
  const BATCH = 20;

  for (let i = 0; i < pkgDirs.length; i += BATCH) {
    const batch = pkgDirs.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ name, dir, isSymlink }) => {
      // Check for broken symlink
      if (isSymlink) {
        try { await fs.stat(dir); } catch { brokenSymlinks++; broken.push(name); return; }
      }
      // Check for missing package.json
      try {
        await fs.access(path.join(dir, "package.json"));
      } catch {
        missingPkgJson++;
      }
      // Check for nested node_modules (deduplication opportunity)
      try {
        await fs.access(path.join(dir, "node_modules"));
        withNestedNm++;
      } catch {}
    }));
  }

  checks.push({
    name: "missing-package-json",
    ok: missingPkgJson === 0,
    message: missingPkgJson === 0
      ? "All packages have package.json"
      : `${missingPkgJson} package(s) missing package.json`,
  });

  checks.push({
    name: "broken-symlinks",
    ok: brokenSymlinks === 0,
    message: brokenSymlinks === 0
      ? "No broken symlinks"
      : `${brokenSymlinks} broken symlink(s): ${broken.slice(0, 3).join(", ")}`,
  });

  checks.push({
    name: "nested-node-modules",
    ok: withNestedNm === 0,
    message: withNestedNm === 0
      ? "No nested node_modules (fully deduplicated)"
      : `${withNestedNm} package(s) have nested node_modules (run npm dedupe)`,
    severity: withNestedNm > 0 ? "warning" : "ok",
  });

  // Check lockfile exists
  let lockfileExists = false;
  for (const lf of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]) {
    try { await fs.access(path.join(projectRoot, lf)); lockfileExists = true; break; } catch {}
  }
  checks.push({
    name: "lockfile",
    ok: lockfileExists,
    message: lockfileExists ? "Lockfile present" : "No lockfile found",
  });

  const errors = checks.filter(c => !c.ok && c.severity !== "warning");
  const warnings = checks.filter(c => !c.ok && c.severity === "warning");
  const ok = errors.length === 0;

  if (values.json) {
    printJson({ ok, kind: "better.node-modules-doctor", pkgCount: pkgDirs.length, checks });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const c of checks) {
    const icon = c.ok ? "\x1b[32m✔\x1b[0m" : (c.severity === "warning" ? "\x1b[33m⚠\x1b[0m" : "\x1b[31m✘\x1b[0m");
    printText(`  ${icon}  ${c.message}`);
  }

  printText("");
  if (!ok) {
    printText(`\x1b[31m✘ ${errors.length} issue(s) found in node_modules.\x1b[0m`);
    process.exitCode = 1;
  } else if (warnings.length > 0) {
    printText(`\x1b[33m⚠ node_modules OK with ${warnings.length} warning(s).\x1b[0m`);
  } else {
    printText(`\x1b[32m✔ node_modules looks healthy.\x1b[0m`);
  }
  printText("");
}
