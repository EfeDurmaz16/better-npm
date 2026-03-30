/**
 * better workspace-graph — visualize monorepo workspace dependencies
 *
 * Builds a graph of inter-package dependencies within a workspace
 * and detects circular workspace dependencies.
 *
 * Usage:
 *   better workspace-graph             # ASCII tree / table
 *   better workspace-graph --mermaid   # Mermaid flowchart
 *   better workspace-graph --dot       # GraphViz DOT
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";

async function discoverWorkspaces(root) {
  // Read root package.json for workspaces field
  let rootPkg;
  try {
    rootPkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    return [];
  }

  const workspaceGlobs = rootPkg.workspaces;
  if (!workspaceGlobs) return [];

  // Simple glob expansion: support "packages/*" and "apps/*" patterns
  const globs = Array.isArray(workspaceGlobs) ? workspaceGlobs : (workspaceGlobs.packages || []);
  const workspaces = [];

  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const dir = path.join(root, glob.slice(0, -2));
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const wsPath = path.join(dir, entry.name);
          try {
            const pkg = JSON.parse(await fs.readFile(path.join(wsPath, "package.json"), "utf8"));
            workspaces.push({
              name: pkg.name || entry.name,
              path: wsPath,
              relPath: path.relative(root, wsPath),
              version: pkg.version || "0.0.0",
              deps: {
                ...pkg.dependencies,
                ...pkg.devDependencies,
                ...pkg.peerDependencies,
              },
            });
          } catch {}
        }
      } catch {}
    } else {
      // Exact path
      const wsPath = path.join(root, glob);
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(wsPath, "package.json"), "utf8"));
        workspaces.push({
          name: pkg.name || glob,
          path: wsPath,
          relPath: path.relative(root, wsPath),
          version: pkg.version || "0.0.0",
          deps: {
            ...pkg.dependencies,
            ...pkg.devDependencies,
            ...pkg.peerDependencies,
          },
        });
      } catch {}
    }
  }

  return workspaces;
}

function buildGraph(workspaces) {
  const workspaceNames = new Set(workspaces.map(w => w.name));
  const edges = []; // {from, to}
  const nodeMap = {};

  for (const ws of workspaces) {
    nodeMap[ws.name] = ws;
    for (const dep of Object.keys(ws.deps)) {
      if (workspaceNames.has(dep) && dep !== ws.name) {
        edges.push({ from: ws.name, to: dep });
      }
    }
  }

  return { nodeMap, edges, workspaceNames };
}

function findCycles(graph) {
  const { edges, workspaceNames } = graph;
  const adj = {};
  for (const name of workspaceNames) adj[name] = [];
  for (const { from, to } of edges) adj[from].push(to);

  const cycles = [];
  const visited = new Set();

  function dfs(name, stack, inStack) {
    if (inStack.has(name)) {
      const idx = stack.indexOf(name);
      cycles.push([...stack.slice(idx), name]);
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);
    inStack.add(name);
    stack.push(name);
    for (const dep of (adj[name] || [])) {
      dfs(dep, stack, inStack);
    }
    stack.pop();
    inStack.delete(name);
  }

  for (const name of workspaceNames) {
    dfs(name, [], new Set());
  }

  return cycles;
}

export async function cmdWorkspaceGraph(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      mermaid: { type: "boolean", default: false },
      dot: { type: "boolean", default: false },
      cycles: { type: "boolean", default: false },
      output: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better workspace-graph [options]

Visualize monorepo workspace dependency graph.

Options:
  --mermaid     Output Mermaid flowchart
  --dot         Output GraphViz DOT
  --cycles      Show only circular workspace deps
  --output      Write to file
  --json        Machine-readable output
  -h, --help    Show this help

Examples:
  better workspace-graph
  better workspace-graph --mermaid
  better workspace-graph --cycles
`);
    return;
  }

  const cwd = process.cwd();
  const workspaces = await discoverWorkspaces(cwd);

  if (workspaces.length === 0) {
    const msg = "No workspaces found. Add a 'workspaces' field to package.json.";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(msg); }
    process.exitCode = 1;
    return;
  }

  const graph = buildGraph(workspaces);
  const cycles = findCycles(graph);

  if (values.cycles) {
    if (values.json) {
      printJson({ ok: true, kind: "better.workspace-graph.cycles", cycles, total: cycles.length });
    } else if (cycles.length === 0) {
      printText("\x1b[32m✔ No circular workspace dependencies.\x1b[0m");
    } else {
      printText(`\x1b[31m${cycles.length} circular dependency chain(s) found:\x1b[0m`);
      for (const cycle of cycles) {
        printText(`  ${cycle.join(" → ")}`);
      }
      process.exitCode = 1;
    }
    return;
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.workspace-graph",
      workspaces: workspaces.map(w => ({
        name: w.name,
        path: w.relPath,
        version: w.version,
        depends_on: graph.edges.filter(e => e.from === w.name).map(e => e.to),
      })),
      edges: graph.edges,
      cycles,
      total: workspaces.length,
    });
    return;
  }

  if (values.dot) {
    const lines = ['digraph "workspace" {', '  rankdir=LR;', '  node [shape=box];'];
    for (const { from, to } of graph.edges) {
      lines.push(`  "${from}" -> "${to}";`);
    }
    lines.push("}");
    const output = lines.join("\n");
    if (values.output) {
      await fs.writeFile(values.output, output + "\n");
      printText(`DOT graph written to ${values.output}`);
    } else {
      process.stdout.write(output + "\n");
    }
    return;
  }

  if (values.mermaid) {
    const lines = ["graph LR"];
    for (const { from, to } of graph.edges) {
      lines.push(`  ${JSON.stringify(from)} --> ${JSON.stringify(to)}`);
    }
    if (graph.edges.length === 0) {
      lines.push("  note[No inter-workspace dependencies]");
    }
    const output = lines.join("\n");
    if (values.output) {
      await fs.writeFile(values.output, output + "\n");
      printText(`Mermaid diagram written to ${values.output}`);
    } else {
      process.stdout.write(output + "\n");
    }
    return;
  }

  // ASCII table
  printText(`\n\x1b[1mbetter workspace-graph\x1b[0m — ${workspaces.length} packages\n`);
  if (cycles.length > 0) {
    printText(`\x1b[31m⚠ ${cycles.length} circular dependency chain(s) detected\x1b[0m\n`);
  }

  printText("\x1b[1mWorkspace packages:\x1b[0m");
  for (const ws of workspaces) {
    const localDeps = graph.edges.filter(e => e.from === ws.name).map(e => e.to);
    const indicator = localDeps.length > 0 ? `→ ${localDeps.join(", ")}` : "\x1b[90mno inter-workspace deps\x1b[0m";
    printText(`  ${ws.name.padEnd(36)} \x1b[90m${ws.relPath}\x1b[0m`);
    if (localDeps.length > 0) {
      printText(`    \x1b[90m↳ depends on: ${localDeps.join(", ")}\x1b[0m`);
    }
  }

  if (graph.edges.length === 0) {
    printText("\n\x1b[90mNo inter-workspace dependencies found.\x1b[0m");
  }
}
