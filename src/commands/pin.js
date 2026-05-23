/**
 * better pin — pin or unpin dependency versions
 *
 * Strips range specifiers (^~) and pins to exact versions,
 * or un-pins by restoring ^ for minor-compatible ranges.
 *
 * Usage:
 *   better pin                    # pin all deps to exact current versions
 *   better pin lodash express     # pin specific packages
 *   better pin --unpin            # restore ^ prefixes
 *   better pin --dev-only         # only devDependencies
 *   better pin --prod-only        # only dependencies
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runPinVersionsNapi } from "../lib/core.js";

function stripRange(v) {
  return String(v ?? "").replace(/^[\^~>=<\s]+/, "").split(" ")[0];
}

function hasRange(v) {
  return /^[\^~>=<]/.test(String(v ?? ""));
}

export async function cmdPin(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      unpin: { type: "boolean", default: false },
      "dev-only": { type: "boolean", default: false },
      "prod-only": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pin [packages...] [options]

Pin or unpin dependency versions in package.json.
'pin' removes range specifiers (^~) to lock exact versions.
'unpin' restores ^ prefixes for minor-compatible ranges.

Options:
  --unpin         Restore ^ prefixes (un-pin)
  --dev-only      Only affect devDependencies
  --prod-only     Only affect dependencies (not devDependencies)
  --dry-run       Show what would change without writing
  --json          Machine-readable output
  -h, --help      Show this help

Examples:
  better pin                      # pin all deps
  better pin lodash express       # pin specific packages
  better pin --unpin              # restore caret ranges
  better pin --prod-only          # pin only production deps
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const pkgPath = path.join(projectRoot, "package.json");

  // NAPI fast path: Rust pin with lockfile-based exact version resolution
  const napiResult = runPinVersionsNapi(
    projectRoot,
    positionals,
    values.unpin === true,
    values["dry-run"] === true
  );
  if (napiResult?.ok) {
    const result = {
      ok: true, kind: "better.pin",
      total: napiResult.total,
      changes: napiResult.changes ?? [],
    };
    if (values.json) { printJson(result); }
    else if (napiResult.total === 0) {
      printText(values.unpin ? "Nothing to unpin." : "All versions already pinned.");
    } else {
      printText(`${values.unpin ? "Unpinned" : "Pinned"} ${napiResult.total} package(s):`);
      for (const c of napiResult.changes.slice(0, 20)) {
        printText(`  ${c.name} (${c.section}): ${c.from} → ${c.to}`);
      }
    }
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch (err) {
    const msg = `Cannot read package.json: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // Read installed versions from node_modules or package-lock.json
  const installedVersions = {};
  try {
    const lock = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
    for (const [pkgPath2, info] of Object.entries(lock.packages || {})) {
      if (!pkgPath2 || pkgPath2 === "") continue;
      const name = pkgPath2.startsWith("node_modules/") ? pkgPath2.slice(13) : pkgPath2;
      if (name && !name.includes("/node_modules/") && info.version) {
        installedVersions[name] = info.version;
      }
    }
  } catch {
    // No lock file — use current spec version
  }

  const targetNames = positionals.length > 0 ? new Set(positionals) : null;
  const changes = [];

  function processSection(section, sectionName) {
    if (!section) return;
    for (const [name, currentSpec] of Object.entries(section)) {
      if (targetNames && !targetNames.has(name)) continue;

      let newSpec;
      if (values.unpin) {
        // Add ^ prefix if currently pinned exact version
        if (!hasRange(currentSpec)) {
          newSpec = `^${currentSpec}`;
        }
      } else {
        // Pin to exact version
        if (hasRange(currentSpec)) {
          const exact = installedVersions[name] || stripRange(currentSpec);
          newSpec = exact;
        }
      }

      if (newSpec && newSpec !== currentSpec) {
        changes.push({ name, section: sectionName, from: currentSpec, to: newSpec });
        if (!values["dry-run"]) {
          section[name] = newSpec;
        }
      }
    }
  }

  if (!values["dev-only"]) processSection(pkg.dependencies, "dependencies");
  if (!values["prod-only"]) processSection(pkg.devDependencies, "devDependencies");

  if (changes.length === 0) {
    const msg = values.unpin
      ? "All dependencies already have range specifiers."
      : "All dependencies are already pinned.";
    if (values.json) { printJson({ ok: true, kind: "better.pin", changes: [], message: msg }); }
    else { printText(msg); }
    return;
  }

  if (!values["dry-run"]) {
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.pin",
      action: values.unpin ? "unpin" : "pin",
      dry_run: values["dry-run"],
      changes,
      total: changes.length,
    });
    return;
  }

  const action = values.unpin ? "Unpinned" : "Pinned";
  const dryRun = values["dry-run"] ? " (dry run)" : "";
  printText(`\n${action} ${changes.length} package(s)${dryRun}:\n`);
  for (const c of changes) {
    printText(`  ${c.name.padEnd(32)} ${c.from} → ${c.to}  \x1b[90m(${c.section})\x1b[0m`);
  }

  if (!values["dry-run"]) {
    printText(`\n\x1b[32m✔ Updated package.json\x1b[0m`);
    printText("\x1b[90mRun `better install` to apply.\x1b[0m");
  }
}
