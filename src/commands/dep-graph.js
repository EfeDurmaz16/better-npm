/**
 * better dep-graph — visualize dependency graph as ASCII tree or DOT
 *
 * Renders the dependency tree for your project as an ASCII tree,
 * with options to output in DOT format for Graphviz visualization.
 *
 * Usage:
 *   better dep-graph
 *   better dep-graph --pkg express
 *   better dep-graph --format dot
 *   better dep-graph --depth 3
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function readPkg(nmPath, name) {
  try {
    return JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

async function buildTree(nmPath, name, version, maxDepth, visited, depth = 0) {
  const key = `${name}@${version}`;
  if (depth > maxDepth || visited.has(key)) {
    return { name, version, deps: [], circular: visited.has(key) };
  }
  visited.add(key);

  const pkg = await readPkg(nmPath, name);
  if (!pkg) return { name, version: version || "?", deps: [], missing: true };

  const deps = Object.keys(pkg.dependencies || {});
  const children = [];
  if (depth < maxDepth) {
    const BATCH = 8;
    for (let i = 0; i < deps.length; i += BATCH) {
      const batch = deps.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (dep) => {
        const depPkg = await readPkg(nmPath, dep);
        return buildTree(nmPath, dep, depPkg?.version || "?", maxDepth, new Set(visited), depth + 1);
      }));
      children.push(...results);
    }
  }

  return { name, version: pkg.version, deps: children };
}

function renderTree(node, prefix = "", isLast = true, output = []) {
  const connector = isLast ? "└── " : "├── ";
  const missingFlag = node.missing ? " \x1b[31m[missing]\x1b[0m" : "";
  const circularFlag = node.circular ? " \x1b[33m[circular]\x1b[0m" : "";
  output.push(`${prefix}${connector}\x1b[1m${node.name}\x1b[0m@${node.version}${missingFlag}${circularFlag}`);
  const childPrefix = prefix + (isLast ? "    " : "│   ");
  for (let i = 0; i < node.deps.length; i++) {
    renderTree(node.deps[i], childPrefix, i === node.deps.length - 1, output);
  }
  return output;
}

function renderDot(rootName, rootVersion, nodes, edges) {
  const lines = ["digraph dependencies {", `  rankdir=LR;`, `  node [shape=box, fontsize=10];`];
  const nodeId = (name) => `"${name}"`;
  lines.push(`  ${nodeId(rootName)} [label="${rootName}@${rootVersion}", style=filled, fillcolor=lightblue];`);
  for (const [from, to] of edges) {
    lines.push(`  ${nodeId(from)} -> ${nodeId(to)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function collectEdges(node, edges = new Set()) {
  for (const dep of node.deps) {
    const key = `${node.name}|${dep.name}`;
    if (!edges.has(key)) {
      edges.add(key);
      collectEdges(dep, edges);
    }
  }
  return [...edges].map(k => k.split("|"));
}

export async function cmdDepGraph(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      pkg:     { type: "string" },
      format:  { type: "string", default: "tree" },
      depth:   { type: "string", default: "3" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better dep-graph [options]

Visualize dependency graph.

Options:
  --pkg <name>    Show graph for specific package (default: root project)
  --format <f>    Output format: tree|dot (default: tree)
  --depth <n>     Maximum depth (default: 3)
  --json          Machine-readable output
  -h, --help      Show this help

Examples:
  better dep-graph --depth 2
  better dep-graph --pkg express --depth 5
  better dep-graph --format dot | dot -Tsvg > deps.svg
`);
    return;
  }

  const maxDepth = parseInt(values.depth, 10) || 3;
  const format = values.format.toLowerCase();

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json && format === "tree") {
    printText(`\n\x1b[1mbetter dep-graph\x1b[0m\n`);
    process.stderr.write(`\x1b[90mBuilding dependency graph (depth: ${maxDepth})...\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  let rootName = pkgJson.name || "project";
  let rootVersion = pkgJson.version || "0.0.0";
  let rootDeps = Object.keys(pkgJson.dependencies || {});

  if (values.pkg) {
    const targetPkg = await readPkg(nmPath, values.pkg);
    if (!targetPkg) {
      const msg = `Package not found: ${values.pkg}`;
      if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
      process.exitCode = 1;
      return;
    }
    rootName = targetPkg.name;
    rootVersion = targetPkg.version;
    rootDeps = Object.keys(targetPkg.dependencies || {});
  }

  // Build tree
  const visited = new Set([`${rootName}@${rootVersion}`]);
  const childNodes = [];
  const BATCH = 8;
  for (let i = 0; i < rootDeps.length; i += BATCH) {
    const batch = rootDeps.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (dep) => {
      const depPkg = await readPkg(nmPath, dep);
      return buildTree(nmPath, dep, depPkg?.version || "?", maxDepth - 1, new Set(visited), 1);
    }));
    childNodes.push(...results);
  }

  const root = { name: rootName, version: rootVersion, deps: childNodes };

  if (values.json) {
    printJson({ ok: true, kind: "better.dep-graph", root: rootName, version: rootVersion, depth: maxDepth, tree: root });
    return;
  }

  if (format === "dot") {
    const edges = collectEdges(root);
    process.stdout.write(renderDot(rootName, rootVersion, [], edges) + "\n");
    return;
  }

  // ASCII tree
  printText(`\x1b[1m${rootName}\x1b[0m@${rootVersion}`);
  const lines = renderTree({ name: rootName, version: rootVersion, deps: childNodes }, "", true);
  // Skip the root line (already printed above)
  for (const child of childNodes) {
    const idx = childNodes.indexOf(child);
    renderTree(child, "", idx === childNodes.length - 1).forEach(l => printText(l));
  }
  printText("");
}
