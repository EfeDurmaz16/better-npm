/**
 * better missing-peer-install — generate install commands for missing peer deps
 *
 * Finds missing peer dependencies and generates the exact npm install
 * command needed to satisfy them, with version range resolution.
 *
 * Usage:
 *   better missing-peer-install
 *   better missing-peer-install --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdMissingPeerInstall(argv) {
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
    printText(`Usage: better missing-peer-install [options]

Find missing peer dependencies and generate install commands.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Scans all installed packages for peerDependencies that are not
installed, then generates the npm install commands to fix them.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter missing-peer-install\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning peer dependencies...\x1b[0m\n`);
  }

  // Get all installed top-level packages
  let pkgDirs = [];
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name.startsWith("@")) {
        const scopeDir = path.join(nmPath, e.name);
        try {
          const scoped = await fs.readdir(scopeDir, { withFileTypes: true });
          for (const s of scoped) pkgDirs.push(path.join(scopeDir, s.name));
        } catch {}
      } else {
        pkgDirs.push(path.join(nmPath, e.name));
      }
    }
  } catch {}

  // Collect all peer dep requirements
  const peerReqs = new Map(); // name → Set of ranges
  const BATCH = 20;
  for (let i = 0; i < pkgDirs.length; i += BATCH) {
    const batch = pkgDirs.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dir) => {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
        const peers = pkg.peerDependencies || {};
        const peerMeta = pkg.peerDependenciesMeta || {};
        for (const [dep, range] of Object.entries(peers)) {
          const isOptional = peerMeta[dep]?.optional === true;
          if (isOptional) continue;
          if (!peerReqs.has(dep)) peerReqs.set(dep, new Set());
          peerReqs.get(dep).add(range);
        }
      } catch {}
    }));
  }

  // Check which are missing
  const missing = [];
  for (const [dep, ranges] of peerReqs) {
    try {
      await fs.access(path.join(nmPath, dep, "package.json"));
      // Already installed
    } catch {
      missing.push({ name: dep, ranges: [...ranges] });
    }
  }

  const ok = missing.length === 0;

  if (values.json) {
    printJson({ ok, kind: "better.missing-peer-install", count: missing.length, missing });
    if (!ok) process.exitCode = 1;
    return;
  }

  if (ok) {
    printText(`\x1b[32m✔ All peer dependencies are installed.\x1b[0m\n`);
    return;
  }

  printText(`\x1b[33m⚠ ${missing.length} missing peer dependenc${missing.length === 1 ? "y" : "ies"}:\x1b[0m\n`);

  for (const m of missing) {
    const rangeStr = [...new Set(m.ranges)].join(" | ");
    printText(`  \x1b[33m·\x1b[0m  \x1b[1m${m.name}\x1b[0m  \x1b[90mRequired: ${rangeStr}\x1b[0m`);
  }

  const installCmd = `npm install ${missing.map(m => `${m.name}@"${m.ranges[0]}"`).join(" ")}`;
  printText(`\n\x1b[1mSuggested install command:\x1b[0m`);
  printText(`  \x1b[36m${installCmd}\x1b[0m\n`);
  process.exitCode = 1;
}
