/**
 * better peer-deps — check for peer dependency issues
 *
 * Scans installed packages for peer dependencies and checks
 * whether they are satisfied by your installed packages.
 *
 * Usage:
 *   better peer-deps
 *   better peer-deps --missing-only
 *   better peer-deps --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function semverSatisfies(version, range) {
  if (!range || range === "*" || range === "") return true;
  const v = String(version).replace(/^v/, "").split(".").map(Number);
  const major = v[0] || 0;
  const minor = v[1] || 0;
  const patch = v[2] || 0;

  // Handle || ranges
  if (range.includes("||")) {
    return range.split("||").some(r => semverSatisfies(version, r.trim()));
  }

  // Handle space-separated conditions
  const conditions = range.trim().split(/\s+(?=[><=^~!])/);
  for (const cond of conditions) {
    const m = cond.trim().match(/^([><=~^!]{0,2})\s*(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/);
    if (!m) continue;
    const op = m[1] || "=";
    const cMaj = parseInt(m[2]);
    const cMin = m[3] && !["x","X","*"].includes(m[3]) ? parseInt(m[3]) : -1;
    const cPat = m[4] && !["x","X","*"].includes(m[4]) ? parseInt(m[4]) : -1;

    let ok = true;
    if (op === "^") {
      ok = major === cMaj && (cMin < 0 || minor > cMin || (minor === cMin && (cPat < 0 || patch >= cPat)));
    } else if (op === "~") {
      ok = major === cMaj && (cMin < 0 || (minor === cMin && (cPat < 0 || patch >= cPat)));
    } else if (op === ">=") {
      ok = major > cMaj || (major === cMaj && (cMin < 0 || minor > cMin || (minor === cMin && (cPat < 0 || patch >= cPat))));
    } else if (op === ">") {
      ok = major > cMaj || (major === cMaj && (minor > cMin || (minor === cMin && patch > cPat)));
    } else if (op === "<=") {
      ok = major < cMaj || (major === cMaj && (cMin < 0 || minor < cMin || (minor === cMin && (cPat < 0 || patch <= cPat))));
    } else if (op === "<") {
      ok = major < cMaj || (major === cMaj && (cMin < 0 || minor < cMin || (minor === cMin && cPat >= 0 && patch < cPat)));
    } else if (op === "!=" || op === "!") {
      ok = !(major === cMaj && (cMin < 0 || minor === cMin) && (cPat < 0 || patch === cPat));
    } else {
      // Exact or no op
      ok = major === cMaj && (cMin < 0 || minor === cMin) && (cPat < 0 || patch === cPat);
    }
    if (!ok) return false;
  }
  return true;
}

export async function cmdPeerDeps(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:          { type: "boolean", default: runtime.json === true },
      help:          { type: "boolean", short: "h", default: false },
      "missing-only":{ type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better peer-deps [options]

Check for peer dependency issues in installed packages.

Options:
  --missing-only   Show only missing peer deps
  --json           Machine-readable output
  -h, --help       Show this help
`);
    return;
  }

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
  const allDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
  };

  // Build installed versions map
  const installedVersions = {};
  for (const dep of Object.keys(allDeps)) {
    try {
      const depPkg = JSON.parse(await fs.readFile(path.join(nmPath, dep, "package.json"), "utf8"));
      installedVersions[dep] = depPkg.version;
    } catch {}
  }

  // Scan all installed packages for peer deps
  const peerIssues = [];
  let pkgDirs;
  try { pkgDirs = await fs.readdir(nmPath); } catch { pkgDirs = []; }

  for (const name of pkgDirs) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    let depPkg;
    try {
      depPkg = JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
    } catch { continue; }

    const peers = depPkg.peerDependencies || {};
    for (const [peer, range] of Object.entries(peers)) {
      const installed = installedVersions[peer];
      if (!installed) {
        // Check if it's in peerDependenciesMeta as optional
        const isOptional = depPkg.peerDependenciesMeta?.[peer]?.optional;
        peerIssues.push({
          package: name,
          peer,
          required: range,
          installed: null,
          satisfied: false,
          optional: isOptional || false,
          issue: "missing",
        });
      } else if (!semverSatisfies(installed, range)) {
        peerIssues.push({
          package: name,
          peer,
          required: range,
          installed,
          satisfied: false,
          optional: false,
          issue: "version-mismatch",
        });
      } else if (!values["missing-only"]) {
        peerIssues.push({
          package: name,
          peer,
          required: range,
          installed,
          satisfied: true,
          optional: false,
          issue: null,
        });
      }
    }
  }

  const unsatisfied = peerIssues.filter(p => !p.satisfied && !p.optional);
  const missing = unsatisfied.filter(p => p.issue === "missing");
  const mismatched = unsatisfied.filter(p => p.issue === "version-mismatch");
  const satisfied = peerIssues.filter(p => p.satisfied);

  const allOk = unsatisfied.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.peer-deps",
      checked: peerIssues.length,
      satisfied: satisfied.length,
      missing: missing.length,
      mismatched: mismatched.length,
      issues: unsatisfied,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter peer-deps\x1b[0m\n`);

  if (allOk && peerIssues.length === 0) {
    printText(`\x1b[90mNo peer dependencies found.\x1b[0m`);
    return;
  }

  if (allOk) {
    printText(`\x1b[32m✔ All peer dependencies satisfied (${satisfied.length} total).\x1b[0m`);
    return;
  }

  if (missing.length > 0) {
    printText(`\x1b[31m${missing.length} missing peer dep(s):\x1b[0m\n`);
    for (const issue of missing.slice(0, 10)) {
      printText(`  \x1b[31m✖\x1b[0m  ${issue.package} requires ${issue.peer}@${issue.required}`);
      printText(`       \x1b[90m→ npm install ${issue.peer}\x1b[0m`);
    }
    printText("");
  }

  if (mismatched.length > 0) {
    printText(`\x1b[33m${mismatched.length} mismatched peer dep(s):\x1b[0m\n`);
    for (const issue of mismatched.slice(0, 10)) {
      printText(`  \x1b[33m⚠\x1b[0m  ${issue.package} requires ${issue.peer}@${issue.required}`);
      printText(`       \x1b[90m→ installed: ${issue.installed}\x1b[0m`);
    }
    printText("");
  }

  process.exitCode = 1;
}
