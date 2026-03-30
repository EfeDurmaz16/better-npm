/**
 * better lockfile-merge — merge package-lock.json conflicts
 *
 * Resolves merge conflicts in package-lock.json by regenerating
 * the lockfile from package.json, or by intelligently merging
 * changes from two conflicting versions.
 *
 * Usage:
 *   better lockfile-merge
 *   better lockfile-merge --regen
 *   better lockfile-merge --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function hasConflictMarkers(text) {
  return text.includes("<<<<<<< ") || text.includes(">>>>>>> ") || text.includes("=======");
}

function countConflicts(text) {
  return (text.match(/^<<<<<<< /gm) || []).length;
}

export async function cmdLockfileMerge(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      regen: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better lockfile-merge [options]

Resolve merge conflicts in package-lock.json.

Options:
  --regen      Regenerate lockfile from scratch (npm install)
  --dry-run    Check for conflicts without fixing
  --json       Machine-readable output
  -h, --help   Show this help

Strategy:
  Without --regen: Removes conflict markers by keeping the first
  (HEAD) version of conflicted sections, then runs npm install to
  properly resolve.

  With --regen: Deletes the conflicted lockfile and runs npm install
  to regenerate from package.json.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const lockPath = path.join(projectRoot, "package-lock.json");

  if (!values.json) {
    printText(`\n\x1b[1mbetter lockfile-merge\x1b[0m\n`);
  }

  let lockContent;
  try {
    lockContent = await fs.readFile(lockPath, "utf8");
  } catch {
    const msg = "package-lock.json not found";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const hasConflicts = hasConflictMarkers(lockContent);
  const conflictCount = hasConflicts ? countConflicts(lockContent) : 0;

  if (!hasConflicts) {
    const msg = "No merge conflicts found in package-lock.json";
    if (values.json) { printJson({ ok: true, kind: "better.lockfile-merge", conflicts: 0, message: msg }); }
    else { printText(`\x1b[32m✔ ${msg}\x1b[0m`); }
    return;
  }

  if (values["dry-run"]) {
    const msg = `${conflictCount} merge conflict(s) found in package-lock.json`;
    if (values.json) { printJson({ ok: false, kind: "better.lockfile-merge", conflicts: conflictCount, message: msg }); }
    else {
      printText(`  \x1b[31m✖\x1b[0m  ${msg}`);
      printText(`\n  \x1b[90mRun: better lockfile-merge to fix\x1b[0m`);
    }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`  Found ${conflictCount} merge conflict(s)\n`);
  }

  if (values.regen) {
    if (!values.json) {
      process.stderr.write(`\x1b[90mDeleting conflicted lockfile and regenerating…\x1b[0m\n`);
    }
    await fs.unlink(lockPath);
    const result = spawnSync("npm", ["install"], {
      cwd: projectRoot,
      stdio: values.json ? ["pipe", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
    });
    if (result.status === 0) {
      const msg = "Lockfile regenerated successfully";
      if (values.json) { printJson({ ok: true, kind: "better.lockfile-merge", strategy: "regen", conflicts: conflictCount, message: msg }); }
      else { printText(`\x1b[32m✔ ${msg}\x1b[0m`); }
    } else {
      const msg = "npm install failed during lockfile regeneration";
      if (values.json) { printJson({ ok: false, kind: "better.lockfile-merge", strategy: "regen", message: msg }); }
      else { printText(`\x1b[31m✖ ${msg}\x1b[0m`); }
      process.exitCode = 1;
    }
    printText("");
    return;
  }

  // Strategy: keep HEAD (<<<) side of conflicts
  const resolved = lockContent.replace(
    /<<<<<<< [^\n]*\n([\s\S]*?)\n=======\n[\s\S]*?\n>>>>>>> [^\n]*/g,
    "$1"
  );

  // Verify it's valid JSON after resolving
  let parsedOk = false;
  try { JSON.parse(resolved); parsedOk = true; } catch {}

  if (!parsedOk) {
    // Fall back to regen strategy
    if (!values.json) {
      process.stderr.write(`\x1b[90mCannot parse resolved lockfile — regenerating instead…\x1b[0m\n`);
    }
    await fs.unlink(lockPath);
    const result = spawnSync("npm", ["install"], {
      cwd: projectRoot,
      stdio: values.json ? ["pipe", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
    });
    if (result.status === 0) {
      const msg = "Lockfile regenerated (conflict resolution failed, used regen fallback)";
      if (values.json) { printJson({ ok: true, kind: "better.lockfile-merge", strategy: "regen-fallback", conflicts: conflictCount, message: msg }); }
      else { printText(`\x1b[32m✔ ${msg}\x1b[0m`); }
    } else {
      const msg = "Lockfile regeneration failed";
      if (values.json) { printJson({ ok: false, kind: "better.lockfile-merge", strategy: "regen-fallback", message: msg }); }
      else { printText(`\x1b[31m✖ ${msg}\x1b[0m`); }
      process.exitCode = 1;
    }
    printText("");
    return;
  }

  await fs.writeFile(lockPath, resolved, "utf8");
  if (!values.json) {
    process.stderr.write(`\x1b[90mRunning npm install to finalize lockfile…\x1b[0m\n`);
  }
  const result = spawnSync("npm", ["install"], {
    cwd: projectRoot,
    stdio: values.json ? ["pipe", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });

  if (result.status === 0) {
    const msg = `Resolved ${conflictCount} conflict(s) and updated lockfile`;
    if (values.json) { printJson({ ok: true, kind: "better.lockfile-merge", strategy: "merge", conflicts: conflictCount, message: msg }); }
    else { printText(`\x1b[32m✔ ${msg}\x1b[0m`); }
  } else {
    const msg = "npm install failed after conflict resolution";
    if (values.json) { printJson({ ok: false, kind: "better.lockfile-merge", strategy: "merge", message: msg }); }
    else { printText(`\x1b[31m✖ ${msg}\x1b[0m`); }
    process.exitCode = 1;
  }
  printText("");
}
