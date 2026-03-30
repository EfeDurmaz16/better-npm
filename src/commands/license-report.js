/**
 * better license-report — generate a detailed license compliance report
 *
 * Produces a comprehensive report of all licenses used across
 * installed packages, suitable for legal/compliance review.
 * Outputs Markdown, CSV, or HTML.
 *
 * Usage:
 *   better license-report
 *   better license-report --format csv
 *   better license-report --output LICENSES.md
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const COPYLEFT = new Set(["GPL-2.0", "GPL-3.0", "LGPL-2.0", "LGPL-2.1", "LGPL-3.0", "AGPL-3.0", "EUPL-1.1", "EUPL-1.2"]);
const PERMISSIVE = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "CC0-1.0", "Unlicense"]);

function licenseType(license) {
  if (!license) return "unknown";
  const norm = String(license).toUpperCase();
  for (const l of COPYLEFT) { if (norm.includes(l.toUpperCase())) return "copyleft"; }
  for (const l of PERMISSIVE) { if (norm.includes(l.toUpperCase())) return "permissive"; }
  return "other";
}

async function scanPackages(nmPath) {
  const packages = [];
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;

      if (e.name.startsWith("@")) {
        const scoped = await fs.readdir(path.join(nmPath, e.name), { withFileTypes: true }).catch(() => []);
        for (const s of scoped) {
          if (s.isDirectory()) {
            const pkg = await readPkgJson(path.join(nmPath, e.name, s.name));
            if (pkg) packages.push(pkg);
          }
        }
      } else {
        const pkg = await readPkgJson(path.join(nmPath, e.name));
        if (pkg) packages.push(pkg);
      }
    }
  } catch {}
  return packages;
}

async function readPkgJson(dir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    return {
      name: pkg.name,
      version: pkg.version,
      license: typeof pkg.license === "object" ? pkg.license?.type : pkg.license,
      author: typeof pkg.author === "object" ? pkg.author?.name : pkg.author,
      homepage: pkg.homepage || pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, ""),
    };
  } catch { return null; }
}

function escCsv(s) {
  if (!s) return "";
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function cmdLicenseReport(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      format: { type: "string", default: "markdown" },
      output: { type: "string" },
      "fail-copyleft": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better license-report [options]

Generate a license compliance report for all installed packages.

Options:
  --format <fmt>      Output format: markdown (default), csv, html, json
  --output <file>     Write report to file
  --fail-copyleft     Exit 1 if copyleft licenses detected
  --json              Machine-readable JSON output
  -h, --help          Show this help

Examples:
  better license-report
  better license-report --format csv --output LICENSES.csv
  better license-report --fail-copyleft
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    process.stderr.write(`\x1b[90mScanning installed packages for licenses…\x1b[0m\n`);
  }

  const packages = await scanPackages(nmPath);
  packages.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  // Group by license
  const byLicense = new Map();
  for (const pkg of packages) {
    const lic = pkg.license || "UNKNOWN";
    if (!byLicense.has(lic)) byLicense.set(lic, []);
    byLicense.get(lic).push(pkg);
  }

  const copyleftPkgs = packages.filter(p => licenseType(p.license) === "copyleft");

  if (values.json) {
    printJson({
      ok: !values["fail-copyleft"] || copyleftPkgs.length === 0,
      kind: "better.license-report",
      totalPackages: packages.length,
      uniqueLicenses: byLicense.size,
      copyleftCount: copyleftPkgs.length,
      packages,
      summary: Object.fromEntries([...byLicense.entries()].map(([k, v]) => [k, v.length])),
    });
    if (values["fail-copyleft"] && copyleftPkgs.length > 0) process.exitCode = 1;
    return;
  }

  const format = values.format || "markdown";
  let output = "";

  if (format === "csv") {
    const lines = ["Package,Version,License,Type,Author,Homepage"];
    for (const p of packages) {
      lines.push([
        escCsv(p.name), escCsv(p.version), escCsv(p.license || "UNKNOWN"),
        escCsv(licenseType(p.license)), escCsv(p.author), escCsv(p.homepage),
      ].join(","));
    }
    output = lines.join("\n");
  } else if (format === "html") {
    const rows = packages.map(p => {
      const type = licenseType(p.license);
      const rowColor = type === "copyleft" ? "#fff8f0" : type === "unknown" ? "#fff3f3" : "";
      return `<tr style="background:${rowColor}"><td>${escHtml(p.name)}</td><td>${escHtml(p.version)}</td><td>${escHtml(p.license || "UNKNOWN")}</td><td>${escHtml(type)}</td><td>${escHtml(p.author)}</td></tr>`;
    }).join("\n");

    output = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>License Report</title>
<style>body{font-family:sans-serif;padding:24px}table{border-collapse:collapse;width:100%}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #eee}th{background:#f6f8fa}</style>
</head><body><h1>License Report</h1><p>${packages.length} packages, ${byLicense.size} unique licenses</p>
<table><thead><tr><th>Package</th><th>Version</th><th>License</th><th>Type</th><th>Author</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
  } else {
    // Markdown
    const lines = [`# License Report\n`, `${packages.length} packages, ${byLicense.size} unique licenses\n`];

    // Summary table
    lines.push("## Summary\n", "| License | Count | Type |", "|---------|-------|------|");
    const sortedLicenses = [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [lic, pkgs] of sortedLicenses) {
      lines.push(`| ${lic} | ${pkgs.length} | ${licenseType(lic)} |`);
    }
    lines.push("");

    if (copyleftPkgs.length > 0) {
      lines.push("## ⚠️ Copyleft Packages\n", "| Package | Version | License |", "|---------|---------|---------|");
      for (const p of copyleftPkgs) {
        lines.push(`| ${p.name} | ${p.version} | ${p.license} |`);
      }
      lines.push("");
    }

    lines.push("## All Packages\n", "| Package | Version | License | Author |", "|---------|---------|---------|--------|");
    for (const p of packages) {
      lines.push(`| ${p.name} | ${p.version} | ${p.license || "UNKNOWN"} | ${p.author || ""} |`);
    }

    output = lines.join("\n");
  }

  if (values.output) {
    const outPath = path.isAbsolute(values.output) ? values.output : path.join(projectRoot, values.output);
    await fs.writeFile(outPath, output, "utf8");
    printText(`\n\x1b[1mbetter license-report\x1b[0m`);
    printText(`  \x1b[32m✔\x1b[0m  Report written to \x1b[1m${path.relative(process.cwd(), outPath)}\x1b[0m`);
    printText(`  ${packages.length} packages, ${byLicense.size} unique licenses`);
    if (copyleftPkgs.length > 0) {
      printText(`  \x1b[33m⚠ ${copyleftPkgs.length} copyleft package(s) detected\x1b[0m`);
    }
  } else {
    process.stdout.write(output + "\n");
  }

  if (values["fail-copyleft"] && copyleftPkgs.length > 0) {
    if (!values.output) process.stderr.write(`\x1b[31m✖ ${copyleftPkgs.length} copyleft package(s) found.\x1b[0m\n`);
    process.exitCode = 1;
  }
}
