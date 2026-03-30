/**
 * better peer-conflicts — detect peer dependency conflicts
 *
 * Analyzes installed packages to find peer dependency version conflicts,
 * where multiple packages require incompatible versions of the same peer.
 *
 * Usage:
 *   better peer-conflicts
 *   better peer-conflicts --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function versionSatisfies(version, range) {
  if (!range || range === "*") return true;
  const v = version.replace(/^[^0-9]*/, "").split(".").map(Number);
  const parts = range.split("||").map(s => s.trim());
  return parts.some(part => {
    const m = part.match(/^([><=!~^]+)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return true;
    const op = m[1] || "=";
    const major = parseInt(m[2], 10);
    const minor = m[3] !== undefined ? parseInt(m[3], 10) : -1;
    const patch = m[4] !== undefined ? parseInt(m[4], 10) : -1;
    const vMaj = v[0] || 0, vMin = v[1] || 0, vPat = v[2] || 0;
    if (op === ">=" || op === "^") {
      if (vMaj !== major) return vMaj > major;
      if (minor < 0) return true;
      if (vMin !== minor) return vMin > minor;
      return patch < 0 || vPat >= patch;
    }
    if (op === ">") return vMaj > major || (vMaj === major && vMin > minor);
    if (op === "<") return vMaj < major || (vMaj === major && vMin < minor);
    if (op === "<=") return vMaj < major || (vMaj === major && vMin <= minor);
    if (op === "~") return vMaj === major && (minor < 0 || vMin === minor);
    if (op === "=" || op === "") return vMaj === major && (minor < 0 || vMin === minor);
    return true;
  });
}

export async function cmdPeerConflicts(argv) {
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
    printText(`Usage: better peer-conflicts [options]

Detect peer dependency version conflicts in node_modules.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Finds cases where multiple packages require incompatible versions
of the same peer dependency.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter peer-conflicts\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning peer dependencies...\x1b[0m\n`);
  }

  // Collect all packages and their peerDependencies
  let pkgDirs = [];
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymlink()) continue;
      if (e.name.startsWith("@")) {
        const scopeDir = path.join(nmPath, e.name);
        try {
          const scoped = await fs.readdir(scopeDir, { withFileTypes: true });
          for (const s of scoped) {
            if (s.isDirectory() || s.isSymlink()) pkgDirs.push(path.join(scopeDir, s.name));
          }
        } catch {}
      } else if (!e.name.startsWith(".")) {
        pkgDirs.push(path.join(nmPath, e.name));
      }
    }
  } catch {
    const msg = "Cannot read node_modules";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // peerRequirements: peerName → [ { requiredBy, range } ]
  const peerRequirements = new Map();
  // installed versions
  const installedVersions = new Map();

  const BATCH = 20;
  for (let i = 0; i < pkgDirs.length; i += BATCH) {
    const batch = pkgDirs.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dir) => {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
        if (pkg.name) installedVersions.set(pkg.name, pkg.version);
        for (const [peer, range] of Object.entries(pkg.peerDependencies || {})) {
          const list = peerRequirements.get(peer) || [];
          list.push({ requiredBy: pkg.name, range });
          peerRequirements.set(peer, list);
        }
      } catch {}
    }));
  }

  // Find conflicts
  const conflicts = [];
  for (const [peer, requirements] of peerRequirements.entries()) {
    if (requirements.length < 2) continue;
    const installed = installedVersions.get(peer);
    const satisfied = requirements.map(r => ({
      ...r,
      ok: installed ? versionSatisfies(installed, r.range) : false,
    }));
    const unsatisfied = satisfied.filter(r => !r.ok);
    if (unsatisfied.length > 0) {
      conflicts.push({ peer, installed: installed || null, requirements: satisfied, unsatisfied });
    }
  }

  // Also find peers required but not installed
  const missing = [];
  for (const [peer, requirements] of peerRequirements.entries()) {
    if (!installedVersions.has(peer)) {
      missing.push({ peer, requirements });
    }
  }

  const ok = conflicts.length === 0 && missing.length === 0;

  if (values.json) {
    printJson({
      ok,
      kind: "better.peer-conflicts",
      scanned: pkgDirs.length,
      conflicts,
      missing,
    });
    if (!ok) process.exitCode = 1;
    return;
  }

  printText(`  Scanned: ${pkgDirs.length} packages  |  Conflicts: ${conflicts.length}  |  Missing: ${missing.length}\n`);

  if (conflicts.length === 0 && missing.length === 0) {
    printText(`\x1b[32m✔ No peer dependency conflicts found.\x1b[0m`);
  } else {
    for (const c of conflicts) {
      printText(`  \x1b[31m✘\x1b[0m  \x1b[1m${c.peer}\x1b[0m@${c.installed || "not installed"}`);
      for (const r of c.requirements) {
        const icon = r.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
        printText(`       ${icon} required ${r.range} by \x1b[90m${r.requiredBy}\x1b[0m`);
      }
    }
    for (const m of missing.slice(0, 10)) {
      printText(`  \x1b[33m⚠\x1b[0m  \x1b[1m${m.peer}\x1b[0m  \x1b[33mnot installed\x1b[0m`);
      for (const r of m.requirements.slice(0, 3)) {
        printText(`       required ${r.range} by \x1b[90m${r.requiredBy}\x1b[0m`);
      }
    }
    if (missing.length > 10) {
      printText(`  \x1b[90m... and ${missing.length - 10} more missing peers\x1b[0m`);
    }
    process.exitCode = 1;
  }
  printText("");
}
