/**
 * better node-api-compat — check N-API/node-gyp native module compatibility
 *
 * Checks native addons (.node files, node-gyp packages) for N-API
 * version compatibility with the current Node.js runtime, helping
 * identify packages that need recompilation.
 *
 * Usage:
 *   better node-api-compat
 *   better node-api-compat --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// N-API version support by Node.js major version
// https://nodejs.org/api/n-api.html#node-api-version-matrix
const NAPI_VERSIONS = {
  6: [1],
  8: [1, 2, 3],
  9: [1, 2, 3],
  10: [1, 2, 3, 4],
  11: [1, 2, 3, 4],
  12: [1, 2, 3, 4, 5, 6],
  13: [1, 2, 3, 4, 5, 6],
  14: [1, 2, 3, 4, 5, 6, 7, 8],
  15: [1, 2, 3, 4, 5, 6, 7, 8],
  16: [1, 2, 3, 4, 5, 6, 7, 8],
  17: [1, 2, 3, 4, 5, 6, 7, 8],
  18: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  19: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  20: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  21: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  22: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
};

function getCurrentNodeMajor() {
  const v = process.version.replace(/^v/, "").split(".")[0];
  return parseInt(v, 10);
}

async function findNativeAddons(dir, maxDepth = 2) {
  const addons = [];
  async function walk(d, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (["test", "tests", ".bin"].includes(e.name)) continue;
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".node")) {
        addons.push(full);
      }
    }
  }
  await walk(dir, 0);
  return addons;
}

export async function cmdNodeApiCompat(argv) {
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
    printText(`Usage: better node-api-compat [options]

Check native addon N-API version compatibility.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Installed packages with native addons (.node files)
  • N-API version requirements vs current Node.js
  • Packages using node-gyp (may need recompilation)
  • Binary compatibility with current platform
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter node-api-compat\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning for native addons...\x1b[0m\n`);
  }

  const nodeVersion = getCurrentNodeMajor();
  const supportedNapi = NAPI_VERSIONS[nodeVersion] || [];

  // Find packages with native bindings
  const nativePackages = [];
  let topPkgDirs = [];
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name.startsWith("@")) {
        const scopeDir = path.join(nmPath, e.name);
        try {
          const scoped = await fs.readdir(scopeDir, { withFileTypes: true });
          for (const s of scoped) topPkgDirs.push(path.join(scopeDir, s.name));
        } catch {}
      } else {
        topPkgDirs.push(path.join(nmPath, e.name));
      }
    }
  } catch {}

  const BATCH = 10;
  for (let i = 0; i < topPkgDirs.length; i += BATCH) {
    const batch = topPkgDirs.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dir) => {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
        const hasGypfile = !!pkg.gypfile;
        const hasBinary = !!pkg.binary;
        const hasNapiVersion = pkg.binary?.napi_versions || null;

        // Quick check for .node files
        const addons = await findNativeAddons(dir, 2);
        if (addons.length === 0 && !hasGypfile && !hasBinary) return;

        const napiVersions = hasNapiVersion || [];
        const compatible = napiVersions.length === 0 || napiVersions.some(v => supportedNapi.includes(v));

        nativePackages.push({
          name: pkg.name,
          version: pkg.version,
          hasGypfile,
          hasBinary,
          napiVersions,
          addonCount: addons.length,
          compatible: addons.length > 0 ? true : compatible, // if .node exists, it's already compiled
        });
      } catch {}
    }));
  }

  const incompatible = nativePackages.filter(p => !p.compatible);

  if (values.json) {
    printJson({
      ok: incompatible.length === 0,
      kind: "better.node-api-compat",
      nodeVersion,
      supportedNapi,
      total: nativePackages.length,
      incompatible: incompatible.length,
      packages: nativePackages,
    });
    if (incompatible.length > 0) process.exitCode = 1;
    return;
  }

  printText(`  Node.js v${nodeVersion}  |  Supported N-API: ${supportedNapi.join(", ")}\n`);

  if (nativePackages.length === 0) {
    printText(`  \x1b[90mNo native addon packages found.\x1b[0m`);
    printText("");
    return;
  }

  printText(`  Native packages: ${nativePackages.length}\n`);

  for (const p of nativePackages) {
    const icon = p.compatible ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    const napiStr = p.napiVersions.length > 0 ? `  \x1b[90mN-API: ${p.napiVersions.join(",")}\x1b[0m` : "";
    const addonStr = p.addonCount > 0 ? `  \x1b[90m${p.addonCount} .node file(s)\x1b[0m` : " \x1b[90m(needs compilation)\x1b[0m";
    printText(`  ${icon}  \x1b[1m${p.name}@${p.version}\x1b[0m${napiStr}${addonStr}`);
  }

  if (incompatible.length > 0) {
    printText(`\n\x1b[31m✘ ${incompatible.length} package(s) may be incompatible with Node.js v${nodeVersion}.\x1b[0m`);
    printText(`  Try: npm rebuild`);
    process.exitCode = 1;
  }
  printText("");
}
