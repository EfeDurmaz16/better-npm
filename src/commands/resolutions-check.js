/**
 * better resolutions-check — validate resolutions/overrides entries
 *
 * Checks that all packages listed in resolutions (Yarn) or overrides
 * (npm 8.3+) are actually installed and that the resolved versions
 * match what's specified.
 *
 * Usage:
 *   better resolutions-check
 *   better resolutions-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function extractPackageName(resolution) {
  // Handles: "foo", "foo@1.2.3", "**/foo", "foo/**/bar"
  const parts = resolution.split("/");
  const last = parts[parts.length - 1];
  return last.replace(/@.+$/, "");
}

export async function cmdResolutionsCheck(argv) {
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
    printText(`Usage: better resolutions-check [options]

Validate resolutions/overrides entries in package.json.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • resolutions (Yarn) and overrides (npm 8.3+) fields
  • Whether each resolved package is actually installed
  • Version match between resolution and installed package
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter resolutions-check\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const resolutions = pkgJson.resolutions || {};
  const overrides = pkgJson.overrides || {};
  const allEntries = { ...resolutions, ...overrides };

  if (Object.keys(allEntries).length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.resolutions-check", count: 0, entries: [] }); return; }
    printText(`  \x1b[90mNo resolutions or overrides defined.\x1b[0m\n`);
    return;
  }

  const entries = [];
  for (const [key, version] of Object.entries(allEntries)) {
    const pkgName = extractPackageName(key);
    const source = key in resolutions ? "resolutions" : "overrides";

    let installed = false;
    let installedVersion = null;
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(nmPath, pkgName, "package.json"), "utf8"));
      installed = true;
      installedVersion = pkg.version;
    } catch {}

    const cleanVersion = String(version).replace(/^[~^>=<]+/, "");
    const versionMatch = installedVersion === cleanVersion;
    const issue = !installed
      ? "Package not installed"
      : !versionMatch
        ? `Version mismatch: expected ${cleanVersion}, installed ${installedVersion}`
        : null;

    entries.push({ key, pkgName, version: String(version), installedVersion, installed, versionMatch, issue, source, ok: installed && versionMatch });
  }

  const ok = entries.every(e => e.ok);

  if (values.json) {
    printJson({ ok, kind: "better.resolutions-check", count: entries.length, entries });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const e of entries) {
    const icon = e.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    const sourceTag = `\x1b[90m(${e.source})\x1b[0m`;
    printText(`  ${icon}  \x1b[1m${e.key}\x1b[0m → ${e.version}  ${sourceTag}`);
    if (e.issue) printText(`       \x1b[33m${e.issue}\x1b[0m`);
  }

  if (!ok) {
    printText(`\n\x1b[33m⚠ Some resolutions may not be effective. Reinstall dependencies.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\n\x1b[32m✔ All resolutions/overrides are applied.\x1b[0m`);
  }
  printText("");
}
