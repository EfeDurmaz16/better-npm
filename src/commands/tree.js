/**
 * better tree — display dependency tree
 *
 * Shows a visual tree of all dependencies and their sub-dependencies,
 * similar to `npm ls --all` but with better formatting and filtering.
 *
 * Usage:
 *   better tree
 *   better tree --depth 2
 *   better tree --filter express
 *   better tree --prod
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function readPackageJson(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

async function buildTree(nmPath, name, visited, depth, maxDepth) {
  if (depth > maxDepth) return { name, version: "...", children: [], truncated: true };

  const key = name;
  if (visited.has(key)) return { name, version: "(circular)", children: [], circular: true };
  visited.add(key);

  let pkgJson;
  try {
    pkgJson = await readPackageJson(path.join(nmPath, name));
  } catch { pkgJson = null; }

  const version = pkgJson?.version || "?";
  const deps = Object.keys(pkgJson?.dependencies || {});

  const children = [];
  for (const dep of deps) {
    const child = await buildTree(nmPath, dep, new Set(visited), depth + 1, maxDepth);
    children.push(child);
  }

  visited.delete(key);
  return { name, version, children };
}

function renderTree(node, prefix = "", isLast = true, lines = []) {
  const connector = isLast ? "└── " : "├── ";
  const versionStr = node.version ? `@${node.version}` : "";
  const suffix = node.circular ? " \x1b[33m(circular)\x1b[0m" : node.truncated ? " \x1b[90m(max depth)\x1b[0m" : "";
  lines.push(`${prefix}${connector}${node.name}${versionStr}${suffix}`);

  const childPrefix = prefix + (isLast ? "    " : "│   ");
  for (let i = 0; i < node.children.length; i++) {
    const isChildLast = i === node.children.length - 1;
    renderTree(node.children[i], childPrefix, isChildLast, lines);
  }
  return lines;
}

export async function cmdTree(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      depth:  { type: "string" },
      filter: { type: "string" },
      prod:   { type: "boolean", default: false },
      dev:    { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better tree [options]

Display a visual dependency tree.

Options:
  --depth <N>    Max depth to display (default: 3)
  --filter <pkg> Show only branches containing this package
  --prod         Show only production dependencies
  --dev          Show only dev dependencies
  --json         Machine-readable output
  -h, --help     Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const maxDepth = parseInt(values.depth) || 3;
  const filterPkg = values.filter?.toLowerCase();

  const pkgJson = await readPackageJson(projectRoot);
  if (!pkgJson) {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const nmPath = path.join(projectRoot, "node_modules");

  let topDeps;
  if (values.dev) {
    topDeps = Object.keys(pkgJson.devDependencies || {});
  } else if (values.prod) {
    topDeps = Object.keys(pkgJson.dependencies || {});
  } else {
    topDeps = [
      ...Object.keys(pkgJson.dependencies || {}),
      ...Object.keys(pkgJson.devDependencies || {}),
    ];
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mBuilding dependency tree…\x1b[0m\n`);
  }

  const trees = [];
  for (const dep of topDeps) {
    const tree = await buildTree(nmPath, dep, new Set(), 0, maxDepth);
    trees.push(tree);
  }

  // Filter function: keep tree if it contains filterPkg
  function treeContains(node, pkg) {
    if (node.name.toLowerCase().includes(pkg)) return true;
    return node.children.some(c => treeContains(c, pkg));
  }

  function countNodes(node) {
    return 1 + node.children.reduce((s, c) => s + countNodes(c), 0);
  }

  const filteredTrees = filterPkg
    ? trees.filter(t => treeContains(t, filterPkg))
    : trees;

  const totalNodes = filteredTrees.reduce((s, t) => s + countNodes(t), 0);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.tree",
      project: pkgJson.name,
      topLevel: filteredTrees.length,
      totalNodes,
      tree: filteredTrees,
    });
    return;
  }

  const name = pkgJson.name || path.basename(projectRoot);
  const ver = pkgJson.version || "";
  printText(`\n\x1b[1m${name}${ver ? `@${ver}` : ""}\x1b[0m\n`);

  if (filteredTrees.length === 0) {
    printText(`\x1b[90mNo packages found${filterPkg ? ` matching "${filterPkg}"` : ""}.\x1b[0m`);
    return;
  }

  for (let i = 0; i < filteredTrees.length; i++) {
    const isLast = i === filteredTrees.length - 1;
    renderTree(filteredTrees[i], "", isLast).forEach(l => printText(l));
  }

  printText(`\n\x1b[90m${filteredTrees.length} top-level, ${totalNodes} total (depth: ${maxDepth})\x1b[0m`);
  if (filterPkg) printText(`\x1b[90mFiltered to: "${filterPkg}"\x1b[0m`);
}
