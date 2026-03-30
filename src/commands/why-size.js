/**
 * better why-size <package> — explain the size cost of a package
 *
 * Shows the disk footprint breakdown of a package and its
 * transitive dependencies, helping understand what's consuming space.
 *
 * Usage:
 *   better why-size lodash
 *   better why-size react --depth 3
 *   better why-size webpack --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function getDirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        total += await getDirSize(p);
      } else if (e.isFile()) {
        try {
          const stat = await fs.stat(p);
          total += stat.size;
        } catch {}
      }
    }
  } catch {}
  return total;
}

function fmtBytes(b) {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

async function readPkgJson(nmPath, name) {
  try {
    return JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

async function buildSizeTree(nmPath, name, depth, maxDepth, visited = new Set()) {
  if (visited.has(name)) return { name, size: 0, ownSize: 0, deps: [], circular: true };
  visited.add(name);

  const pkg = await readPkgJson(nmPath, name);
  if (!pkg) return null;

  const pkgDir = path.join(nmPath, name);
  const ownSize = await getDirSize(pkgDir);

  const depNames = depth < maxDepth ? Object.keys(pkg.dependencies || {}) : [];
  const depResults = [];

  for (const dep of depNames) {
    const child = await buildSizeTree(nmPath, dep, depth + 1, maxDepth, new Set(visited));
    if (child) depResults.push(child);
  }

  const transitiveSize = depResults.reduce((s, d) => s + d.size, 0);

  return {
    name,
    version: pkg.version,
    ownSize,
    size: ownSize + transitiveSize,
    deps: depResults,
    circular: false,
  };
}

function renderTree(node, prefix = "", isLast = true, lines = []) {
  const connector = isLast ? "└── " : "├── ";
  const sizeStr = fmtBytes(node.size);
  const ownStr = node.ownSize !== node.size ? ` (own: ${fmtBytes(node.ownSize)})` : "";
  const tag = node.circular ? " \x1b[33m[circular]\x1b[0m" : "";
  lines.push(`${prefix}${connector}\x1b[1m${node.name}\x1b[0m@${node.version || "?"}  ${sizeStr}${ownStr}${tag}`);

  const childPrefix = prefix + (isLast ? "    " : "│   ");
  node.deps.forEach((child, i) => {
    renderTree(child, childPrefix, i === node.deps.length - 1, lines);
  });

  return lines;
}

function totalTransitiveDeps(node, seen = new Set()) {
  if (seen.has(node.name)) return 0;
  seen.add(node.name);
  return 1 + node.deps.reduce((s, d) => s + totalTransitiveDeps(d, seen), 0);
}

export async function cmdWhySize(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      depth: { type: "string", default: "3" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better why-size <package> [options]

Show the disk size cost of a package and its dependencies.

Options:
  --depth <n>   How many levels of dependencies to analyze (default: 3)
  --json        Machine-readable output
  -h, --help    Show this help

Examples:
  better why-size lodash
  better why-size webpack --depth 2
`);
    return;
  }

  if (positionals.length === 0) {
    printText(`Usage: better why-size <package> [--depth <n>] [--json]\nRun with --help for details.`);
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];
  const maxDepth = Math.max(0, parseInt(values.depth) || 3);

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    process.stderr.write(`\x1b[90mAnalyzing size tree for ${pkgName} (depth: ${maxDepth})…\x1b[0m\n`);
  }

  const tree = await buildSizeTree(nmPath, pkgName, 0, maxDepth);

  if (!tree) {
    const msg = `Package "${pkgName}" not found in node_modules`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.why-size",
      name: pkgName,
      totalSize: tree.size,
      ownSize: tree.ownSize,
      transitiveSize: tree.size - tree.ownSize,
      totalDeps: totalTransitiveDeps(tree) - 1,
      tree,
    });
    return;
  }

  printText(`\n\x1b[1mbetter why-size\x1b[0m — ${pkgName}\n`);
  printText(`  Total size:      \x1b[1m${fmtBytes(tree.size)}\x1b[0m`);
  printText(`  Own size:        ${fmtBytes(tree.ownSize)}`);
  printText(`  Deps size:       ${fmtBytes(tree.size - tree.ownSize)}`);
  printText(`  Direct deps:     ${tree.deps.length}`);
  printText(`  Total deps:      ${totalTransitiveDeps(tree) - 1}`);
  printText("");

  if (tree.deps.length > 0) {
    printText(`\x1b[90mDependency size tree (depth: ${maxDepth}):\x1b[0m\n`);
    const lines = renderTree(tree, "", true);
    // skip root (first line), show children
    for (const line of lines) printText(line);
  }

  printText("");
}
