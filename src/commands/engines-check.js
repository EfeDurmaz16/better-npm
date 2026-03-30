/**
 * better engines-check — validate Node.js/npm engine compatibility
 *
 * Checks all installed packages' engines fields against the current
 * Node.js and npm versions to detect incompatibilities.
 *
 * Usage:
 *   better engines-check
 *   better engines-check --strict
 *   better engines-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parseVersionParts(v) {
  const m = String(v || "0").replace(/[^0-9.]/g, "").split(".");
  return [parseInt(m[0]) || 0, parseInt(m[1]) || 0, parseInt(m[2]) || 0];
}

function satisfiesEngine(range, version) {
  if (!range || range === "*" || range === "") return true;
  const [maj, min, pat] = parseVersionParts(version);
  const parts = range.split(/\s+/);
  for (const part of parts) {
    const m = part.match(/^([><=!^~]*)\s*(\d[\d.x*]*)$/);
    if (!m) continue;
    const op = m[1];
    const [rmaj, rmin, rpat] = parseVersionParts(m[2]);
    if (op === ">=" || op === "") {
      if (maj < rmaj || (maj === rmaj && min < rmin) || (maj === rmaj && min === rmin && pat < rpat)) return false;
    } else if (op === ">") {
      if (maj < rmaj || (maj === rmaj && min < rmin) || (maj === rmaj && min === rmin && pat <= rpat)) return false;
    } else if (op === "<=") {
      if (maj > rmaj || (maj === rmaj && min > rmin) || (maj === rmaj && min === rmin && pat > rpat)) return false;
    } else if (op === "<") {
      if (maj > rmaj || (maj === rmaj && min > rmin) || (maj === rmaj && min === rmin && pat >= rpat)) return false;
    } else if (op === "^") {
      if (maj !== rmaj || min < rmin || (min === rmin && pat < rpat)) return false;
    } else if (op === "~") {
      if (maj !== rmaj || min !== rmin || pat < rpat) return false;
    } else if (op === "==" || op === "") {
      if (maj !== rmaj || min !== rmin || pat !== rpat) return false;
    }
  }
  return true;
}

async function scanPackages(nmPath) {
  const results = [];
  let entries;
  try { entries = await fs.readdir(nmPath); } catch { return results; }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const pkgDir = entry.startsWith("@")
      ? path.join(nmPath, entry)
      : null;
    if (pkgDir) {
      let subEntries;
      try { subEntries = await fs.readdir(pkgDir); } catch { continue; }
      for (const sub of subEntries) {
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, sub, "package.json"), "utf8"));
          if (pkg.engines) results.push({ name: pkg.name || `${entry}/${sub}`, engines: pkg.engines });
        } catch {}
      }
    } else {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(nmPath, entry, "package.json"), "utf8"));
        if (pkg.engines) results.push({ name: pkg.name || entry, engines: pkg.engines });
      } catch {}
    }
  }
  return results;
}

export async function cmdEnginesCheck(argv) {
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
    printText(`Usage: better engines-check [options]

Check Node.js/npm engine requirements of all installed packages.

Options:
  --strict     Fail on warnings (missing engines field in project)
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const nodeVersion = process.version.replace(/^v/, "");
  const npmResult = spawnSync("npm", ["--version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const npmVersion = (npmResult.stdout || "").trim();

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter engines-check\x1b[0m`);
    printText(`  Node.js: v${nodeVersion}  npm: v${npmVersion}\n`);
  }

  const nmPath = path.join(projectRoot, "node_modules");
  const packages = await scanPackages(nmPath);

  const issues = [];

  for (const pkg of packages) {
    const nodeRange = pkg.engines.node;
    const npmRange = pkg.engines.npm;

    if (nodeRange && !satisfiesEngine(nodeRange, nodeVersion)) {
      issues.push({ name: pkg.name, engine: "node", required: nodeRange, current: nodeVersion, severity: "error" });
    }
    if (npmRange && !satisfiesEngine(npmRange, npmVersion)) {
      issues.push({ name: pkg.name, engine: "npm", required: npmRange, current: npmVersion, severity: "warning" });
    }
  }

  // Check project's own engines field
  const projectWarnings = [];
  if (!pkgJson.engines) {
    projectWarnings.push({ message: "No engines field in package.json — recommend specifying node version" });
  }

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  const allOk = errors.length === 0 && (values.strict ? warnings.length === 0 && projectWarnings.length === 0 : true);

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.engines-check",
      nodeVersion,
      npmVersion,
      scanned: packages.length,
      issues,
      projectWarnings,
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`  Scanned ${packages.length} packages with engines fields\n`);

  if (issues.length === 0 && projectWarnings.length === 0) {
    printText(`\x1b[32m✔ All engine requirements satisfied.\x1b[0m`);
  } else {
    for (const issue of errors) {
      printText(`  \x1b[31m✖\x1b[0m  ${issue.name}: requires ${issue.engine}${issue.required} (current: ${issue.current})`);
    }
    for (const issue of warnings) {
      printText(`  \x1b[33m⚠\x1b[0m  ${issue.name}: recommends ${issue.engine}${issue.required} (current: ${issue.current})`);
    }
    for (const w of projectWarnings) {
      printText(`  \x1b[33m⚠\x1b[0m  ${w.message}`);
    }

    printText("");
    if (errors.length > 0) {
      printText(`\x1b[31m✖ ${errors.length} package(s) incompatible with Node.js v${nodeVersion}\x1b[0m`);
      process.exitCode = 1;
    } else {
      printText(`\x1b[33m⚠ ${warnings.length + projectWarnings.length} warning(s).\x1b[0m`);
      if (values.strict) process.exitCode = 1;
    }
  }
  printText("");
}
