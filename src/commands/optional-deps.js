/**
 * better optional-deps — analyze optional dependency installation results
 *
 * Reports which optional dependencies are installed, which failed to
 * install (and why), and whether any optional deps have warnings.
 *
 * Usage:
 *   better optional-deps
 *   better optional-deps --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdOptionalDeps(argv) {
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
    printText(`Usage: better optional-deps [options]

Analyze optional dependency installation status.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Shows:
  • Which optional deps are installed (success)
  • Which are missing (install failed or skipped)
  • Optional dep details (version, platform, etc.)
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

  const optionalDeps = pkgJson.optionalDependencies || {};

  if (Object.keys(optionalDeps).length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.optional-deps", count: 0, deps: [] }); return; }
    printText(`\x1b[90mNo optional dependencies defined.\x1b[0m`);
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter optional-deps\x1b[0m\n`);
  }

  const nmPath = path.join(projectRoot, "node_modules");
  const deps = [];

  for (const [name, range] of Object.entries(optionalDeps)) {
    const depDir = path.join(nmPath, name);
    let installed = false;
    let version = null;
    let os = null;
    let cpu = null;

    try {
      const depPkg = JSON.parse(await fs.readFile(path.join(depDir, "package.json"), "utf8"));
      installed = true;
      version = depPkg.version;
      os = depPkg.os;
      cpu = depPkg.cpu;
    } catch {}

    deps.push({ name, range, installed, version, os, cpu });
  }

  const installed = deps.filter(d => d.installed);
  const missing = deps.filter(d => !d.installed);

  if (values.json) {
    printJson({ ok: true, kind: "better.optional-deps", count: deps.length, installed: installed.length, missing: missing.length, deps });
    return;
  }

  printText(`  Optional deps: ${deps.length}  |  Installed: ${installed.length}  |  Missing: ${missing.length}\n`);

  for (const d of deps) {
    const icon = d.installed ? "\x1b[32m✔\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    const ver = d.version ? `@${d.version}` : "";
    const platform = [];
    if (d.os) platform.push(`os: ${d.os.join(",")}`);
    if (d.cpu) platform.push(`cpu: ${d.cpu.join(",")}`);
    const platStr = platform.length > 0 ? `  \x1b[90m(${platform.join(", ")})\x1b[0m` : "";
    printText(`  ${icon}  ${d.installed ? "\x1b[32m" : "\x1b[33m"}${d.name}${ver}\x1b[0m  \x1b[90m${d.range}\x1b[0m${platStr}`);
    if (!d.installed) printText(`       \x1b[90mNot installed — may have failed due to platform/cpu incompatibility\x1b[0m`);
  }
  printText("");
}
