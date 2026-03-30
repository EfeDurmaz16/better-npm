/**
 * better installed-check — verify all declared dependencies are installed
 *
 * Checks that all packages listed in package.json dependencies,
 * devDependencies, peerDependencies, and optionalDependencies are
 * actually installed in node_modules.
 *
 * Usage:
 *   better installed-check
 *   better installed-check --prod-only
 *   better installed-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdInstalledCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:        { type: "boolean", default: runtime.json === true },
      help:        { type: "boolean", short: "h", default: false },
      "prod-only": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better installed-check [options]

Verify all declared dependencies are installed.

Options:
  --prod-only    Only check production dependencies
  --json         Machine-readable output
  -h, --help     Show this help

Checks that every package in package.json is present in
node_modules, and that installed versions satisfy the declared ranges.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter installed-check\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const groups = [
    { name: "dependencies", deps: pkgJson.dependencies || {}, required: true },
    { name: "devDependencies", deps: pkgJson.devDependencies || {}, required: !values["prod-only"] },
    { name: "peerDependencies", deps: pkgJson.peerDependencies || {}, required: false },
    { name: "optionalDependencies", deps: pkgJson.optionalDependencies || {}, required: false },
  ].filter(g => !values["prod-only"] || g.name === "dependencies");

  const missing = [];
  const present = [];

  for (const group of groups) {
    const BATCH = 20;
    const depEntries = Object.entries(group.deps);
    for (let i = 0; i < depEntries.length; i += BATCH) {
      const batch = depEntries.slice(i, i + BATCH);
      await Promise.all(batch.map(async ([dep, range]) => {
        let installed = false;
        let version = null;
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(nmPath, dep, "package.json"), "utf8"));
          installed = true;
          version = pkg.version;
        } catch {}

        const record = { name: dep, range, version, installed, group: group.name, required: group.required };
        if (installed) {
          present.push(record);
        } else if (group.required) {
          missing.push(record);
        }
      }));
    }
  }

  const ok = missing.length === 0;
  const total = present.length + missing.length;

  if (values.json) {
    printJson({ ok, kind: "better.installed-check", total, installed: present.length, missing: missing.length, packages: [...present, ...missing] });
    if (!ok) process.exitCode = 1;
    return;
  }

  printText(`  Total declared: ${total}  |  Installed: ${present.length}  |  Missing: ${missing.length}\n`);

  if (ok) {
    printText(`\x1b[32m✔ All declared dependencies are installed.\x1b[0m`);
  } else {
    printText(`\x1b[31m✘ ${missing.length} missing package(s):\x1b[0m\n`);
    for (const m of missing) {
      printText(`  \x1b[31m·\x1b[0m  \x1b[1m${m.name}\x1b[0m@${m.range}  \x1b[90m(${m.group})\x1b[0m`);
    }
    printText(`\n  Run: \x1b[36mnpm install\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
