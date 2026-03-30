/**
 * better node-version — manage and check Node.js version requirements
 *
 * Checks the current Node.js version against package.json engines.node,
 * lists installed package engines requirements, and flags conflicts.
 *
 * Usage:
 *   better node-version
 *   better node-version --check
 *   better node-version --set 20
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parseVersion(v) {
  return String(v).replace(/^v/, "").split(".").map(n => parseInt(n) || 0);
}

function satisfiesRange(version, range) {
  if (!range) return true;
  const parts = parseVersion(version);
  const major = parts[0];
  const minor = parts[1];
  const patch = parts[2];

  // Handle || ranges
  if (range.includes("||")) {
    return range.split("||").some(r => satisfiesRange(version, r.trim()));
  }

  // Handle space-separated AND ranges
  const conditions = range.trim().split(/\s+(?=[><=^~])/);
  for (const cond of conditions) {
    if (!satisfiesSingle(major, minor, patch, cond.trim())) return false;
  }
  return true;
}

function satisfiesSingle(major, minor, patch, cond) {
  if (!cond || cond === "*" || cond === "x") return true;

  const m = cond.match(/^([><=~^!]*)\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
  if (!m) return true;

  const op = m[1] || "=";
  const cMajor = parseInt(m[2]);
  const cMinor = m[3] && m[3] !== "x" && m[3] !== "*" ? parseInt(m[3]) : -1;
  const cPatch = m[4] && m[4] !== "x" && m[4] !== "*" ? parseInt(m[4]) : -1;

  if (op === "^") {
    if (major !== cMajor) return false;
    if (cMinor >= 0 && minor < cMinor) return false;
    if (cMinor >= 0 && minor === cMinor && cPatch >= 0 && patch < cPatch) return false;
    return true;
  }
  if (op === "~") {
    if (major !== cMajor) return false;
    if (cMinor >= 0 && minor !== cMinor) return false;
    if (cPatch >= 0 && patch < cPatch) return false;
    return true;
  }
  if (op === ">=" || op === "=>") {
    if (major > cMajor) return true;
    if (major < cMajor) return false;
    if (cMinor < 0) return true;
    if (minor > cMinor) return true;
    if (minor < cMinor) return false;
    if (cPatch < 0) return true;
    return patch >= cPatch;
  }
  if (op === ">") {
    if (major > cMajor) return true;
    if (major < cMajor) return false;
    if (cMinor < 0) return major > cMajor;
    if (minor > cMinor) return true;
    if (minor < cMinor) return false;
    if (cPatch < 0) return minor > cMinor;
    return patch > cPatch;
  }
  if (op === "<=" || op === "=<") {
    if (major < cMajor) return true;
    if (major > cMajor) return false;
    if (cMinor < 0) return true;
    if (minor < cMinor) return true;
    if (minor > cMinor) return false;
    if (cPatch < 0) return true;
    return patch <= cPatch;
  }
  if (op === "<") {
    if (major < cMajor) return true;
    if (major > cMajor) return false;
    if (cMinor < 0) return false;
    if (minor < cMinor) return true;
    if (minor > cMinor) return false;
    if (cPatch < 0) return false;
    return patch < cPatch;
  }
  if (op === "!=" || op === "!") {
    return major !== cMajor || (cMinor >= 0 && minor !== cMinor) || (cPatch >= 0 && patch !== cPatch);
  }
  // Exact or no op
  if (major !== cMajor) return false;
  if (cMinor >= 0 && minor !== cMinor) return false;
  if (cPatch >= 0 && patch !== cPatch) return false;
  return true;
}

export async function cmdNodeVersion(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      check:   { type: "boolean", default: false },
      set:     { type: "string" },
      all:     { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better node-version [options]

Check and manage Node.js version requirements.

Options:
  --check        Exit with error if current Node.js doesn't meet engines.node
  --set <major>  Update engines.node and .nvmrc to the given major version
  --all          Show all packages with engines.node requirements
  --json         Machine-readable output
  -h, --help     Show this help
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

  const currentVersion = process.version.replace(/^v/, "");
  const currentMajor = parseInt(currentVersion);
  const enginesRange = pkgJson.engines?.node || null;

  // Handle --set
  if (values.set) {
    const major = parseInt(values.set);
    if (!major || major < 1) {
      printText(`\x1b[31mInvalid Node.js major version: ${values.set}\x1b[0m`);
      process.exitCode = 1;
      return;
    }
    const newRange = `>=${major}`;
    const updatedPkg = { ...pkgJson, engines: { ...(pkgJson.engines || {}), node: newRange } };
    await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify(updatedPkg, null, 2) + "\n", "utf8");
    await fs.writeFile(path.join(projectRoot, ".nvmrc"), `v${major}\n`, "utf8");
    printText(`\x1b[32m✔ Updated engines.node to ${newRange} and .nvmrc to v${major}\x1b[0m`);
    return;
  }

  // Scan installed packages for engines.node
  const nmPath = path.join(projectRoot, "node_modules");
  const incompatible = [];
  const withEngines = [];

  if (values.all || values.check) {
    let pkgDirs;
    try { pkgDirs = await fs.readdir(nmPath); } catch { pkgDirs = []; }

    const BATCH = 50;
    for (let i = 0; i < pkgDirs.length; i += BATCH) {
      const batch = pkgDirs.slice(i, i + BATCH);
      await Promise.all(batch.map(async (name) => {
        if (name.startsWith(".")) return;
        try {
          const depPkgPath = name.startsWith("@")
            ? null // skip scoped for now
            : path.join(nmPath, name, "package.json");
          if (!depPkgPath) return;
          const dep = JSON.parse(await fs.readFile(depPkgPath, "utf8"));
          const range = dep.engines?.node;
          if (!range) return;
          const ok = satisfiesRange(currentVersion, range);
          withEngines.push({ name, range, compatible: ok });
          if (!ok) incompatible.push({ name, range });
        } catch {}
      }));
    }
  }

  // Check own engines range
  const ownCompatible = enginesRange ? satisfiesRange(currentVersion, enginesRange) : true;

  if (values.json) {
    printJson({
      ok: ownCompatible && incompatible.length === 0,
      kind: "better.node-version",
      current: currentVersion,
      required: enginesRange,
      compatible: ownCompatible,
      incompatibleDeps: incompatible.length,
      ...(values.all ? { allDepsWithEngines: withEngines } : {}),
    });
    if (!ownCompatible) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter node-version\x1b[0m\n`);
  printText(`  Current:   \x1b[1mv${currentVersion}\x1b[0m`);

  if (enginesRange) {
    const icon = ownCompatible ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    printText(`  Required:  ${enginesRange}  ${icon}`);
    if (!ownCompatible) {
      printText(`\n\x1b[31m✖ Current Node.js v${currentVersion} does not satisfy ${enginesRange}\x1b[0m`);
      if (values.check) process.exitCode = 1;
    }
  } else {
    printText(`  Required:  \x1b[90m(not set — add engines.node to package.json)\x1b[0m`);
    printText(`  \x1b[90m→ Run: better init or better node-version --set ${currentMajor}\x1b[0m`);
  }

  // Show nvmrc
  try {
    const nvmrc = (await fs.readFile(path.join(projectRoot, ".nvmrc"), "utf8")).trim();
    printText(`  .nvmrc:    ${nvmrc}`);
  } catch {}

  if (incompatible.length > 0) {
    printText(`\n\x1b[33m${incompatible.length} installed package(s) have incompatible engines.node:\x1b[0m\n`);
    for (const { name, range } of incompatible.slice(0, 10)) {
      printText(`  \x1b[33m⚠\x1b[0m  ${name.padEnd(30)} requires ${range}`);
    }
    if (incompatible.length > 10) printText(`  \x1b[90m...and ${incompatible.length - 10} more\x1b[0m`);
  }

  if (values.all && withEngines.length > 0) {
    printText(`\n\x1b[1mAll packages with engines.node:\x1b[0m\n`);
    for (const { name, range, compatible } of withEngines) {
      const icon = compatible ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
      printText(`  ${icon}  ${name.padEnd(30)} ${range}`);
    }
  }

  printText("");
}
