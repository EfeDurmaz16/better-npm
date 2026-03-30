/**
 * better pkg-json-lint — lint package.json for best practices
 *
 * Checks package.json for common issues: missing required fields,
 * incorrect field types, non-standard values, security concerns,
 * and publishability problems.
 *
 * Usage:
 *   better pkg-json-lint
 *   better pkg-json-lint --strict
 *   better pkg-json-lint --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const SPDX_COMMON = new Set([
  "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause",
  "GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0", "MPL-2.0",
  "AGPL-3.0", "CC0-1.0", "Unlicense", "0BSD",
  "MIT OR Apache-2.0",
]);

function checkField(pkg, rules) {
  const findings = [];

  for (const rule of rules) {
    const value = rule.path.split(".").reduce((o, k) => o?.[k], pkg);
    const result = rule.check(value, pkg);
    if (result) {
      findings.push({ ...result, rule: rule.id });
    }
  }

  return findings;
}

const RULES = [
  // Required fields
  {
    id: "missing-name",
    check: (v) => !v ? { severity: "error", message: '"name" field is required' } : null,
    path: "name",
  },
  {
    id: "missing-version",
    check: (v) => !v ? { severity: "error", message: '"version" field is required' } : null,
    path: "version",
  },
  {
    id: "invalid-version",
    check: (v) => v && !/^\d+\.\d+\.\d+/.test(v) ? { severity: "error", message: `"version" "${v}" is not valid semver` } : null,
    path: "version",
  },
  {
    id: "missing-description",
    check: (v) => !v ? { severity: "warning", message: '"description" field is missing — add a brief description' } : null,
    path: "description",
  },
  {
    id: "missing-license",
    check: (v, pkg) => !v && !pkg.private ? { severity: "warning", message: '"license" field is missing' } : null,
    path: "license",
  },
  {
    id: "invalid-license",
    check: (v) => v && !SPDX_COMMON.has(v) && v !== "UNLICENSED" && v !== "SEE LICENSE IN LICENSE"
      ? { severity: "info", message: `"license" "${v}" may not be a valid SPDX identifier` }
      : null,
    path: "license",
  },
  {
    id: "missing-main",
    check: (v, pkg) => !v && !pkg.exports && !pkg.private
      ? { severity: "warning", message: '"main" or "exports" field missing — entry point unclear' }
      : null,
    path: "main",
  },
  {
    id: "name-case",
    check: (v) => v && /[A-Z]/.test(v)
      ? { severity: "warning", message: `"name" "${v}" contains uppercase — use lowercase` }
      : null,
    path: "name",
  },
  {
    id: "name-length",
    check: (v) => v && v.length > 214
      ? { severity: "error", message: `"name" is too long (${v.length} chars, max 214)` }
      : null,
    path: "name",
  },
  {
    id: "missing-repository",
    check: (v, pkg) => !v && !pkg.private
      ? { severity: "info", message: '"repository" field missing — helps users find the source code' }
      : null,
    path: "repository",
  },
  {
    id: "missing-keywords",
    check: (v, pkg) => (!v || v.length === 0) && !pkg.private
      ? { severity: "info", message: '"keywords" field missing — helps discoverability on npm' }
      : null,
    path: "keywords",
  },
  {
    id: "missing-engines",
    check: (v) => !v
      ? { severity: "info", message: '"engines.node" not specified — document Node.js compatibility' }
      : null,
    path: "engines",
  },
  {
    id: "files-not-set",
    check: (v, pkg) => !v && !pkg.private
      ? { severity: "warning", message: '"files" field not set — all files will be published (add .npmignore or "files")' }
      : null,
    path: "files",
  },
  {
    id: "no-author",
    check: (v) => !v
      ? { severity: "info", message: '"author" field missing' }
      : null,
    path: "author",
  },
  {
    id: "test-script",
    check: (v) => !v
      ? { severity: "info", message: 'No "test" script defined' }
      : null,
    path: "scripts.test",
  },
  {
    id: "broad-files",
    check: (v) => Array.isArray(v) && (v.includes(".") || v.includes("*"))
      ? { severity: "warning", message: '"files" contains broad glob — review what gets published' }
      : null,
    path: "files",
  },
];

export async function cmdPkgJsonLint(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      strict: { type: "boolean", default: false },
      fix:    { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pkg-json-lint [options]

Lint package.json for common issues and best practices.

Options:
  --strict     Fail on warnings (not just errors)
  --json       Machine-readable output
  -h, --help   Show this help

Checks include:
  Required fields (name, version, description, license)
  Valid semver version
  Valid SPDX license identifier
  Entry points (main or exports)
  Repository, keywords, author, files field
  engines.node specification
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const pkgPath = path.join(projectRoot, "package.json");

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const findings = checkField(pkgJson, RULES);

  const errors = findings.filter(f => f.severity === "error");
  const warnings = findings.filter(f => f.severity === "warning");
  const infos = findings.filter(f => f.severity === "info");
  const allOk = errors.length === 0 && (!values.strict || warnings.length === 0);

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.pkg-json-lint",
      findings,
      errors: errors.length,
      warnings: warnings.length,
      infos: infos.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter pkg-json-lint\x1b[0m — ${pkgJson.name || "unknown"}\n`);

  if (findings.length === 0) {
    printText(`\x1b[32m✔ package.json looks great!\x1b[0m\n`);
    return;
  }

  for (const f of findings) {
    const icon = f.severity === "error" ? "\x1b[31m✖\x1b[0m"
      : f.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[90m·\x1b[0m";
    printText(`  ${icon}  ${f.message}`);
  }

  printText("");
  if (allOk) {
    if (warnings.length > 0) {
      printText(`\x1b[33m⚠ ${warnings.length} warning(s) — consider fixing.\x1b[0m`);
    }
    if (infos.length > 0) {
      printText(`\x1b[90m${infos.length} suggestion(s).\x1b[0m`);
    }
  } else {
    printText(`\x1b[31m✖ ${errors.length} error(s) found.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
