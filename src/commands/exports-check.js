/**
 * better exports-check — validate package.json exports field
 *
 * Checks that all paths listed in the "exports" field exist and
 * are valid (files present, correct format, etc.)
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

function collectPaths(exports, base) {
  const paths = [];
  if (!exports) return paths;
  if (typeof exports === "string") {
    paths.push({ condition: ".", path: exports });
    return paths;
  }
  if (typeof exports === "object") {
    for (const [key, value] of Object.entries(exports)) {
      if (key.startsWith(".") || key === ".") {
        // Subpath export
        if (typeof value === "string") {
          paths.push({ condition: key, path: value });
        } else if (typeof value === "object") {
          for (const [cond, p] of Object.entries(value)) {
            if (typeof p === "string") {
              paths.push({ condition: `${key}[${cond}]`, path: p });
            }
          }
        }
      } else {
        // Condition export
        if (typeof value === "string") {
          paths.push({ condition: key, path: value });
        }
      }
    }
  }
  return paths;
}

export async function cmdExportsCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better exports-check [options]

Validate the "exports" field in package.json.
Checks that all exported paths exist as files.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better exports-check
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

  if (!pkgJson.exports && !pkgJson.main && !pkgJson.module) {
    if (values.json) {
      printJson({ ok: true, kind: "better.exports-check", message: "No exports/main/module field found" });
    } else {
      printText(`\x1b[90mNo exports, main, or module field in package.json.\x1b[0m`);
    }
    return;
  }

  const checks = [];

  // Check exports field
  if (pkgJson.exports) {
    const exportPaths = collectPaths(pkgJson.exports, projectRoot);
    for (const { condition, path: relPath } of exportPaths) {
      if (!relPath || relPath.startsWith("node_modules/")) continue;
      const fullPath = path.join(projectRoot, relPath);
      let exists = false;
      let error = null;
      try {
        const stat = await fs.stat(fullPath);
        exists = stat.isFile();
        if (!exists) error = "Path exists but is not a file";
      } catch {
        error = "File not found";
      }
      checks.push({ field: "exports", condition, path: relPath, exists, error });
    }
  }

  // Check main field
  if (pkgJson.main) {
    const mainPath = path.join(projectRoot, pkgJson.main);
    let exists = false;
    let error = null;
    try {
      const stat = await fs.stat(mainPath);
      exists = stat.isFile();
      if (!exists) error = "Path exists but is not a file";
    } catch {
      // Try with .js extension
      try {
        await fs.stat(mainPath + ".js");
        exists = true;
      } catch {
        error = "File not found";
      }
    }
    checks.push({ field: "main", condition: "main", path: pkgJson.main, exists, error });
  }

  // Check module field
  if (pkgJson.module) {
    const modulePath = path.join(projectRoot, pkgJson.module);
    let exists = false;
    let error = null;
    try {
      const stat = await fs.stat(modulePath);
      exists = stat.isFile();
      if (!exists) error = "Path exists but is not a file";
    } catch {
      error = "File not found";
    }
    checks.push({ field: "module", condition: "module", path: pkgJson.module, exists, error });
  }

  // Check types field
  if (pkgJson.types || pkgJson.typings) {
    const typesPath = path.join(projectRoot, pkgJson.types || pkgJson.typings);
    let exists = false;
    let error = null;
    try {
      const stat = await fs.stat(typesPath);
      exists = stat.isFile();
      if (!exists) error = "Path exists but is not a file";
    } catch {
      error = "File not found";
    }
    checks.push({ field: "types", condition: "types", path: pkgJson.types || pkgJson.typings, exists, error });
  }

  const failing = checks.filter(c => !c.exists);
  const passing = checks.filter(c => c.exists);
  const allOk = failing.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.exports-check",
      checks,
      passing: passing.length,
      failing: failing.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter exports-check\x1b[0m — ${checks.length} path(s) checked\n`);

  for (const c of checks) {
    const icon = c.exists ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    const label = `${c.field}${c.condition !== c.field ? `[${c.condition}]` : ""}`;
    const err = c.error ? ` \x1b[31m(${c.error})\x1b[0m` : "";
    printText(`  ${icon}  ${label.padEnd(30)} ${c.path}${err}`);
  }

  if (allOk) {
    printText(`\n\x1b[32m✔ All exports validated.\x1b[0m`);
  } else {
    printText(`\n\x1b[31m✖ ${failing.length} path(s) missing.\x1b[0m`);
    printText(`\x1b[90mRun 'better build' or check your build output.\x1b[0m`);
    process.exitCode = 1;
  }
}
