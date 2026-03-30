/**
 * better exports-map — analyze package.json exports field
 *
 * Inspects the "exports" field of package.json, validates all
 * referenced file paths exist, and shows the complete export map
 * for understanding what consumers can import.
 *
 * Usage:
 *   better exports-map
 *   better exports-map --pkg lodash
 *   better exports-map --json
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

function flattenExports(exports, prefix = "") {
  const entries = [];
  if (typeof exports === "string") {
    entries.push({ key: prefix || ".", value: exports, type: "string" });
  } else if (Array.isArray(exports)) {
    entries.push({ key: prefix || ".", value: exports, type: "array" });
  } else if (typeof exports === "object" && exports !== null) {
    for (const [k, v] of Object.entries(exports)) {
      if (k.startsWith(".") || k === "default") {
        // Subpath or condition
        entries.push(...flattenExports(v, k.startsWith(".") ? k : prefix));
      } else {
        // Condition key (import, require, types, default, node, browser)
        entries.push({ key: prefix || ".", condition: k, value: v, type: typeof v });
      }
    }
  }
  return entries;
}

function collectFilePaths(value) {
  const paths = [];
  if (typeof value === "string") {
    if (value.startsWith(".")) paths.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) paths.push(...collectFilePaths(v));
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) paths.push(...collectFilePaths(v));
  }
  return paths;
}

export async function cmdExportsMap(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      pkg:   { type: "string", default: "" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better exports-map [options]

Analyze and validate the package.json exports field.

Options:
  --pkg <name>   Analyze installed package (default: current project)
  --json         Machine-readable output
  -h, --help     Show this help

Shows:
  • All export paths and their conditions
  • File existence validation
  • CJS/ESM/Types coverage
  • Missing or broken export paths

Examples:
  better exports-map
  better exports-map --pkg lodash
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgDir;
  let pkgName;

  const targetPkg = values.pkg || positionals[0];
  if (targetPkg) {
    pkgDir = path.join(projectRoot, "node_modules", targetPkg);
    pkgName = targetPkg;
  } else {
    pkgDir = projectRoot;
    pkgName = "current project";
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    const msg = `Cannot read package.json for ${pkgName}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter exports-map\x1b[0m — \x1b[1m${pkgJson.name || pkgName}@${pkgJson.version || "?"}\x1b[0m\n`);
  }

  const exports = pkgJson.exports;
  const hasExports = exports !== null && exports !== undefined;

  if (!hasExports) {
    // Check for main/module fields instead
    const info = {
      hasExports: false,
      main: pkgJson.main || null,
      module: pkgJson.module || null,
      types: pkgJson.types || pkgJson.typings || null,
      browser: pkgJson.browser || null,
    };
    if (values.json) { printJson({ ok: true, kind: "better.exports-map", ...info, message: "No exports field — using main/module fields" }); return; }
    printText(`  \x1b[33m⚠\x1b[0m  No "exports" field found\n`);
    if (info.main) printText(`  main:    ${info.main}`);
    if (info.module) printText(`  module:  ${info.module}`);
    if (info.types) printText(`  types:   ${info.types}`);
    printText("");
    return;
  }

  // Collect all file references and validate
  const filePaths = collectFilePaths(exports);
  const validationResults = await Promise.all(
    filePaths.map(async (fp) => {
      const full = path.join(pkgDir, fp);
      const exists = await fileExists(full);
      return { path: fp, exists };
    })
  );

  const brokenPaths = validationResults.filter(r => !r.exists);
  const allOk = brokenPaths.length === 0;

  // Analyze conditions
  const hasTypes = filePaths.some(p => p.includes(".d.ts") || p.includes("/types/"));
  const hasCjs = filePaths.some(p => p.includes(".cjs") || p.includes("/cjs/"));
  const hasEsm = filePaths.some(p => p.includes(".mjs") || p.includes("/esm/") || p.includes("/es/"));
  const hasDefault = typeof exports === "string" || (typeof exports === "object" && ("." in exports || "default" in exports));

  // Build flat list of entries
  const entries = flattenExports(exports);

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.exports-map",
      name: pkgJson.name,
      version: pkgJson.version,
      hasTypes,
      hasCjs,
      hasEsm,
      totalPaths: filePaths.length,
      brokenPaths,
      entries,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  // Summary
  const flags = [];
  if (hasTypes) flags.push("\x1b[36mTypeScript\x1b[0m");
  if (hasCjs) flags.push("\x1b[33mCJS\x1b[0m");
  if (hasEsm) flags.push("\x1b[32mESM\x1b[0m");
  printText(`  ${flags.join("  ")}  |  ${filePaths.length} file reference(s)\n`);

  // Print export map
  printText(`\x1b[1mExport map:\x1b[0m`);

  function printExports(obj, prefix = "", indent = "  ") {
    if (typeof obj === "string") {
      const valid = validationResults.find(r => r.path === obj);
      const icon = valid ? (valid.exists ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m") : "";
      printText(`${indent}\x1b[90m${prefix}\x1b[0m  ${icon}  ${obj}`);
    } else if (Array.isArray(obj)) {
      for (const item of obj) printExports(item, prefix, indent);
    } else if (typeof obj === "object" && obj !== null) {
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith(".")) {
          printText(`${indent}\x1b[1m${k}\x1b[0m`);
          printExports(v, k, indent + "  ");
        } else {
          printText(`${indent}\x1b[90m[${k}]\x1b[0m`);
          printExports(v, prefix, indent + "  ");
        }
      }
    }
  }

  printExports(exports);

  if (brokenPaths.length > 0) {
    printText(`\n\x1b[31mBroken export paths:\x1b[0m`);
    for (const bp of brokenPaths) {
      printText(`  \x1b[31m✖\x1b[0m  ${bp.path}`);
    }
    printText(`\n\x1b[31m✖ ${brokenPaths.length} broken export path(s) found.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\n\x1b[32m✔ All export paths exist.\x1b[0m`);
  }
  printText("");
}
