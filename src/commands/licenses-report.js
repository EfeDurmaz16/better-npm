/**
 * better licenses-report — comprehensive license compliance report
 *
 * Scans all installed packages for their licenses and generates
 * a compliance-ready report with flagged incompatible licenses.
 *
 * Usage:
 *   better licenses-report                  # full report
 *   better licenses-report --disallow GPL   # fail if GPL found
 *   better licenses-report --allow MIT,ISC,Apache-2.0  # allowlist
 *   better licenses-report --output report.csv
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const COPYLEFT = new Set(["GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.0", "LGPL-2.1", "LGPL-3.0", "MPL-2.0"]);
const PERMISSIVE = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "Unlicense", "CC0-1.0"]);

function normalizeLicense(lic) {
  if (!lic) return "Unknown";
  if (typeof lic === "object") return lic.type || "Unknown";
  return String(lic).trim()
    .replace(/\(|\)/g, "")
    .replace(/ OR /g, " | ")
    .split(" | ")[0]
    .trim();
}

function categorize(lic) {
  if (PERMISSIVE.has(lic)) return "permissive";
  if (COPYLEFT.has(lic)) return "copyleft";
  if (lic === "Unknown" || lic === "") return "unknown";
  return "other";
}

export async function cmdLicensesReport(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      disallow: { type: "string" },
      allow: { type: "string" },
      output: { type: "string" },
      format: { type: "string", default: "table" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better licenses-report [options]

Generate a dependency license compliance report.

Options:
  --disallow <licenses>   Comma-separated licenses that should not be present
  --allow <licenses>      Comma-separated allowlist (fail on anything else)
  --format <fmt>          Output format: table (default) | csv | json
  --output <file>         Write to file
  --json                  Machine-readable output
  -h, --help              Show this help

Examples:
  better licenses-report
  better licenses-report --disallow GPL-2.0,GPL-3.0,AGPL-3.0
  better licenses-report --allow MIT,ISC,Apache-2.0,BSD-2-Clause
  better licenses-report --format csv --output licenses.csv

License categories:
  Permissive:  MIT, ISC, BSD-*, Apache-2.0, Unlicense
  Copyleft:    GPL, LGPL, AGPL, MPL
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  try {
    await fs.access(nmPath);
  } catch {
    const msg = "node_modules not found. Run 'better install' first.";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json && !values.output) {
    process.stderr.write("\x1b[90mScanning licenses…\x1b[0m\n");
  }

  const disallowSet = values.disallow
    ? new Set(values.disallow.split(",").map(s => s.trim()))
    : null;
  const allowSet = values.allow
    ? new Set(values.allow.split(",").map(s => s.trim()))
    : null;

  const packages = [];
  const violations = [];

  // Scan top-level node_modules
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      const namesToCheck = [];
      if (entry.name.startsWith("@")) {
        // Scoped packages
        try {
          const scopeEntries = await fs.readdir(path.join(nmPath, entry.name), { withFileTypes: true });
          for (const scopeEntry of scopeEntries) {
            if (scopeEntry.isDirectory()) {
              namesToCheck.push(`${entry.name}/${scopeEntry.name}`);
            }
          }
        } catch {}
      } else {
        namesToCheck.push(entry.name);
      }

      for (const name of namesToCheck) {
        try {
          const pkgPath = path.join(nmPath, name, "package.json");
          const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
          const rawLicense = pkg.license || pkg.licence;
          const lic = normalizeLicense(rawLicense);
          const category = categorize(lic);
          const version = pkg.version || "?";
          const homepage = pkg.homepage || "";

          let isViolation = false;
          let violationReason = "";

          if (disallowSet && disallowSet.has(lic)) {
            isViolation = true;
            violationReason = `disallowed license: ${lic}`;
          } else if (allowSet && !allowSet.has(lic)) {
            isViolation = true;
            violationReason = `not in allowlist: ${lic}`;
          }

          if (isViolation) {
            violations.push({ name, version, license: lic, reason: violationReason });
          }

          packages.push({ name, version, license: lic, category, homepage });
        } catch {}
      }
    }
  } catch (err) {
    const msg = `Error scanning node_modules: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));

  // Aggregate by license
  const byLicense = {};
  for (const pkg of packages) {
    byLicense[pkg.license] = (byLicense[pkg.license] || 0) + 1;
  }

  const hasViolations = violations.length > 0;

  if (values.json || values.format === "json") {
    printJson({
      ok: !hasViolations,
      kind: "better.licenses-report",
      total: packages.length,
      violations,
      by_license: byLicense,
      packages: packages.slice(0, 500),
    });
    if (hasViolations) process.exitCode = 1;
    return;
  }

  if (values.format === "csv") {
    const rows = ["Package,Version,License,Category"];
    for (const p of packages) {
      rows.push(`"${p.name}","${p.version}","${p.license}","${p.category}"`);
    }
    const output = rows.join("\n");
    if (values.output) {
      await fs.writeFile(values.output, output + "\n");
      printText(`CSV written to ${values.output} (${packages.length} packages)`);
    } else {
      process.stdout.write(output + "\n");
    }
    if (hasViolations) {
      printText(`\x1b[31m✖ ${violations.length} license violation(s) found.\x1b[0m`);
      process.exitCode = 1;
    }
    return;
  }

  // Table format
  printText(`\n\x1b[1mbetter licenses-report\x1b[0m — ${packages.length} packages\n`);

  // Summary by category
  const cats = { permissive: 0, copyleft: 0, other: 0, unknown: 0 };
  for (const p of packages) cats[p.category] = (cats[p.category] || 0) + 1;

  printText(`\x1b[32m${cats.permissive}\x1b[0m permissive  ` +
    `\x1b[33m${cats.copyleft}\x1b[0m copyleft  ` +
    `\x1b[90m${cats.other}\x1b[0m other  ` +
    `\x1b[31m${cats.unknown}\x1b[0m unknown\n`);

  // Top licenses
  const topLicenses = Object.entries(byLicense)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  printText("\x1b[1mLicense distribution:\x1b[0m");
  for (const [lic, count] of topLicenses) {
    const cat = categorize(lic);
    const color = cat === "permissive" ? "\x1b[32m" : cat === "copyleft" ? "\x1b[31m" : "\x1b[90m";
    const bar = "▪".repeat(Math.min(20, Math.round((count / topLicenses[0][1]) * 20)));
    printText(`  ${color}${lic.padEnd(20)}\x1b[0m ${bar} ${count}`);
  }

  if (violations.length > 0) {
    printText(`\n\x1b[31mViolations (${violations.length}):\x1b[0m`);
    for (const v of violations) {
      printText(`  \x1b[31m✖\x1b[0m  ${v.name}@${v.version}  — ${v.reason}`);
    }
    process.exitCode = 1;
  } else if (disallowSet || allowSet) {
    printText(`\n\x1b[32m✔ No license violations found.\x1b[0m`);
  }

  if (values.output) {
    const rows = ["Package,Version,License,Category"];
    for (const p of packages) {
      rows.push(`"${p.name}","${p.version}","${p.license}","${p.category}"`);
    }
    await fs.writeFile(values.output, rows.join("\n") + "\n");
    printText(`\n\x1b[90mFull CSV report written to ${values.output}\x1b[0m`);
  }
}
