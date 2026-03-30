/**
 * better peer-check — comprehensive peer dependency analysis
 *
 * Scans all installed packages for peer dependency requirements,
 * checks if they are satisfied, and reports conflicts or missing peers.
 *
 * Usage:
 *   better peer-check
 *   better peer-check --strict
 *   better peer-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parseVersion(v) {
  const m = String(v || "0").replace(/[^0-9.]/g, "").split(".");
  return [parseInt(m[0]) || 0, parseInt(m[1]) || 0, parseInt(m[2]) || 0];
}

function satisfiesPeer(installed, range) {
  if (!range || range === "*" || range === "") return true;
  const [maj, min, pat] = parseVersion(installed);
  // Handle OR ranges
  const orParts = range.split(/\s*\|\|\s*/);
  return orParts.some(part => {
    const andParts = part.trim().split(/\s+/);
    return andParts.every(constraint => {
      const m = constraint.match(/^([><=!^~]*)\s*(\d[\d.x*]*)$/);
      if (!m) return true;
      const op = m[1];
      const [rmaj, rmin, rpat] = parseVersion(m[2]);
      if (op === ">=" || op === "") {
        return !(maj < rmaj || (maj === rmaj && min < rmin) || (maj === rmaj && min === rmin && pat < rpat));
      } else if (op === ">") {
        return maj > rmaj || (maj === rmaj && min > rmin) || (maj === rmaj && min === rmin && pat > rpat);
      } else if (op === "<=") {
        return !(maj > rmaj || (maj === rmaj && min > rmin) || (maj === rmaj && min === rmin && pat > rpat));
      } else if (op === "<") {
        return maj < rmaj || (maj === rmaj && min < rmin) || (maj === rmaj && min === rmin && pat < rpat);
      } else if (op === "^") {
        return maj === rmaj && (min > rmin || (min === rmin && pat >= rpat));
      } else if (op === "~") {
        return maj === rmaj && min === rmin && pat >= rpat;
      }
      return true;
    });
  });
}

async function readPkg(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")); } catch { return null; }
}

export async function cmdPeerCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      strict: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better peer-check [options]

Analyze peer dependency requirements across all installed packages.

Options:
  --strict     Fail on optional peer dep warnings too
  --json       Machine-readable output
  -h, --help   Show this help

Reports:
  • Missing required peer dependencies
  • Version conflicts (installed version doesn't satisfy range)
  • Optional peer dependencies that are missing
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  try { await fs.access(nmPath); } catch {
    const msg = "node_modules not found — run npm install first";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter peer-check\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning peer dependencies…\x1b[0m\n`);
  }

  // Build installed versions map
  const installed = {};
  let entries;
  try { entries = await fs.readdir(nmPath, { withFileTypes: true }); } catch { entries = []; }

  const readPkgs = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      if (e.name.startsWith("@")) {
        let subEntries;
        try { subEntries = await fs.readdir(path.join(nmPath, e.name), { withFileTypes: true }); } catch { continue; }
        for (const sub of subEntries) {
          if (sub.isDirectory()) readPkgs.push(path.join(nmPath, e.name, sub.name));
        }
      } else {
        readPkgs.push(path.join(nmPath, e.name));
      }
    }
  }

  const BATCH = 20;
  const packagesWithPeers = [];
  for (let i = 0; i < readPkgs.length; i += BATCH) {
    const batch = readPkgs.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dir) => {
      const pkg = await readPkg(dir);
      if (!pkg?.name) return;
      installed[pkg.name] = pkg.version || "0.0.0";
      if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0) {
        packagesWithPeers.push(pkg);
      }
    }));
  }

  // Also add project itself
  const rootPkg = await readPkg(projectRoot);
  if (rootPkg) installed[rootPkg.name || "__root__"] = rootPkg.version || "0.0.0";

  // Check peer deps
  const issues = [];
  for (const pkg of packagesWithPeers) {
    const optionalPeers = new Set(Object.keys(pkg.peerDependenciesMeta || {}).filter(k => pkg.peerDependenciesMeta[k]?.optional));

    for (const [peerName, peerRange] of Object.entries(pkg.peerDependencies)) {
      const isOptional = optionalPeers.has(peerName);
      const installedVersion = installed[peerName];

      if (!installedVersion) {
        issues.push({
          source: pkg.name,
          peer: peerName,
          required: peerRange,
          installed: null,
          optional: isOptional,
          severity: isOptional ? "warning" : "error",
          message: `${pkg.name} requires peer ${peerName}@${peerRange} — not installed`,
        });
      } else if (!satisfiesPeer(installedVersion, peerRange)) {
        issues.push({
          source: pkg.name,
          peer: peerName,
          required: peerRange,
          installed: installedVersion,
          optional: isOptional,
          severity: "error",
          message: `${pkg.name} requires peer ${peerName}@${peerRange} but ${installedVersion} is installed`,
        });
      }
    }
  }

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  const allOk = errors.length === 0 && (!values.strict || warnings.length === 0);

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.peer-check",
      scanned: packagesWithPeers.length,
      issues,
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`  Scanned ${packagesWithPeers.length} packages with peer deps\n`);

  if (issues.length === 0) {
    printText(`\x1b[32m✔ All peer dependencies satisfied.\x1b[0m`);
  } else {
    for (const iss of errors) {
      printText(`  \x1b[31m✖\x1b[0m  ${iss.message}`);
    }
    for (const iss of warnings) {
      printText(`  \x1b[33m⚠\x1b[0m  ${iss.message} \x1b[90m(optional)\x1b[0m`);
    }
    printText("");
    if (errors.length > 0) {
      printText(`\x1b[31m✖ ${errors.length} peer dependency conflict(s).\x1b[0m`);
      process.exitCode = 1;
    } else {
      printText(`\x1b[33m⚠ ${warnings.length} optional peer dep(s) missing.\x1b[0m`);
      if (values.strict) process.exitCode = 1;
    }
  }
  printText("");
}
