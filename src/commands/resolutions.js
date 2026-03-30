/**
 * better resolutions — manage selective version resolutions
 *
 * Shows which packages in node_modules have multiple versions
 * installed and suggests resolution entries to force a single version.
 * Works with npm overrides and yarn resolutions.
 *
 * Usage:
 *   better resolutions
 *   better resolutions --suggest
 *   better resolutions --apply
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parseSemver(v) {
  const s = String(v).replace(/^[~^>=v]/, "").split(".");
  return [parseInt(s[0]) || 0, parseInt(s[1]) || 0, parseInt(s[2]) || 0];
}

function semverGt(a, b) {
  const [am, ami, ap] = parseSemver(a);
  const [bm, bmi, bp] = parseSemver(b);
  if (am !== bm) return am > bm;
  if (ami !== bmi) return ami > bmi;
  return ap > bp;
}

async function findAllVersions(nmPath, pkgName) {
  const versions = new Set();

  // Top-level
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(nmPath, pkgName, "package.json"), "utf8"));
    if (pkg.version) versions.add(pkg.version);
  } catch {}

  // Nested versions
  async function scanNested(baseDir, depth = 0) {
    if (depth > 4) return;
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const nested = path.join(baseDir, e.name, "node_modules");
        if (e.name.startsWith("@")) {
          // scoped: look inside
          const scopedEntries = await fs.readdir(path.join(baseDir, e.name), { withFileTypes: true }).catch(() => []);
          for (const se of scopedEntries) {
            if (se.isDirectory()) {
              const pkg = await fs.readFile(
                path.join(baseDir, e.name, se.name, "package.json"), "utf8"
              ).catch(() => null);
              if (pkg) {
                const p = JSON.parse(pkg);
                if (p.name === pkgName && p.version) versions.add(p.version);
              }
            }
          }
        }
        // Check for nested node_modules
        try {
          const nestedPkg = JSON.parse(
            await fs.readFile(path.join(nested, pkgName, "package.json"), "utf8")
          );
          if (nestedPkg.version) versions.add(nestedPkg.version);
        } catch {}

        await scanNested(nested, depth + 1).catch(() => {});
      }
    } catch {}
  }

  await scanNested(nmPath);
  return [...versions];
}

export async function cmdResolutions(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      suggest: { type: "boolean", default: false },
      apply:   { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      min:     { type: "string", default: "2" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better resolutions [packages...] [options]

Find packages with multiple installed versions and suggest resolution pinning.

Options:
  --suggest    Show suggested overrides/resolutions to add to package.json
  --apply      Apply suggested resolutions to package.json
  --dry-run    Preview --apply changes without writing
  --min <n>    Only show packages with >= n versions (default: 2)
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better resolutions
  better resolutions --suggest
  better resolutions --apply --dry-run
`);
    return;
  }

  const minVersions = parseInt(values.min) || 2;
  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const nmPath = path.join(projectRoot, "node_modules");

  // Get list of all top-level packages to scan
  let targets;
  if (positionals.length > 0) {
    targets = positionals;
  } else {
    try {
      const entries = await fs.readdir(nmPath, { withFileTypes: true });
      targets = [];
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (e.name.startsWith("@")) {
          const scoped = await fs.readdir(path.join(nmPath, e.name), { withFileTypes: true }).catch(() => []);
          for (const s of scoped) {
            if (s.isDirectory()) targets.push(`${e.name}/${s.name}`);
          }
        } else {
          targets.push(e.name);
        }
      }
    } catch { targets = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies }); }
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mScanning ${targets.length} packages for version duplicates…\x1b[0m\n`);
  }

  const BATCH = 10;
  const results = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (name) => {
      const versions = await findAllVersions(nmPath, name);
      if (versions.length < minVersions) return null;
      versions.sort((a, b) => semverGt(a, b) ? -1 : 1);
      return { name, versions, latest: versions[0] };
    }));
    results.push(...batchResults.filter(Boolean));
  }

  results.sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name));

  // Detect npm vs yarn
  const hasYarnLock = await fs.access(path.join(projectRoot, "yarn.lock")).then(() => true).catch(() => false);
  const overrideKey = hasYarnLock ? "resolutions" : "overrides";

  if (values.json) {
    const suggestions = results.reduce((o, r) => { o[r.name] = r.latest; return o; }, {});
    printJson({
      ok: results.length === 0,
      kind: "better.resolutions",
      totalScanned: targets.length,
      duplicates: results.length,
      overrideKey,
      packages: results,
      suggestedOverrides: suggestions,
    });
    return;
  }

  printText(`\n\x1b[1mbetter resolutions\x1b[0m — ${targets.length} packages scanned\n`);

  if (results.length === 0) {
    printText(`\x1b[32m✔ No packages with multiple versions found.\x1b[0m\n`);
    return;
  }

  printText(`\x1b[33m${results.length} package(s) with multiple versions:\x1b[0m\n`);

  for (const r of results) {
    printText(`  \x1b[1m${r.name}\x1b[0m  ${r.versions.join(" | ")}`);
  }

  if (values.suggest || values.apply) {
    printText(`\n\x1b[90mSuggested "${overrideKey}":\x1b[0m\n`);
    const suggestions = {};
    for (const r of results) suggestions[r.name] = r.latest;
    printText(`\x1b[90m${JSON.stringify({ [overrideKey]: suggestions }, null, 2)}\x1b[0m`);

    if (values.apply) {
      const isDry = values["dry-run"];
      const updated = { ...pkgJson };
      if (!updated[overrideKey]) updated[overrideKey] = {};
      for (const r of results) {
        updated[overrideKey][r.name] = r.latest;
      }

      if (!isDry) {
        const pkgPath = path.join(projectRoot, "package.json");
        await fs.writeFile(pkgPath, JSON.stringify(updated, null, 2) + "\n");
        printText(`\n\x1b[32m✔ Applied ${results.length} resolution(s) to package.json.\x1b[0m`);
        printText(`\x1b[90mRun npm install to apply the resolutions.\x1b[0m`);
      } else {
        printText(`\n\x1b[90mDry-run: run without --dry-run to apply.\x1b[0m`);
      }
    }
  } else {
    printText(`\n\x1b[90mRun with --suggest to see recommended overrides.\x1b[0m`);
  }

  printText("");
}
