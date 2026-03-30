/**
 * better dep-why — explain why a package is installed
 *
 * Shows the dependency chain explaining why a given package appears
 * in node_modules (which packages depend on it).
 *
 * Usage:
 *   better dep-why <package>
 *   better dep-why <package> --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function getPkg(nmPath, name) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(nmPath, ...name.split("/"), "package.json"), "utf8"));
    return { deps: Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }), version: pkg.version };
  } catch {
    return null;
  }
}

// BFS to find all paths from root packages that lead to target
async function findPaths(nmPath, rootDeps, target, maxDepth = 6) {
  const paths = [];
  const queue = [{ chain: ["(root)"], current: null, deps: rootDeps, depth: 0 }];
  const seen = new Set();

  while (queue.length > 0) {
    const { chain, deps, depth } = queue.shift();
    if (depth > maxDepth) continue;

    for (const dep of deps) {
      if (dep === target) {
        paths.push([...chain, dep]);
        continue;
      }
      const key = `${chain[chain.length - 1]}→${dep}@${depth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (depth < maxDepth) {
        const pkg = await getPkg(nmPath, dep);
        if (pkg) {
          queue.push({ chain: [...chain, dep], deps: pkg.deps, depth: depth + 1 });
        }
      }
    }
  }

  return paths;
}

export async function cmdDepWhy(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      depth: { type: "string", default: "6" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better dep-why <package> [options]

Explain why a package is installed (dependency chain).

Options:
  --depth <n>  Max search depth (default: 6)
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better dep-why lodash
  better dep-why @babel/core
`);
    return;
  }

  const target = positionals[0];
  if (!target) {
    printText("Error: Package name required. Usage: better dep-why <package>");
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter dep-why\x1b[0m — why is \x1b[1m${target}\x1b[0m installed?\n`);
    process.stderr.write(`\x1b[90mSearching dependency graph...\x1b[0m\n`);
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

  // Check if it's a direct dep
  const isDirect = !!(pkgJson.dependencies?.[target] || pkgJson.devDependencies?.[target]);

  if (isDirect) {
    const devFlag = pkgJson.devDependencies?.[target] ? " (devDependency)" : " (dependency)";
    if (values.json) {
      printJson({ ok: true, kind: "better.dep-why", package: target, direct: true, paths: [[target]] });
      return;
    }
    printText(`  \x1b[32m✔\x1b[0m  \x1b[1m${target}\x1b[0m is a direct dependency${devFlag}\n`);
    return;
  }

  // Check if installed at all
  const installed = await getPkg(nmPath, target);
  if (!installed) {
    const msg = `${target} is not installed in node_modules`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`  \x1b[31m✘\x1b[0m  ${msg}\n`); }
    process.exitCode = 1;
    return;
  }

  const rootDeps = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });
  const maxDepth = parseInt(values.depth, 10) || 6;
  const paths = await findPaths(nmPath, rootDeps, target, maxDepth);

  // Deduplicate paths (keep shortest per first-hop)
  const seen = new Set();
  const uniquePaths = paths.filter(p => {
    const key = p.slice(1).join("→");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.length - b.length).slice(0, 10);

  if (values.json) {
    printJson({ ok: true, kind: "better.dep-why", package: target, version: installed.version, direct: false, paths: uniquePaths });
    return;
  }

  if (uniquePaths.length === 0) {
    printText(`  \x1b[33m⚠\x1b[0m  Could not trace why \x1b[1m${target}\x1b[0m is installed (may be deeply nested)\n`);
    return;
  }

  printText(`  \x1b[1m${target}\x1b[0m@${installed.version} is installed because:\n`);
  for (const p of uniquePaths) {
    const chain = p.map((n, i) => i === 0 ? "\x1b[90m(root)\x1b[0m" : i === p.length - 1 ? `\x1b[32m${n}\x1b[0m` : n).join(" \x1b[90m→\x1b[0m ");
    printText(`  ${chain}`);
  }
  if (paths.length > uniquePaths.length) {
    printText(`  \x1b[90m... and ${paths.length - uniquePaths.length} more paths\x1b[0m`);
  }
  printText("");
}
