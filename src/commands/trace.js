/**
 * better trace — trace how a package dependency is resolved
 *
 * Shows the full resolution path from root to a given package,
 * including all intermediate dependents.
 *
 * Usage:
 *   better trace <package>             # show all paths to package
 *   better trace <package> --first     # only the shortest path
 *   better trace <package> --depth 5   # max search depth
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";

export async function cmdTrace(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      first: { type: "boolean", default: false },
      depth: { type: "string", default: "10" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printText(`Usage: better trace <package> [options]

Trace dependency resolution paths to a package.
Shows all chains from direct dependencies down to the target.

Options:
  --first         Only show the shortest path
  --depth N       Max search depth (default: 10)
  --json          Machine-readable output
  -h, --help      Show this help

Examples:
  better trace lodash
  better trace debug --first
  better trace semver --depth 5
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const targetPkg = positionals[0];
  const cwd = process.cwd();
  const maxDepth = parseInt(values.depth) || 10;

  let pkgJson;
  let lockData;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
  } catch (err) {
    const msg = `Cannot read package.json: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  try {
    lockData = JSON.parse(await fs.readFile(path.join(cwd, "package-lock.json"), "utf8"));
  } catch {
    const msg = "Cannot read package-lock.json. Run 'better install' first.";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // Build reverse dependency map: pkg -> [dependents]
  const lockPkgs = lockData.packages || {};
  const requires = new Map(); // pkg -> [pkg_it_depends_on]
  const versions = new Map(); // pkg -> version

  for (const [pkgPath, info] of Object.entries(lockPkgs)) {
    if (!pkgPath) continue;
    const name = pkgPath.startsWith("node_modules/")
      ? pkgPath.replace(/^.*node_modules\//, "")
      : pkgPath;
    if (!name) continue;
    versions.set(name, info.version || "?");
    const deps = Object.keys({
      ...(info.dependencies || {}),
      ...(info.peerDependencies || {}),
    });
    requires.set(name, deps);
  }

  // Check target exists
  if (!versions.has(targetPkg)) {
    const msg = `Package '${targetPkg}' not found in node_modules.`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(msg); }
    process.exitCode = 1;
    return;
  }

  // BFS from direct deps to find all paths to target
  const directDeps = Object.keys({
    ...(pkgJson.dependencies || {}),
    ...(pkgJson.devDependencies || {}),
  });
  const rootName = pkgJson.name || path.basename(cwd);

  // BFS: find all paths from root -> ... -> targetPkg
  const paths = [];

  function dfs(current, currentPath, visited) {
    if (currentPath.length > maxDepth) return;
    if (current === targetPkg) {
      paths.push([...currentPath]);
      return;
    }
    const deps = requires.get(current) || [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visited.add(dep);
        dfs(dep, [...currentPath, dep], new Set(visited));
        visited.delete(dep);
      }
    }
  }

  // Start from direct deps
  for (const dep of directDeps) {
    if (dep === targetPkg) {
      paths.push([dep]);
    } else {
      dfs(dep, [dep], new Set([dep]));
    }
  }

  const targetVersion = versions.get(targetPkg) || "?";

  if (paths.length === 0) {
    const msg = `No dependency path found to '${targetPkg}'.`;
    if (values.json) { printJson({ ok: false, error: msg, target: targetPkg }); } else { printText(msg); }
    process.exitCode = 1;
    return;
  }

  // Sort by path length
  paths.sort((a, b) => a.length - b.length);
  const displayPaths = values.first ? [paths[0]] : paths.slice(0, 20);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.trace",
      target: targetPkg,
      version: targetVersion,
      paths: displayPaths.map(p => ({
        chain: [rootName, ...p],
        length: p.length,
      })),
      total_paths: paths.length,
      showing: displayPaths.length,
    });
    return;
  }

  printText(`\n\x1b[1mbetter trace: ${targetPkg}@${targetVersion}\x1b[0m`);
  printText(`\x1b[90m${paths.length} path(s) found${paths.length > displayPaths.length ? ` (showing ${displayPaths.length})` : ""}\x1b[0m\n`);

  for (let i = 0; i < displayPaths.length; i++) {
    const chainPath = [rootName, ...displayPaths[i]];
    const parts = chainPath.map((name, idx) => {
      const ver = idx === 0 ? (pkgJson.version || "?") : (versions.get(name) || "?");
      const isTarget = name === targetPkg;
      const formatted = isTarget
        ? `\x1b[1m\x1b[32m${name}@${ver}\x1b[0m`
        : `${name}@\x1b[90m${ver}\x1b[0m`;
      return formatted;
    });
    printText(`  ${i + 1}. ${parts.join(" → ")}`);
  }

  if (paths.length > displayPaths.length) {
    printText(`\n\x1b[90m...${paths.length - displayPaths.length} more path(s). Use --depth to adjust.\x1b[0m`);
  }
}
