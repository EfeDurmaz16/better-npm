/**
 * better mono-deps — manage shared dependencies in a monorepo
 *
 * Analyzes dependency versions across workspace packages and flags
 * version mismatches, suggests hoisting candidates, and helps
 * keep versions synchronized.
 *
 * Usage:
 *   better mono-deps
 *   better mono-deps --mismatches
 *   better mono-deps --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function expandGlob(base, pattern) {
  // Simple glob: support */pkg and packages/* style
  if (!pattern.includes("*")) {
    try {
      await fs.access(path.join(base, pattern));
      return [path.join(base, pattern)];
    } catch { return []; }
  }

  const parts = pattern.split("/");
  const starIdx = parts.findIndex(p => p.includes("*"));
  const before = parts.slice(0, starIdx).join("/");
  const after = parts.slice(starIdx + 1).join("/");

  const dir = path.join(base, before);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const candidate = after
        ? path.join(dir, e.name, after)
        : path.join(dir, e.name);
      try {
        await fs.access(candidate);
        results.push(after ? candidate : path.join(dir, e.name));
      } catch {}
    }
    return results;
  } catch { return []; }
}

async function discoverWorkspaces(projectRoot) {
  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch { return []; }

  const workspacePatterns = Array.isArray(pkgJson.workspaces)
    ? pkgJson.workspaces
    : (pkgJson.workspaces?.packages || []);

  if (!workspacePatterns.length) return [];

  const dirs = [];
  for (const pattern of workspacePatterns) {
    const expanded = await expandGlob(projectRoot, pattern);
    dirs.push(...expanded);
  }
  return dirs;
}

async function readWorkspacePkg(dir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    return { dir, name: pkg.name, pkg };
  } catch { return null; }
}

function stripRange(v) {
  return String(v).replace(/^[~^>=< ]+/, "").split(" ")[0];
}

export async function cmdMonoDeps(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:        { type: "boolean", default: runtime.json === true },
      help:        { type: "boolean", short: "h", default: false },
      mismatches:  { type: "boolean", default: false },
      hoist:       { type: "boolean", default: false },
      fix:         { type: "boolean", default: false },
      "dry-run":   { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better mono-deps [options]

Analyze dependency versions across monorepo workspace packages.

Options:
  --mismatches   Show only version mismatches between workspaces
  --hoist        Show packages that could be hoisted to root
  --fix          Sync mismatched versions to latest (with --dry-run to preview)
  --dry-run      Preview --fix changes without writing
  --json         Machine-readable output
  -h, --help     Show this help

Examples:
  better mono-deps
  better mono-deps --mismatches
  better mono-deps --fix --dry-run
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const workspaceDirs = await discoverWorkspaces(projectRoot);

  if (workspaceDirs.length === 0) {
    const msg = "No workspaces found. Add a workspaces field to package.json.";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    return;
  }

  const workspaces = (await Promise.all(workspaceDirs.map(readWorkspacePkg))).filter(Boolean);

  // Build dep map: depName → { pkgName: version }
  const depMap = new Map(); // dep → Map(pkgName → range)

  for (const ws of workspaces) {
    const allDeps = { ...ws.pkg.dependencies, ...ws.pkg.devDependencies };
    for (const [dep, range] of Object.entries(allDeps)) {
      if (!depMap.has(dep)) depMap.set(dep, new Map());
      depMap.get(dep).set(ws.name || path.basename(ws.dir), range);
    }
  }

  // Find mismatches (same dep, different versions)
  const mismatches = [];
  for (const [dep, usages] of depMap) {
    const versions = new Set([...usages.values()].map(v => stripRange(v)));
    if (versions.size > 1) {
      mismatches.push({
        name: dep,
        usages: Object.fromEntries(usages),
        versions: [...versions],
      });
    }
  }

  // Find hoist candidates (used in 3+ workspaces)
  const hoistCandidates = [];
  for (const [dep, usages] of depMap) {
    if (usages.size >= 3) {
      const versions = [...new Set([...usages.values()].map(v => stripRange(v)))];
      hoistCandidates.push({ name: dep, usedIn: usages.size, versions });
    }
  }

  hoistCandidates.sort((a, b) => b.usedIn - a.usedIn);
  mismatches.sort((a, b) => a.name.localeCompare(b.name));

  if (values.json) {
    printJson({
      ok: mismatches.length === 0,
      kind: "better.mono-deps",
      workspaces: workspaces.length,
      totalDeps: depMap.size,
      mismatches: mismatches.length,
      mismatchedDeps: mismatches,
      hoistCandidates: hoistCandidates.slice(0, 20),
    });
    return;
  }

  const showAll = !values.mismatches && !values.hoist;

  printText(`\n\x1b[1mbetter mono-deps\x1b[0m — ${workspaces.length} workspace(s), ${depMap.size} unique deps\n`);

  if (showAll || values.mismatches) {
    if (mismatches.length === 0) {
      printText(`\x1b[32m✔ No version mismatches across workspaces.\x1b[0m\n`);
    } else {
      printText(`\x1b[33m${mismatches.length} version mismatch(es):\x1b[0m\n`);
      for (const m of mismatches) {
        printText(`  \x1b[1m${m.name}\x1b[0m  \x1b[33m${m.versions.join(" vs ")}\x1b[0m`);
        for (const [ws, v] of Object.entries(m.usages)) {
          printText(`    \x1b[90m${ws}: ${v}\x1b[0m`);
        }
      }
      printText("");
    }
  }

  if (showAll || values.hoist) {
    const top = hoistCandidates.slice(0, 10);
    if (top.length > 0) {
      printText(`\x1b[90mTop hoist candidates (used in 3+ workspaces):\x1b[0m\n`);
      for (const h of top) {
        const vStr = h.versions.length > 1 ? ` \x1b[33m(${h.versions.length} versions)\x1b[0m` : "";
        printText(`  \x1b[1m${h.name}\x1b[0m  used in ${h.usedIn} workspaces${vStr}`);
      }
      printText("");
    }
  }

  if (values.fix && mismatches.length > 0) {
    const isDry = values["dry-run"];
    printText(`${isDry ? "\x1b[90mDry-run: would sync" : "Syncing"} ${mismatches.length} mismatche(s) to latest version...\x1b[0m\n`);

    for (const m of mismatches) {
      // Pick the latest numeric version as the winner
      const latest = m.versions.sort((a, b) => {
        const [am, ami, ap] = a.split(".").map(Number);
        const [bm, bmi, bp] = b.split(".").map(Number);
        if (am !== bm) return bm - am;
        if (ami !== bmi) return bmi - ami;
        return bp - ap;
      })[0];

      if (!isDry) {
        for (const ws of workspaces) {
          const modified = { ...ws.pkg };
          let changed = false;
          for (const section of ["dependencies", "devDependencies"]) {
            if (modified[section]?.[m.name]) {
              const prefix = modified[section][m.name].match(/^([~^])/)?.[1] || "^";
              modified[section][m.name] = `${prefix}${latest}`;
              changed = true;
            }
          }
          if (changed) {
            await fs.writeFile(
              path.join(ws.dir, "package.json"),
              JSON.stringify(modified, null, 2) + "\n"
            );
          }
        }
      }
      printText(`  \x1b[1m${m.name}\x1b[0m → \x1b[32m${latest}\x1b[0m`);
    }

    if (!isDry) {
      printText(`\n\x1b[32m✔ Synced. Run npm install in workspaces to apply.\x1b[0m`);
    } else {
      printText(`\n\x1b[90mRun without --dry-run to apply.\x1b[0m`);
    }
  }
}
