/**
 * better diff-deps — compare dependencies between git refs
 *
 * Shows what changed in package.json dependencies between
 * two git commits, branches, or tags.
 *
 * Usage:
 *   better diff-deps HEAD~1
 *   better diff-deps main feature-branch
 *   better diff-deps v1.0.0 v1.1.0
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function getPackageJsonAtRef(projectRoot, ref) {
  const result = spawnSync("git", ["show", `${ref}:package.json`], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function semverBumpType(oldVer, newVer) {
  if (!oldVer || !newVer) return "?";
  const strip = v => String(v).replace(/^[~^>=<]/, "");
  const [om, oni, op] = strip(oldVer).split(".").map(Number);
  const [nm, nni, np] = strip(newVer).split(".").map(Number);
  if (nm > om) return "major";
  if (nni > oni) return "minor";
  if (np > op) return "patch";
  if (String(oldVer) !== String(newVer)) return "range";
  return "same";
}

export async function cmdDiffDeps(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      dev:   { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printText(`Usage: better diff-deps <ref1> [ref2] [options]

Compare package.json dependencies between two git refs.

Arguments:
  ref1   First git ref (branch, tag, commit, or HEAD~N)
  ref2   Second git ref (default: HEAD)

Options:
  --dev        Include devDependencies
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better diff-deps HEAD~1
  better diff-deps main feature/new-feature
  better diff-deps v1.0.0 v2.0.0 --dev
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const { resolveInstallProjectRoot: rr } = await import("../lib/projectRoot.js");
  const cwd = process.cwd();
  const resolvedRoot = await rr(cwd);
  const projectRoot = resolvedRoot.root;

  const ref1 = positionals[0];
  const ref2 = positionals[1] || "HEAD";

  const pkg1 = getPackageJsonAtRef(projectRoot, ref1);
  const pkg2 = getPackageJsonAtRef(projectRoot, ref2);

  if (!pkg1) {
    const msg = `Cannot read package.json at ref "${ref1}"`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }
  if (!pkg2) {
    const msg = `Cannot read package.json at ref "${ref2}"`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  function compareDeps(old, curr, section) {
    const added = [], removed = [], updated = [];
    const oldKeys = new Set(Object.keys(old));
    const currKeys = new Set(Object.keys(curr));

    for (const key of currKeys) {
      if (!oldKeys.has(key)) {
        added.push({ name: key, version: curr[key], section });
      } else if (old[key] !== curr[key]) {
        updated.push({ name: key, from: old[key], to: curr[key], bump: semverBumpType(old[key], curr[key]), section });
      }
    }
    for (const key of oldKeys) {
      if (!currKeys.has(key)) {
        removed.push({ name: key, version: old[key], section });
      }
    }
    return { added, removed, updated };
  }

  const prodDiff = compareDeps(pkg1.dependencies || {}, pkg2.dependencies || {}, "dependencies");
  const devDiff = values.dev
    ? compareDeps(pkg1.devDependencies || {}, pkg2.devDependencies || {}, "devDependencies")
    : { added: [], removed: [], updated: [] };

  const added = [...prodDiff.added, ...devDiff.added];
  const removed = [...prodDiff.removed, ...devDiff.removed];
  const updated = [...prodDiff.updated, ...devDiff.updated];
  const hasDiff = added.length > 0 || removed.length > 0 || updated.length > 0;

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.diff-deps",
      ref1,
      ref2,
      added,
      removed,
      updated,
      summary: { added: added.length, removed: removed.length, updated: updated.length },
    });
    return;
  }

  printText(`\n\x1b[1mbetter diff-deps\x1b[0m  ${ref1}  →  ${ref2}\n`);

  if (!hasDiff) {
    printText(`\x1b[32m✔ No dependency changes between ${ref1} and ${ref2}.\x1b[0m`);
    return;
  }

  if (added.length > 0) {
    printText(`\x1b[32m${added.length} added:\x1b[0m`);
    for (const a of added) {
      printText(`  \x1b[32m+\x1b[0m ${a.name.padEnd(30)} ${a.version} \x1b[90m(${a.section})\x1b[0m`);
    }
    printText("");
  }

  if (removed.length > 0) {
    printText(`\x1b[31m${removed.length} removed:\x1b[0m`);
    for (const r of removed) {
      printText(`  \x1b[31m-\x1b[0m ${r.name.padEnd(30)} ${r.version} \x1b[90m(${r.section})\x1b[0m`);
    }
    printText("");
  }

  if (updated.length > 0) {
    printText(`\x1b[33m${updated.length} updated:\x1b[0m`);
    for (const u of updated) {
      const bumpColor = u.bump === "major" ? "\x1b[31m" : u.bump === "minor" ? "\x1b[33m" : "\x1b[32m";
      printText(`  \x1b[33m~\x1b[0m ${u.name.padEnd(30)} ${u.from} → ${u.to} ${bumpColor}(${u.bump})\x1b[0m`);
    }
    printText("");
  }
}
