/**
 * better format — normalize and format package.json
 *
 * Sorts dependencies alphabetically, normalizes field ordering,
 * ensures consistent formatting.
 *
 * Usage:
 *   better format                  # format package.json in-place
 *   better format --check          # exit 1 if format would change file
 *   better format --sort-scripts   # also alphabetically sort scripts
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Canonical field ordering for package.json
const FIELD_ORDER = [
  "name", "version", "description", "keywords", "homepage",
  "bugs", "license", "author", "contributors", "funding",
  "main", "module", "exports", "types", "typings", "bin",
  "man", "files", "directories",
  "scripts",
  "dependencies", "devDependencies", "peerDependencies",
  "peerDependenciesMeta", "optionalDependencies", "bundledDependencies",
  "engines", "os", "cpu",
  "private", "publishConfig", "workspaces",
  "repository", "config", "resolutions", "overrides",
];

function sortObjectKeys(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))
  );
}

function reorderFields(pkg, sortScripts) {
  const result = {};

  // Add fields in canonical order
  for (const field of FIELD_ORDER) {
    if (field in pkg) {
      let val = pkg[field];
      // Sort dep sections alphabetically
      if (["dependencies", "devDependencies", "peerDependencies",
           "optionalDependencies", "bundledDependencies"].includes(field)) {
        val = sortObjectKeys(val);
      }
      // Optionally sort scripts
      if (field === "scripts" && sortScripts) {
        val = sortObjectKeys(val);
      }
      result[field] = val;
    }
  }

  // Append any unknown fields at the end (preserve custom fields)
  for (const [key, val] of Object.entries(pkg)) {
    if (!(key in result)) {
      result[key] = val;
    }
  }

  return result;
}

export async function cmdFormat(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      check: { type: "boolean", default: false },
      "sort-scripts": { type: "boolean", default: false },
      indent: { type: "string", default: "2" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better format [options]

Normalize and format package.json.
Sorts dependencies alphabetically and orders fields canonically.

Options:
  --check          Exit 1 if format would change the file (CI mode)
  --sort-scripts   Also sort scripts alphabetically
  --indent N       Indentation size (default: 2)
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better format                  # format in-place
  better format --check          # verify formatting (CI)
  better format --sort-scripts   # sort scripts too
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const pkgPath = path.join(projectRoot, "package.json");

  let raw;
  let pkg;
  try {
    raw = await fs.readFile(pkgPath, "utf8");
    pkg = JSON.parse(raw);
  } catch (err) {
    const msg = `Cannot read package.json: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const indent = parseInt(values.indent) || 2;
  const formatted = reorderFields(pkg, values["sort-scripts"]);
  const output = JSON.stringify(formatted, null, indent) + "\n";

  const changed = output !== raw;

  if (values.check) {
    if (values.json) {
      printJson({ ok: !changed, kind: "better.format", formatted: !changed, changed });
    } else if (changed) {
      printText(`\x1b[31m✖ package.json is not formatted. Run \x1b[1mbetter format\x1b[0m\x1b[31m to fix.\x1b[0m`);
    } else {
      printText(`\x1b[32m✔ package.json is properly formatted.\x1b[0m`);
    }
    if (changed) process.exitCode = 1;
    return;
  }

  if (!changed) {
    if (values.json) { printJson({ ok: true, kind: "better.format", changed: false }); }
    else { printText(`\x1b[32m✔ package.json already formatted.\x1b[0m`); }
    return;
  }

  await fs.writeFile(pkgPath, output, "utf8");

  if (values.json) {
    printJson({ ok: true, kind: "better.format", changed: true, path: "package.json" });
  } else {
    printText(`\x1b[32m✔ Formatted package.json\x1b[0m`);
  }
}
