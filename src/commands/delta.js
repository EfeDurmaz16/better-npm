/**
 * better delta — show what changed since last install (#26)
 *
 * Compares the current lockfile against the stored snapshot from the
 * previous install run to show which packages were added, removed,
 * changed, or unchanged.
 *
 * Usage:
 *   better delta                    # diff vs last install snapshot
 *   better delta --save             # update snapshot without installing
 *   better delta --json
 */
import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { getCacheRoot, cacheLayout } from "../lib/cache.js";
import { computeDelta, saveSnapshot, parseLockfilePackages } from "../lib/deltaUpdate.js";

const HELP = `better delta — lockfile delta since last install

Usage:
  better delta           Show packages added/removed/changed vs last install
  better delta --save    Update the snapshot without running install

Options:
  --save           Save current lockfile state as new snapshot
  --project-root   Override project root
  --cache-root     Override cache root
  --json           Machine-readable output
  -h, --help       Show help
`;

async function findLockfile(projectRoot) {
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    const p = path.join(projectRoot, name);
    try { await fs.access(p); return p; } catch { /* try next */ }
  }
  return null;
}

export async function cmdDelta(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      save: { type: "boolean", default: false },
      "project-root": { type: "string" },
      "cache-root": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: false,
    strict: false
  });

  if (values.help) { printText(HELP); return; }

  const cwd = process.cwd();
  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const cacheRoot = values["cache-root"] ? path.resolve(values["cache-root"]) : await getCacheRoot();
  const layout = cacheLayout(cacheRoot);

  const lockfilePath = await findLockfile(projectRoot);
  if (!lockfilePath) {
    const msg = "No lockfile found. Run your package manager install first.";
    if (values.json) { printJson({ ok: false, reason: msg }); } else { printText(msg); }
    process.exitCode = 1;
    return;
  }

  if (values.save) {
    const packages = await parseLockfilePackages(lockfilePath);
    await saveSnapshot(cacheRoot, projectRoot, packages);
    const msg = `Snapshot saved: ${packages.size} packages`;
    if (values.json) { printJson({ ok: true, saved: true, packages: packages.size }); }
    else { printText(`\x1b[32m✔ ${msg}\x1b[0m`); }
    return;
  }

  const result = await computeDelta(cacheRoot, projectRoot, lockfilePath);

  if (values.json) {
    printJson({
      ok: result.ok,
      fullInstallNeeded: result.fullInstallNeeded,
      totalPackages: result.totalPackages,
      changedPackages: result.changedPackages,
      unchangedPackages: result.unchangedPackages,
      reason: result.reason,
      delta: result.delta
    });
    return;
  }

  if (!result.ok) {
    printText(`\x1b[31m✖ Could not compute delta: ${result.reason}\x1b[0m`);
    process.exitCode = 1;
    return;
  }

  if (result.fullInstallNeeded && result.reason === "no_baseline") {
    printText("\x1b[90mNo previous snapshot. Run `better install` to establish baseline.\x1b[0m");
    return;
  }

  const { delta } = result;

  printText(`\nbetter delta — ${lockfilePath}\n`);
  printText(`\x1b[90mTotal: ${result.totalPackages} packages | Changed: ${result.changedPackages} | Unchanged: ${result.unchangedPackages ?? 0}\x1b[0m\n`);

  if (delta.added.length > 0) {
    printText(`\x1b[32m+ Added (${delta.added.length})\x1b[0m`);
    for (const p of delta.added.slice(0, 20)) {
      printText(`  \x1b[32m+\x1b[0m ${p.name}@${p.version}`);
    }
    if (delta.added.length > 20) printText(`  \x1b[90m  … and ${delta.added.length - 20} more\x1b[0m`);
  }

  if (delta.removed.length > 0) {
    printText(`\n\x1b[31m- Removed (${delta.removed.length})\x1b[0m`);
    for (const p of delta.removed.slice(0, 20)) {
      printText(`  \x1b[31m-\x1b[0m ${p.name}@${p.version}`);
    }
    if (delta.removed.length > 20) printText(`  \x1b[90m  … and ${delta.removed.length - 20} more\x1b[0m`);
  }

  if (delta.changed.length > 0) {
    printText(`\n\x1b[33m~ Changed (${delta.changed.length})\x1b[0m`);
    for (const p of delta.changed.slice(0, 20)) {
      printText(`  \x1b[33m~\x1b[0m ${p.name}: ${p.from} → ${p.to}`);
    }
    if (delta.changed.length > 20) printText(`  \x1b[90m  … and ${delta.changed.length - 20} more\x1b[0m`);
  }

  if (result.changedPackages === 0) {
    printText("\x1b[32m✔ No changes since last install.\x1b[0m");
  } else {
    printText(`\n\x1b[90mRun \`better install\` to apply changes.\x1b[0m`);
  }
}
