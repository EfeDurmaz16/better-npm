/**
 * better graph — dependency graph visualization
 *
 * Generates a dependency tree/graph in various formats.
 *
 * Usage:
 *   better graph                     # print ASCII tree of all deps
 *   better graph --depth 2           # limit tree depth
 *   better graph --pkg express       # subgraph for specific package
 *   better graph --format dot        # GraphViz DOT format
 *   better graph --format mermaid    # Mermaid diagram
 *   better graph --cycles            # highlight circular dependencies
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { runGraphStatsNapi } from "../lib/core.js";
import fs from "node:fs/promises";
import path from "node:path";

export async function cmdGraph(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      depth: { type: "string", default: "3" },
      pkg: { type: "string" },
      format: { type: "string", default: "tree" },
      cycles: { type: "boolean", default: false },
      stats: { type: "boolean", default: false },
      output: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better graph [options]

Dependency graph visualization.

Options:
  --depth N        Max traversal depth (default: 3)
  --pkg <name>     Focus on specific package subgraph
  --format <fmt>   Output format: tree (default) | dot | mermaid | json
  --cycles         Show only circular dependency paths
  --output <file>  Write to file instead of stdout
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better graph                         # ASCII tree (depth 3)
  better graph --depth 1               # direct deps only
  better graph --pkg express           # why is express in the tree?
  better graph --format mermaid        # Mermaid flowchart
  better graph --format dot --output graph.dot
  better graph --cycles                # detect circular deps
`);
    return;
  }

  const cwd = process.cwd();

  if (values.stats) {
    const napiStats = runGraphStatsNapi(cwd);
    if (napiStats?.ok) {
      if (values.json) { printJson(napiStats); return; }
      printText([
        "better graph stats",
        `- total packages: ${napiStats.total}`,
        `- direct: ${napiStats.direct}`,
        `- transitive: ${napiStats.transitive}`,
        `- max depth: ${napiStats.max_depth}`,
        `- cycles: ${napiStats.has_cycles ? `yes (${napiStats.cycle_count})` : "none"}`,
      ].join("\n"));
      return;
    }
  }

  const maxDepth = parseInt(values.depth) || 3;

  // Read package-lock.json for the full dep graph
  let lockData;
  let pkgJson;
  try {
    lockData = JSON.parse(await fs.readFile(path.join(cwd, "package-lock.json"), "utf8"));
    pkgJson = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
  } catch (err) {
    const msg = `Cannot read package-lock.json: ${err.message}. Run 'better install' first.`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // Build adjacency map from lock packages
  const lockPkgs = lockData.packages || {};
  const adjMap = new Map(); // name -> { version, deps: [name] }

  for (const [pkgPath, info] of Object.entries(lockPkgs)) {
    if (!pkgPath) continue;
    const name = pkgPath.startsWith("node_modules/")
      ? pkgPath.replace(/^.*node_modules\//, "")
      : pkgPath;
    if (!name) continue;
    const deps = Object.keys({
      ...(info.dependencies || {}),
      ...(info.peerDependencies || {}),
    });
    adjMap.set(name, { version: info.version || "?", deps });
  }

  // Direct dependencies from package.json
  const directDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
  };

  const rootName = pkgJson.name || path.basename(cwd);
  const focusPkg = values.pkg;

  // Detect cycles using DFS
  function findCycles() {
    const cycles = [];
    const visited = new Set();
    const stack = [];

    function dfs(name) {
      if (stack.includes(name)) {
        const cycleStart = stack.indexOf(name);
        cycles.push([...stack.slice(cycleStart), name]);
        return;
      }
      if (visited.has(name)) return;
      visited.add(name);
      stack.push(name);
      const node = adjMap.get(name);
      if (node) {
        for (const dep of node.deps) {
          dfs(dep);
        }
      }
      stack.pop();
    }

    for (const name of Object.keys(directDeps)) {
      dfs(name);
    }
    return cycles;
  }

  if (values.cycles) {
    const cycles = findCycles();
    if (values.json) {
      printJson({ ok: true, kind: "better.graph.cycles", cycles, total: cycles.length });
    } else if (cycles.length === 0) {
      printText("\x1b[32mNo circular dependencies detected.\x1b[0m");
    } else {
      printText(`\n\x1b[31mCircular dependencies (${cycles.length} found):\x1b[0m\n`);
      for (const cycle of cycles) {
        printText("  " + cycle.join(" → "));
      }
    }
    return;
  }

  // ASCII tree format
  function renderTree(name, depth, prefix, visited) {
    if (depth > maxDepth) return;
    const node = adjMap.get(name);
    const version = node?.version || "?";
    const isCircular = visited.has(name);
    const marker = isCircular ? " \x1b[31m(circular)\x1b[0m" : "";
    printText(`${prefix}${name}@${version}${marker}`);
    if (isCircular || !node) return;
    visited.add(name);
    const deps = node.deps.filter(d => adjMap.has(d));
    for (let i = 0; i < deps.length; i++) {
      const isLast = i === deps.length - 1;
      const childPrefix = prefix.replace(/[├└]/g, " ").replace(/─/g, " ");
      renderTree(deps[i], depth + 1,
        childPrefix + (isLast ? "└─ " : "├─ "),
        new Set(visited));
    }
    visited.delete(name);
  }

  // Mermaid format
  function renderMermaid(startDeps) {
    const lines = ["graph LR"];
    const seen = new Set();
    const edges = new Set();

    function traverse(name, depth) {
      if (depth > maxDepth || seen.has(name)) return;
      seen.add(name);
      const node = adjMap.get(name);
      if (!node) return;
      for (const dep of node.deps) {
        const edge = `${name} --> ${dep}`;
        if (!edges.has(edge)) {
          edges.add(edge);
          lines.push(`  ${JSON.stringify(name)} --> ${JSON.stringify(dep)}`);
        }
        traverse(dep, depth + 1);
      }
    }

    for (const name of startDeps) traverse(name, 0);
    return lines.join("\n");
  }

  // DOT format
  function renderDot(startDeps) {
    const lines = [`digraph "${rootName}" {`, '  rankdir=LR;', '  node [shape=box];'];
    const seen = new Set();
    const edges = new Set();

    function traverse(name, depth) {
      if (depth > maxDepth || seen.has(name)) return;
      seen.add(name);
      const node = adjMap.get(name);
      if (!node) return;
      for (const dep of node.deps) {
        const edge = `  "${name}" -> "${dep}";`;
        if (!edges.has(edge)) {
          edges.add(edge);
          lines.push(edge);
        }
        traverse(dep, depth + 1);
      }
    }

    for (const name of startDeps) traverse(name, 0);
    lines.push("}");
    return lines.join("\n");
  }

  const startDeps = focusPkg
    ? [focusPkg]
    : Object.keys(directDeps);

  if (startDeps.length === 0) {
    printText("No dependencies found.");
    return;
  }

  let output;
  const format = values.format;

  if (format === "dot") {
    output = renderDot(startDeps);
  } else if (format === "mermaid") {
    output = renderMermaid(startDeps);
  } else if (format === "json") {
    // Build a nested JSON tree
    function buildTree(name, depth, visited) {
      if (depth > maxDepth || visited.has(name)) return { name, circular: true };
      visited.add(name);
      const node = adjMap.get(name);
      const children = (node?.deps || [])
        .filter(d => adjMap.has(d))
        .map(d => buildTree(d, depth + 1, new Set(visited)));
      return { name, version: node?.version || "?", dependencies: children };
    }
    const tree = {
      name: rootName,
      version: pkgJson.version || "0.0.0",
      dependencies: startDeps
        .filter(n => adjMap.has(n))
        .map(n => buildTree(n, 0, new Set())),
    };
    if (values.json) {
      printJson({ ok: true, kind: "better.graph", tree });
      return;
    }
    output = JSON.stringify(tree, null, 2);
  } else {
    // ASCII tree
    if (values.json) {
      printJson({ ok: false, error: "Use --format json for JSON output" });
      process.exitCode = 1;
      return;
    }
    printText(`\n\x1b[1m${rootName}@${pkgJson.version || "0.0.0"}\x1b[0m (depth: ${maxDepth})\n`);
    for (let i = 0; i < startDeps.length; i++) {
      const name = startDeps[i];
      const isLast = i === startDeps.length - 1;
      if (adjMap.has(name)) {
        renderTree(name, 1, isLast ? "└─ " : "├─ ", new Set());
      } else {
        printText((isLast ? "└─ " : "├─ ") + name + " \x1b[90m(not installed)\x1b[0m");
      }
    }
    return;
  }

  if (values.output) {
    await fs.writeFile(values.output, output + "\n");
    printText(`Graph written to ${values.output}`);
  } else {
    process.stdout.write(output + "\n");
  }
}
