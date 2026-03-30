/**
 * better fix-versions — normalize version ranges in package.json
 *
 * Converts version ranges to a consistent format:
 * pinned, caret (^), tilde (~), or exact.
 * Also removes redundant range operators.
 *
 * Usage:
 *   better fix-versions
 *   better fix-versions --to caret
 *   better fix-versions --dry-run
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function normalizeVersion(version, format) {
  if (!version || typeof version !== "string") return version;

  // Don't touch special versions
  if (version === "*" || version === "") return version;
  if (version.startsWith("file:") || version.startsWith("git+") || version.startsWith("github:")) return version;
  if (version.startsWith("workspace:")) return version;

  // Strip existing range operators
  const stripped = version.replace(/^[~^>=<! ]+/, "").trim();

  // Don't process non-semver
  if (!/^\d+/.test(stripped)) return version;

  switch (format) {
    case "caret":
      return `^${stripped}`;
    case "tilde":
      return `~${stripped}`;
    case "exact":
      return stripped;
    case "latest":
      return "*";
    case "gte":
      return `>=${stripped}`;
    default:
      return version;
  }
}

function countChanges(deps, format) {
  let count = 0;
  for (const [, ver] of Object.entries(deps || {})) {
    if (normalizeVersion(ver, format) !== ver) count++;
  }
  return count;
}

export async function cmdFixVersions(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      to:       { type: "string" },
      "dry-run":{ type: "boolean", default: false },
      dev:      { type: "boolean", default: false },
      prod:     { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better fix-versions [options]

Normalize version range formats in package.json.

Options:
  --to <format>  Target format: caret (^), tilde (~), exact, gte (>=)
                 Default: caret
  --prod         Only normalize dependencies
  --dev          Only normalize devDependencies
  --dry-run      Preview changes without applying
  --json         Machine-readable output
  -h, --help     Show this help

Examples:
  better fix-versions --to caret
  better fix-versions --to exact --dry-run
  better fix-versions --to tilde --dev
`);
    return;
  }

  const format = values.to || "caret";
  const validFormats = ["caret", "tilde", "exact", "latest", "gte"];
  if (!validFormats.includes(format)) {
    printText(`\x1b[31mInvalid format: ${format}. Must be one of: ${validFormats.join(", ")}\x1b[0m`);
    process.exitCode = 1;
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

  const isDryRun = values["dry-run"];
  const doOnlyDev = values.dev && !values.prod;
  const doOnlyProd = values.prod && !values.dev;
  const doBoth = !doOnlyDev && !doOnlyProd;

  const changes = [];
  const updated = { ...pkgJson };

  function processSection(section, sectionName) {
    if (!pkgJson[section]) return;
    updated[section] = { ...pkgJson[section] };
    for (const [name, ver] of Object.entries(pkgJson[section])) {
      const newVer = normalizeVersion(ver, format);
      if (newVer !== ver) {
        changes.push({ name, from: ver, to: newVer, section: sectionName });
        updated[section][name] = newVer;
      }
    }
  }

  if (doBoth || doOnlyProd) processSection("dependencies", "dependencies");
  if (doBoth || doOnlyDev) processSection("devDependencies", "devDependencies");

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.fix-versions",
      format,
      dryRun: isDryRun,
      changes: changes.length,
      modifications: changes,
    });
    if (!isDryRun && changes.length > 0) {
      await fs.writeFile(pkgPath, JSON.stringify(updated, null, 2) + "\n");
    }
    return;
  }

  printText(`\n\x1b[1mbetter fix-versions\x1b[0m — to: ${format}${isDryRun ? " (dry-run)" : ""}\n`);

  if (changes.length === 0) {
    printText(`\x1b[32m✔ All version ranges already use ${format} format.\x1b[0m`);
    return;
  }

  printText(`${changes.length} version(s) to normalize:\n`);
  for (const c of changes) {
    printText(`  ${c.name.padEnd(30)} ${c.from} → \x1b[32m${c.to}\x1b[0m \x1b[90m(${c.section})\x1b[0m`);
  }

  if (!isDryRun) {
    await fs.writeFile(pkgPath, JSON.stringify(updated, null, 2) + "\n");
    printText(`\n\x1b[32m✔ Updated ${changes.length} version(s) to ${format} format.\x1b[0m`);
  } else {
    printText(`\n\x1b[90mDry-run: run without --dry-run to apply.\x1b[0m`);
  }
}
