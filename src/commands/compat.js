/**
 * better compat — Node.js version compatibility check
 *
 * Checks if all installed packages support the current Node.js version
 * (or a specified target) by reading their `engines.node` field.
 *
 * Usage:
 *   better compat                    # check against current Node.js
 *   better compat --target 18        # check against Node 18
 *   better compat --target 20.0.0    # check against specific version
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Simple semver range check: supports >=X, >X, <=X, <X, ^X, ~X, X, *
function satisfiesRange(version, range) {
  if (!range || range === "*" || range === "") return true;

  // Parse version
  const [maj, min, pat] = String(version).replace(/^v/, "").split(".").map(n => parseInt(n) || 0);
  const verNum = maj * 1e6 + min * 1e3 + pat;

  // Handle space-separated AND ranges
  const parts = range.split(/\s+/).filter(Boolean);

  for (const part of parts) {
    // Skip OR (||) handling for simplicity
    if (part === "||") continue;

    const m = part.match(/^([><=^~!]+)?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) continue;

    const op = m[1] || "=";
    const rMaj = parseInt(m[2]) || 0;
    const rMin = m[3] !== undefined ? parseInt(m[3]) : 0;
    const rPat = m[4] !== undefined ? parseInt(m[4]) : 0;
    const rNum = rMaj * 1e6 + rMin * 1e3 + rPat;

    let ok;
    switch (op) {
      case ">=": ok = verNum >= rNum; break;
      case ">":  ok = verNum > rNum; break;
      case "<=": ok = verNum <= rNum; break;
      case "<":  ok = verNum < rNum; break;
      case "=":
      case "":   ok = maj === rMaj; break;
      case "^":  ok = maj === rMaj && verNum >= rNum; break;
      case "~":  ok = maj === rMaj && min === rMin && verNum >= rNum; break;
      case "!=": ok = verNum !== rNum; break;
      default:   ok = true;
    }

    if (!ok) return false;
  }

  return true;
}

// Check if version satisfies an OR range (simplified)
function satisfies(version, rangeStr) {
  if (!rangeStr) return true;
  const orParts = rangeStr.split(/\s*\|\|\s*/);
  return orParts.some(r => satisfiesRange(version, r.trim()));
}

export async function cmdCompat(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      target: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better compat [options]

Check if installed packages support a given Node.js version.

Options:
  --target <version>   Node.js version to check (default: current)
  --json               Machine-readable output
  -h, --help           Show this help

Examples:
  better compat                    # check against current Node.js
  better compat --target 18        # check against Node 18
  better compat --target 20.0.0    # check against Node 20.0.0
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  const targetVersion = values.target || process.version.replace(/^v/, "");

  try {
    await fs.access(nmPath);
  } catch {
    const msg = "node_modules not found. Run 'better install' first.";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking compatibility with Node.js ${targetVersion}…\x1b[0m\n`);
  }

  const incompatible = [];
  const noEngines = [];
  let checked = 0;

  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    const toCheck = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) {
        try {
          const scopedEntries = await fs.readdir(path.join(nmPath, entry.name), { withFileTypes: true });
          for (const se of scopedEntries) {
            if (se.isDirectory()) toCheck.push(`${entry.name}/${se.name}`);
          }
        } catch {}
      } else {
        toCheck.push(entry.name);
      }
    }

    const BATCH = 30;
    for (let i = 0; i < toCheck.length; i += BATCH) {
      const batch = toCheck.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (name) => {
        try {
          const pkg = JSON.parse(
            await fs.readFile(path.join(nmPath, name, "package.json"), "utf8")
          );
          const nodeRange = pkg.engines?.node;
          if (!nodeRange) return { name, version: pkg.version || "?", status: "no-engines" };
          const ok = satisfies(targetVersion, nodeRange);
          return { name, version: pkg.version || "?", node_range: nodeRange, ok };
        } catch {
          return null;
        }
      }));

      for (const r of results) {
        if (!r) continue;
        checked++;
        if (r.status === "no-engines") {
          noEngines.push(r.name);
        } else if (!r.ok) {
          incompatible.push(r);
        }
      }
    }
  } catch (err) {
    const msg = `Error scanning node_modules: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  if (values.json) {
    printJson({
      ok: incompatible.length === 0,
      kind: "better.compat",
      target_node: targetVersion,
      checked,
      incompatible,
      no_engines: noEngines.length,
    });
    if (incompatible.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter compat\x1b[0m — Node.js ${targetVersion}\n`);

  if (incompatible.length === 0) {
    printText(`\x1b[32m✔ All ${checked} packages are compatible with Node.js ${targetVersion}.\x1b[0m`);
    if (noEngines.length > 0) {
      printText(`\x1b[90m${noEngines.length} packages do not declare engines.node (assumed compatible).\x1b[0m`);
    }
    return;
  }

  printText(`\x1b[31m${incompatible.length} incompatible package(s):\x1b[0m\n`);
  for (const p of incompatible) {
    printText(`  \x1b[31m✖\x1b[0m  ${p.name.padEnd(36)} requires \x1b[33m${p.node_range}\x1b[0m`);
  }

  printText(`\n\x1b[90m${noEngines.length} packages don't declare engines.node (assumed compatible).\x1b[0m`);
  process.exitCode = 1;
}
