/**
 * better license-compat — check license compatibility
 *
 * Determines whether the licenses of your dependencies are
 * compatible with your project's declared license.
 *
 * Usage:
 *   better license-compat
 *   better license-compat --project MIT
 *   better license-compat --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// License compatibility matrix
// key = dep license, value = set of project licenses it's compatible with
const COMPAT = {
  // Permissive — compatible with everything
  "MIT":       { type: "permissive", compatibleWith: ["MIT","ISC","BSD-2-Clause","BSD-3-Clause","Apache-2.0","GPL-2.0","GPL-3.0","LGPL-2.1","LGPL-3.0","AGPL-3.0","proprietary"] },
  "ISC":       { type: "permissive", compatibleWith: ["MIT","ISC","BSD-2-Clause","BSD-3-Clause","Apache-2.0","GPL-2.0","GPL-3.0","LGPL-2.1","LGPL-3.0","AGPL-3.0","proprietary"] },
  "BSD-2-Clause": { type: "permissive", compatibleWith: ["MIT","ISC","BSD-2-Clause","BSD-3-Clause","Apache-2.0","GPL-2.0","GPL-3.0","LGPL-2.1","LGPL-3.0","AGPL-3.0","proprietary"] },
  "BSD-3-Clause": { type: "permissive", compatibleWith: ["MIT","ISC","BSD-2-Clause","BSD-3-Clause","Apache-2.0","GPL-2.0","GPL-3.0","LGPL-2.1","LGPL-3.0","AGPL-3.0","proprietary"] },
  "CC0-1.0":   { type: "public-domain", compatibleWith: ["MIT","ISC","BSD-2-Clause","BSD-3-Clause","Apache-2.0","GPL-2.0","GPL-3.0","LGPL-2.1","LGPL-3.0","AGPL-3.0","proprietary"] },
  "Unlicense": { type: "public-domain", compatibleWith: ["MIT","ISC","BSD-2-Clause","BSD-3-Clause","Apache-2.0","GPL-2.0","GPL-3.0","LGPL-2.1","LGPL-3.0","AGPL-3.0","proprietary"] },
  "0BSD":      { type: "permissive", compatibleWith: ["MIT","ISC","BSD-2-Clause","BSD-3-Clause","Apache-2.0","GPL-2.0","GPL-3.0","LGPL-2.1","LGPL-3.0","AGPL-3.0","proprietary"] },

  // Apache — compatible with GPL-3 but not GPL-2
  "Apache-2.0":{ type: "permissive", compatibleWith: ["Apache-2.0","GPL-3.0","LGPL-3.0","AGPL-3.0","proprietary"] },

  // LGPL — can be used in proprietary, but derivatives must be LGPL
  "LGPL-2.0":  { type: "weak-copyleft", compatibleWith: ["GPL-2.0","GPL-3.0","LGPL-2.0","LGPL-2.1","LGPL-3.0","AGPL-3.0"] },
  "LGPL-2.1":  { type: "weak-copyleft", compatibleWith: ["GPL-2.0","GPL-3.0","LGPL-2.1","LGPL-3.0","AGPL-3.0"] },
  "LGPL-3.0":  { type: "weak-copyleft", compatibleWith: ["GPL-3.0","LGPL-3.0","AGPL-3.0"] },

  // GPL — strong copyleft
  "GPL-2.0":   { type: "copyleft", compatibleWith: ["GPL-2.0","GPL-3.0","AGPL-3.0"] },
  "GPL-3.0":   { type: "copyleft", compatibleWith: ["GPL-3.0","AGPL-3.0"] },
  "AGPL-3.0":  { type: "copyleft", compatibleWith: ["AGPL-3.0"] },

  // Mozilla
  "MPL-2.0":   { type: "weak-copyleft", compatibleWith: ["MIT","ISC","Apache-2.0","GPL-2.0","GPL-3.0","LGPL-2.1","LGPL-3.0","AGPL-3.0","MPL-2.0"] },
};

function normalizeLicense(license) {
  if (!license) return "UNKNOWN";
  if (typeof license === "object") {
    return license.type || license.name || "UNKNOWN";
  }
  return String(license)
    .replace(/\(|\)/g, "")
    .trim()
    .split(/\s+OR\s+/)[0] // Take first OR option
    .trim();
}

function checkCompat(depLicense, projectLicense) {
  const info = COMPAT[depLicense];
  if (!info) return { ok: null, reason: "unknown license" };
  if (info.compatibleWith.includes(projectLicense)) return { ok: true };
  if (info.type === "copyleft") {
    return { ok: false, reason: `${depLicense} is copyleft — incompatible with ${projectLicense}` };
  }
  return { ok: false, reason: `${depLicense} may not be compatible with ${projectLicense}` };
}

export async function cmdLicenseCompat(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      project: { type: "string" },
      dev:     { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better license-compat [options]

Check if dependency licenses are compatible with your project license.

Options:
  --project <license>  Override project license (default: from package.json)
  --dev                Include devDependencies
  --json               Machine-readable output
  -h, --help           Show this help

Supported licenses: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0,
  LGPL-2.1, LGPL-3.0, GPL-2.0, GPL-3.0, AGPL-3.0, MPL-2.0, CC0-1.0
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

  const projectLicense = values.project || normalizeLicense(pkgJson.license) || "MIT";
  const nmPath = path.join(projectRoot, "node_modules");

  const deps = [
    ...Object.keys(pkgJson.dependencies || {}),
    ...(values.dev ? Object.keys(pkgJson.devDependencies || {}) : []),
  ];

  const results = [];

  for (const name of deps) {
    let depLicense = "UNKNOWN";
    try {
      const depPkg = JSON.parse(
        await fs.readFile(path.join(nmPath, name, "package.json"), "utf8")
      );
      depLicense = normalizeLicense(depPkg.license);
    } catch {}

    const compat = checkCompat(depLicense, projectLicense);
    results.push({ name, license: depLicense, ...compat });
  }

  const incompatible = results.filter(r => r.ok === false);
  const unknown = results.filter(r => r.ok === null);
  const compatible = results.filter(r => r.ok === true);
  const allOk = incompatible.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.license-compat",
      projectLicense,
      checked: results.length,
      compatible: compatible.length,
      incompatible: incompatible.length,
      unknown: unknown.length,
      incompatibleList: incompatible.map(r => ({ name: r.name, license: r.license, reason: r.reason })),
      unknownList: unknown.map(r => ({ name: r.name, license: r.license })),
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter license-compat\x1b[0m — project: \x1b[1m${projectLicense}\x1b[0m\n`);
  printText(`  Checked: ${results.length} packages`);
  printText(`  Compatible: \x1b[32m${compatible.length}\x1b[0m`);
  printText(`  Incompatible: \x1b[31m${incompatible.length}\x1b[0m`);
  printText(`  Unknown: \x1b[90m${unknown.length}\x1b[0m`);
  printText("");

  if (incompatible.length > 0) {
    printText(`\x1b[31m✖ Incompatible licenses:\x1b[0m`);
    for (const r of incompatible) {
      printText(`  \x1b[31m✖\x1b[0m  ${r.name.padEnd(30)} ${r.license}`);
      printText(`       \x1b[90m→ ${r.reason}\x1b[0m`);
    }
    printText("");
    process.exitCode = 1;
  }

  if (unknown.length > 0) {
    printText(`\x1b[90m${unknown.length} package(s) have unknown or unusual licenses:\x1b[0m`);
    for (const r of unknown.slice(0, 5)) {
      printText(`  \x1b[90m?  ${r.name.padEnd(30)} ${r.license}\x1b[0m`);
    }
    if (unknown.length > 5) printText(`  \x1b[90m...and ${unknown.length - 5} more\x1b[0m`);
    printText("");
  }

  if (allOk && incompatible.length === 0) {
    printText(`\x1b[32m✔ All known licenses are compatible with ${projectLicense}.\x1b[0m`);
  }
}
