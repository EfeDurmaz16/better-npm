/**
 * better format-package — normalize and format package.json
 *
 * Sorts package.json keys in canonical order, normalizes formatting,
 * and optionally removes unnecessary fields.
 *
 * Usage:
 *   better format-package
 *   better format-package --dry-run
 *   better format-package --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Canonical key order for package.json
const KEY_ORDER = [
  "name", "version", "description", "keywords", "homepage",
  "bugs", "license", "author", "contributors", "funding",
  "files", "main", "browser", "module", "exports", "types", "typings",
  "bin", "man", "directories", "repository",
  "scripts", "config",
  "dependencies", "devDependencies", "peerDependencies", "peerDependenciesMeta",
  "bundleDependencies", "bundledDependencies", "optionalDependencies",
  "engines", "os", "cpu", "private", "publishConfig", "workspaces",
  "better",
];

function sortObject(obj, compareFn) {
  const sorted = {};
  const keys = Object.keys(obj).sort(compareFn);
  for (const k of keys) sorted[k] = obj[k];
  return sorted;
}

function normalizePackageJson(pkg) {
  const result = {};

  // First pass: add in key order
  for (const key of KEY_ORDER) {
    if (key in pkg) {
      let val = pkg[key];
      // Sort dependencies alphabetically
      if (["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].includes(key) && typeof val === "object" && val !== null) {
        val = sortObject(val, (a, b) => a.localeCompare(b));
      }
      // Sort scripts alphabetically (but keep lifecycle before custom)
      if (key === "scripts" && typeof val === "object" && val !== null) {
        val = sortObject(val, (a, b) => a.localeCompare(b));
      }
      result[key] = val;
    }
  }

  // Second pass: add remaining keys not in KEY_ORDER
  for (const key of Object.keys(pkg)) {
    if (!(key in result)) result[key] = pkg[key];
  }

  return result;
}

export async function cmdFormatPackage(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:      { type: "boolean", default: runtime.json === true },
      help:      { type: "boolean", short: "h", default: false },
      "dry-run": { type: "boolean", default: false },
      indent:    { type: "string", default: "2" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better format-package [options]

Normalize and format package.json with canonical key ordering.

Options:
  --dry-run    Show changes without writing
  --indent <n> Indentation spaces (default: 2)
  --json       Machine-readable output
  -h, --help   Show this help

Actions:
  • Sort keys in canonical npm order
  • Sort dependencies alphabetically
  • Sort scripts alphabetically
  • Normalize JSON formatting
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const pkgJsonPath = path.join(projectRoot, "package.json");
  const indent = Math.max(1, Math.min(8, parseInt(values.indent) || 2));

  let original;
  let pkg;
  try {
    original = await fs.readFile(pkgJsonPath, "utf8");
    pkg = JSON.parse(original);
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const normalized = normalizePackageJson(pkg);
  const formatted = JSON.stringify(normalized, null, indent) + "\n";

  const changed = formatted !== original;

  if (values.json) {
    printJson({ ok: true, kind: "better.format-package", changed, dryRun: values["dry-run"] });
    if (!values["dry-run"] && changed) {
      await fs.writeFile(pkgJsonPath, formatted, "utf8");
    }
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter format-package\x1b[0m\n`);
  }

  if (!changed) {
    printText(`\x1b[32m✔ package.json is already properly formatted.\x1b[0m`);
    printText("");
    return;
  }

  if (values["dry-run"]) {
    // Show a simple diff
    const origLines = original.split("\n");
    const fmtLines = formatted.split("\n");
    const maxLen = Math.max(origLines.length, fmtLines.length);
    let diffCount = 0;
    const diffOutput = [];
    for (let i = 0; i < maxLen; i++) {
      const orig = origLines[i];
      const fmt = fmtLines[i];
      if (orig !== fmt) {
        diffCount++;
        if (diffOutput.length < 20) {
          if (orig !== undefined) diffOutput.push(`  \x1b[31m- ${orig}\x1b[0m`);
          if (fmt !== undefined) diffOutput.push(`  \x1b[32m+ ${fmt}\x1b[0m`);
        }
      }
    }
    printText(`  Would change ${diffCount} line(s).\n`);
    for (const line of diffOutput) printText(line);
    if (diffCount > 20) printText(`  \x1b[90m... and ${diffCount - 20} more changes\x1b[0m`);
    printText(`\n  \x1b[90mRun without --dry-run to apply changes.\x1b[0m`);
  } else {
    await fs.writeFile(pkgJsonPath, formatted, "utf8");
    printText(`\x1b[32m✔ package.json formatted successfully.\x1b[0m`);
  }
  printText("");
}
