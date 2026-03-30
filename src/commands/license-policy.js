/**
 * better license-policy — enforce license policies across dependencies
 *
 * Checks installed packages against allowed/blocked license lists,
 * helping teams enforce open-source license compliance policies.
 *
 * Usage:
 *   better license-policy
 *   better license-policy --allow MIT,ISC,Apache-2.0
 *   better license-policy --block GPL,AGPL
 *   better license-policy --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const PERMISSIVE = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "CC0-1.0", "Unlicense", "0BSD", "WTFPL"]);
const COPYLEFT   = new Set(["GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.1", "LGPL-3.0", "GPL-2.0-only", "GPL-3.0-only", "AGPL-3.0-only"]);

function normalizeLicense(license) {
  if (!license) return "UNKNOWN";
  if (typeof license === "object" && license.type) return license.type;
  const s = String(license).trim();
  // Strip parentheses and OR/AND expressions — take first license
  return s.replace(/^\(/, "").replace(/\)$/, "").split(/\s+(?:OR|AND)\s+/)[0].trim();
}

function classifyLicense(license) {
  if (!license || license === "UNKNOWN") return "unknown";
  if (PERMISSIVE.has(license)) return "permissive";
  if (COPYLEFT.has(license)) return "copyleft";
  return "other";
}

export async function cmdLicensePolicy(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:        { type: "boolean", default: runtime.json === true },
      help:        { type: "boolean", short: "h", default: false },
      allow:       { type: "string" },
      block:       { type: "string" },
      "prod-only": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better license-policy [options]

Enforce license policies across dependencies.

Options:
  --allow <list>   Comma-separated list of allowed licenses (SPDX)
  --block <list>   Comma-separated list of blocked licenses (SPDX)
  --prod-only      Only check production dependencies
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better license-policy --allow MIT,ISC,Apache-2.0
  better license-policy --block GPL-3.0,AGPL-3.0

Without flags, shows a license summary categorized by type.
`);
    return;
  }

  const allowList = values.allow ? new Set(values.allow.split(",").map(s => s.trim())) : null;
  const blockList = values.block ? new Set(values.block.split(",").map(s => s.trim())) : null;

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter license-policy\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const depsToCheck = values["prod-only"]
    ? Object.keys(pkgJson.dependencies || {})
    : Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });

  const results = [];
  const BATCH = 20;
  for (let i = 0; i < depsToCheck.length; i += BATCH) {
    const batch = depsToCheck.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dep) => {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(nmPath, dep, "package.json"), "utf8"));
        const rawLicense = pkg.license || pkg.licenses?.[0]?.type || null;
        const license = normalizeLicense(rawLicense);
        const category = classifyLicense(license);
        const blocked = blockList ? blockList.has(license) : false;
        const allowed = allowList ? allowList.has(license) : true;
        results.push({ name: dep, version: pkg.version, license, category, blocked, allowed });
      } catch {}
    }));
  }

  results.sort((a, b) => a.name.localeCompare(b.name));

  const violations = results.filter(r => r.blocked || !r.allowed);
  const ok = violations.length === 0;

  if (values.json) {
    // License summary
    const summary = {};
    for (const r of results) {
      summary[r.license] = (summary[r.license] || 0) + 1;
    }
    printJson({ ok, kind: "better.license-policy", total: results.length, violations: violations.length, summary, packages: results });
    if (!ok) process.exitCode = 1;
    return;
  }

  // Summary by license
  const licenseCount = new Map();
  for (const r of results) {
    licenseCount.set(r.license, (licenseCount.get(r.license) || 0) + 1);
  }
  const sorted = [...licenseCount.entries()].sort((a, b) => b[1] - a[1]);

  printText(`  Total packages: ${results.length}\n`);

  if (!allowList && !blockList) {
    printText(`\x1b[1mLicense distribution:\x1b[0m`);
    for (const [license, count] of sorted.slice(0, 15)) {
      const cat = classifyLicense(license);
      const color = cat === "permissive" ? "\x1b[32m" : cat === "copyleft" ? "\x1b[31m" : "\x1b[90m";
      const bar = "█".repeat(Math.min(Math.round(count / results.length * 30), 30));
      printText(`  ${color}${license.padEnd(20)}\x1b[0m  ${bar}  \x1b[90m${count}\x1b[0m`);
    }
    if (sorted.length > 15) printText(`  \x1b[90m... and ${sorted.length - 15} more license types\x1b[0m`);
  } else {
    if (violations.length === 0) {
      printText(`\x1b[32m✔ No license violations found.\x1b[0m`);
    } else {
      printText(`\x1b[31m✘ ${violations.length} license violation(s):\x1b[0m\n`);
      for (const v of violations) {
        const reason = v.blocked ? `blocked license: ${v.license}` : `not in allowed list: ${v.license}`;
        printText(`  \x1b[31m✘\x1b[0m  \x1b[1m${v.name}@${v.version}\x1b[0m  \x1b[31m${reason}\x1b[0m`);
      }
      process.exitCode = 1;
    }
  }
  printText("");
}
