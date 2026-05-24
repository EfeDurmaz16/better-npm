/**
 * better node-compat — check package compatibility with Node.js versions
 *
 * Reads engines.node fields across all installed packages to identify
 * which packages support (or require) specific Node.js versions.
 *
 * Usage:
 *   better node-compat
 *   better node-compat --check 18
 *   better node-compat --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function satisfies(engineRange, nodeVersion) {
  if (!engineRange || engineRange === "*") return true;
  const major = parseInt(nodeVersion, 10);
  if (isNaN(major)) return true;

  const parts = engineRange.split("||").map(s => s.trim());
  return parts.some(part => {
    const m = part.match(/^([><=!~^]+)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return true;
    const op = m[1] || "=";
    const required = parseInt(m[2], 10);
    if (op === ">=" || op === "^") return major >= required;
    if (op === ">")  return major > required;
    if (op === "<=") return major <= required;
    if (op === "<")  return major < required;
    if (op === "==" || op === "=") return major === required;
    if (op === "!=") return major !== required;
    if (op === "~")  return major === required;
    return true;
  });
}

export async function cmdNodeCompat(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      check:   { type: "string" },
      "show-all": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better node-compat [options]

Check Node.js version compatibility across installed packages.

Options:
  --check <version>  Check compatibility with a specific Node.js major version
  --show-all         Show all packages, not just those with restrictions
  --json             Machine-readable output
  -h, --help         Show this help

Examples:
  better node-compat --check 18
  better node-compat --check 20
`);
    return;
  }

  const checkVersion = values.check ? String(values.check).replace(/^v/, "") : null;

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter node-compat\x1b[0m${checkVersion ? ` — checking Node.js ${checkVersion}` : ""}\n`);
  }

  // Get direct dependencies to focus on
  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}
  const directDeps = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });

  // Scan node_modules
  let pkgDirs = [];
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith("@")) {
        const scopeDir = path.join(nmPath, e.name);
        try {
          const scoped = await fs.readdir(scopeDir, { withFileTypes: true });
          for (const s of scoped) {
            if (s.isDirectory() || s.isSymbolicLink()) pkgDirs.push(path.join(scopeDir, s.name));
          }
        } catch {}
      } else if (!e.name.startsWith(".")) {
        pkgDirs.push(path.join(nmPath, e.name));
      }
    }
  } catch {
    const msg = "Cannot read node_modules";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const packages = [];
  const BATCH = 20;
  for (let i = 0; i < pkgDirs.length; i += BATCH) {
    const batch = pkgDirs.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dir) => {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
        const engineNode = pkg.engines?.node || null;
        if (engineNode || values["show-all"]) {
          const compatible = checkVersion ? satisfies(engineNode, checkVersion) : true;
          packages.push({
            name: pkg.name,
            version: pkg.version,
            engineNode,
            compatible,
            isDirect: directDeps.includes(pkg.name),
          });
        }
      } catch {}
    }));
  }

  packages.sort((a, b) => {
    if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
    return (a.name || "").localeCompare(b.name || "");
  });

  const incompatible = packages.filter(p => !p.compatible);
  const withEngines = packages.filter(p => p.engineNode);

  if (values.json) {
    printJson({
      ok: incompatible.length === 0,
      kind: "better.node-compat",
      checkVersion,
      totalScanned: pkgDirs.length,
      withEngineField: withEngines.length,
      incompatible: incompatible.length,
      packages: checkVersion ? incompatible : withEngines,
    });
    if (incompatible.length > 0) process.exitCode = 1;
    return;
  }

  printText(`  Scanned: ${pkgDirs.length} packages  |  With engines.node: ${withEngines.length}`);
  if (checkVersion) {
    printText(`  Incompatible with Node.js ${checkVersion}: ${incompatible.length}\n`);
  } else {
    printText("");
  }

  const toShow = checkVersion ? incompatible : withEngines.slice(0, 20);

  if (checkVersion && incompatible.length === 0) {
    printText(`\x1b[32m✔ All packages are compatible with Node.js ${checkVersion}.\x1b[0m`);
  } else if (toShow.length === 0) {
    printText(`  \x1b[90mNo packages with engines.node field found.\x1b[0m`);
  } else {
    for (const p of toShow) {
      const icon = p.compatible ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
      const directTag = p.isDirect ? " \x1b[90m(direct)\x1b[0m" : "";
      const engine = p.engineNode ? `  \x1b[90mrequires: ${p.engineNode}\x1b[0m` : "";
      printText(`  ${icon}  \x1b[1m${p.name}\x1b[0m@${p.version}${directTag}${engine}`);
    }
    if (!checkVersion && withEngines.length > 20) {
      printText(`  \x1b[90m... and ${withEngines.length - 20} more. Use --check <version> to filter.\x1b[0m`);
    }
  }
  printText("");
}
