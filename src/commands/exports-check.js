/**
 * better exports-check — validate package exports field
 *
 * Checks that all paths declared in the "exports" field of package.json
 * actually exist on disk, and warns about missing or broken export entries.
 *
 * Usage:
 *   better exports-check
 *   better exports-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function collectExportPaths(exports, results = [], prefix = "") {
  if (typeof exports === "string") {
    results.push({ condition: prefix || ".", path: exports });
  } else if (Array.isArray(exports)) {
    for (const e of exports) collectExportPaths(e, results, prefix);
  } else if (exports && typeof exports === "object") {
    for (const [key, val] of Object.entries(exports)) {
      if (key.startsWith(".")) {
        collectExportPaths(val, results, key);
      } else {
        collectExportPaths(val, results, prefix ? `${prefix}[${key}]` : key);
      }
    }
  }
  return results;
}

export async function cmdExportsCheck(argv) {
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
    printText(`Usage: better exports-check [options]

Validate the "exports" field in package.json.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • All export paths point to existing files
  • Main entry point exists
  • Types/typings entry exists (if declared)
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter exports-check\x1b[0m\n`);
  }

  let pkgJson = {};
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const checks = [];

  // Check main entry
  const mainFile = pkgJson.main || "index.js";
  const mainExists = await fileExists(path.join(projectRoot, mainFile));
  checks.push({ field: "main", path: mainFile, exists: mainExists, ok: mainExists });

  // Check module field
  if (pkgJson.module) {
    const exists = await fileExists(path.join(projectRoot, pkgJson.module));
    checks.push({ field: "module", path: pkgJson.module, exists, ok: exists });
  }

  // Check types/typings
  const typingsFile = pkgJson.types || pkgJson.typings;
  if (typingsFile) {
    const exists = await fileExists(path.join(projectRoot, typingsFile));
    checks.push({ field: "types", path: typingsFile, exists, ok: exists });
  }

  // Check exports field
  const exportPaths = pkgJson.exports ? collectExportPaths(pkgJson.exports) : [];
  for (const ep of exportPaths) {
    if (!ep.path || !ep.path.startsWith(".")) continue;
    const fullPath = path.join(projectRoot, ep.path);
    const exists = await fileExists(fullPath);
    checks.push({ field: `exports["${ep.condition}"]`, path: ep.path, exists, ok: exists });
  }

  if (checks.length === 0) {
    if (values.json) {
      printJson({ ok: true, kind: "better.exports-check", checks: [] });
    } else {
      printText(`  \x1b[90mNo exports or entry fields found in package.json.\x1b[0m\n`);
    }
    return;
  }

  const ok = checks.every(c => c.ok);

  if (values.json) {
    printJson({ ok, kind: "better.exports-check", package: pkgJson.name, checks });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const c of checks) {
    const icon = c.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    const status = c.ok ? "\x1b[90mexists\x1b[0m" : "\x1b[31mmissing\x1b[0m";
    printText(`  ${icon}  \x1b[1m${c.field}\x1b[0m  →  ${c.path}  ${status}`);
  }

  printText("");
  if (!ok) {
    const missing = checks.filter(c => !c.ok);
    printText(`\x1b[31m✘ ${missing.length} export path(s) are missing. Update your package.json exports field.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\x1b[32m✔ All ${checks.length} export paths exist.\x1b[0m`);
  }
  printText("");
}
