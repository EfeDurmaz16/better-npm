/**
 * better circular-deps — detect circular dependency chains
 *
 * Analyzes the dependency graph for circular references (A→B→C→A),
 * which can cause issues with module initialization and bundling.
 *
 * Usage:
 *   better circular-deps
 *   better circular-deps --depth 5
 *   better circular-deps --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function readDeps(nmPath, name) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
    return Object.keys(pkg.dependencies || {});
  } catch {
    return [];
  }
}

async function buildGraph(nmPath, rootDeps, maxDepth = 4) {
  const graph = new Map(); // name → Set<name>
  const queue = [...rootDeps.map(d => ({ name: d, depth: 0 }))];
  const visited = new Set(rootDeps);

  while (queue.length > 0) {
    const { name, depth } = queue.shift();
    if (graph.has(name)) continue;

    const deps = await readDeps(nmPath, name);
    graph.set(name, new Set(deps));

    if (depth < maxDepth) {
      for (const dep of deps) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push({ name: dep, depth: depth + 1 });
        }
      }
    }
  }
  return graph;
}

function findCycles(graph) {
  const cycles = [];
  const visited = new Set();
  const inStack = new Set();

  function dfs(node, path) {
    visited.add(node);
    inStack.add(node);
    path.push(node);

    const deps = graph.get(node) || new Set();
    for (const dep of deps) {
      if (inStack.has(dep)) {
        // Found cycle
        const cycleStart = path.indexOf(dep);
        const cycle = path.slice(cycleStart).concat(dep);
        const key = cycle.slice(0, -1).sort().join(",");
        if (!cycles.some(c => c.slice(0, -1).sort().join(",") === key)) {
          cycles.push([...cycle]);
        }
      } else if (!visited.has(dep) && graph.has(dep)) {
        dfs(dep, path);
      }
    }

    path.pop();
    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }
  return cycles;
}

export async function cmdCircularDeps(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      depth:  { type: "string", default: "4" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better circular-deps [options]

Detect circular dependency chains in node_modules.

Options:
  --depth <n>  Maximum graph traversal depth (default: 4)
  --json       Machine-readable output
  -h, --help   Show this help

Finds packages that directly or indirectly depend on each other,
which can cause module initialization issues.
`);
    return;
  }

  const maxDepth = parseInt(values.depth, 10) || 4;
  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter circular-deps\x1b[0m  (depth: ${maxDepth})\n`);
    process.stderr.write(`\x1b[90mBuilding dependency graph...\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const rootDeps = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });

  if (rootDeps.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.circular-deps", cycles: [] }); return; }
    printText(`  \x1b[90mNo dependencies to analyze.\x1b[0m\n`);
    return;
  }

  const graph = await buildGraph(nmPath, rootDeps, maxDepth);
  const cycles = findCycles(graph);

  if (values.json) {
    printJson({ ok: cycles.length === 0, kind: "better.circular-deps", graphSize: graph.size, cycles });
    if (cycles.length > 0) process.exitCode = 1;
    return;
  }

  printText(`  Graph size: ${graph.size} packages\n`);

  if (cycles.length === 0) {
    printText(`\x1b[32m✔ No circular dependencies detected.\x1b[0m`);
  } else {
    printText(`\x1b[33m⚠ ${cycles.length} circular dependenc${cycles.length === 1 ? "y" : "ies"} detected:\x1b[0m\n`);
    for (const cycle of cycles.slice(0, 10)) {
      printText(`  \x1b[33m⊙\x1b[0m  ${cycle.join(" → ")}`);
    }
    if (cycles.length > 10) printText(`  \x1b[90m... and ${cycles.length - 10} more\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
