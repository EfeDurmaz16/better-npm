/**
 * better dep-graph-json — export dependency graph as JSON/DOT/Mermaid
 *
 * Builds a complete dependency graph from package-lock.json and
 * exports it in multiple formats for visualization tools.
 *
 * Usage:
 *   better dep-graph-json
 *   better dep-graph-json --format dot > deps.dot
 *   better dep-graph-json --format mermaid --depth 3
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parseMajor(v) {
  return parseInt(String(v).replace(/^[~^>=v]/, "").split(".")[0]) || 0;
}

async function buildGraph(projectRoot, maxDepth) {
  let lockData = null;
  try {
    lockData = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  } catch {}

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch { pkgJson = {}; }

  const nodes = new Map(); // name → { name, version, depth }
  const edges = []; // { from, to, type }

  if (!lockData?.packages) {
    // Fallback: use package.json deps only
    const rootName = pkgJson.name || "project";
    nodes.set(rootName, { name: rootName, version: pkgJson.version || "0.0.0", depth: 0, root: true });

    for (const [dep, range] of Object.entries({ ...pkgJson.dependencies, ...pkgJson.devDependencies })) {
      nodes.set(dep, { name: dep, version: range, depth: 1 });
      edges.push({ from: rootName, to: dep, type: pkgJson.dependencies?.[dep] ? "dep" : "dev" });
    }
    return { nodes: [...nodes.values()], edges, rootName };
  }

  const rootName = pkgJson.name || "project";
  nodes.set(rootName, { name: rootName, version: pkgJson.version || "0.0.0", depth: 0, root: true });

  // BFS from root
  const queue = [{ name: rootName, depth: 0, pkgEntry: lockData.packages[""] }];
  const visited = new Set([rootName]);

  while (queue.length > 0) {
    const { name, depth, pkgEntry } = queue.shift();
    if (depth >= maxDepth) continue;

    const deps = {
      ...pkgEntry?.dependencies,
      ...(depth === 0 ? pkgEntry?.devDependencies : {}),
    };

    for (const [dep, range] of Object.entries(deps || {})) {
      const lockEntry = lockData.packages[`node_modules/${dep}`];
      const version = lockEntry?.version || range;
      const type = pkgEntry?.devDependencies?.[dep] ? "dev" : "dep";

      if (!nodes.has(dep)) {
        nodes.set(dep, { name: dep, version, depth: depth + 1 });
      }
      edges.push({ from: name, to: dep, type });

      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push({ name: dep, depth: depth + 1, pkgEntry: lockEntry });
      }
    }
  }

  return { nodes: [...nodes.values()], edges, rootName };
}

function toMermaid(nodes, edges, rootName) {
  const lines = ["graph LR"];
  const safeId = (n) => n.replace(/[@/.-]/g, "_");

  const nodeMap = new Map(nodes.map(n => [n.name, n]));

  for (const n of nodes) {
    const id = safeId(n.name);
    const label = `${n.name}@${n.version}`;
    if (n.root) {
      lines.push(`  ${id}["${label}"]:::root`);
    } else {
      lines.push(`  ${id}["${label}"]`);
    }
  }

  for (const e of edges) {
    const from = safeId(e.from);
    const to = safeId(e.to);
    const arrow = e.type === "dev" ? "-. dev .->" : "-->";
    lines.push(`  ${from} ${arrow} ${to}`);
  }

  lines.push(`  classDef root fill:#4CAF50,color:#fff`);
  return lines.join("\n");
}

function toDot(nodes, edges, rootName) {
  const lines = ["digraph deps {", '  rankdir="LR";', '  node [shape=box, fontsize=10];'];
  const safeId = (n) => `"${n.replace(/"/g, '\\"')}"`;

  for (const n of nodes) {
    const color = n.root ? ", style=filled, fillcolor=lightgreen" : "";
    lines.push(`  ${safeId(n.name)} [label="${n.name}\\n${n.version}"${color}];`);
  }

  for (const e of edges) {
    const style = e.type === "dev" ? ' [style=dashed, color=gray]' : "";
    lines.push(`  ${safeId(e.from)} -> ${safeId(e.to)}${style};`);
  }

  lines.push("}");
  return lines.join("\n");
}

export async function cmdDepGraphJson(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      format: { type: "string", default: "json" },
      depth:  { type: "string", default: "3" },
      output: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better dep-graph-json [options]

Export dependency graph in JSON, DOT, or Mermaid format.

Options:
  --format <fmt>   Output format: json (default), dot, mermaid
  --depth <n>      Max dependency depth (default: 3)
  --output <file>  Write output to file instead of stdout
  --json           Alias for --format json
  -h, --help       Show this help

Examples:
  better dep-graph-json
  better dep-graph-json --format dot > deps.dot
  better dep-graph-json --format mermaid --depth 2
  better dep-graph-json --output graph.json
`);
    return;
  }

  const format = values.format || "json";
  const validFormats = ["json", "dot", "mermaid"];
  if (!validFormats.includes(format)) {
    printText(`\x1b[31mInvalid format: ${format}. Must be: ${validFormats.join(", ")}\x1b[0m`);
    process.exitCode = 1;
    return;
  }

  const maxDepth = Math.max(1, parseInt(values.depth) || 3);
  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json && format === "json") {
    process.stderr.write(`\x1b[90mBuilding dependency graph (depth: ${maxDepth})…\x1b[0m\n`);
  }

  const { nodes, edges, rootName } = await buildGraph(projectRoot, maxDepth);

  let output;
  if (format === "mermaid") {
    output = toMermaid(nodes, edges, rootName);
  } else if (format === "dot") {
    output = toDot(nodes, edges, rootName);
  } else {
    const data = {
      ok: true,
      kind: "better.dep-graph-json",
      rootName,
      maxDepth,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes: nodes.map(n => ({ name: n.name, version: n.version, depth: n.depth })),
      edges,
    };
    output = JSON.stringify(data, null, 2);
  }

  if (values.output) {
    const outPath = path.isAbsolute(values.output)
      ? values.output
      : path.join(projectRoot, values.output);
    await fs.writeFile(outPath, output, "utf8");
    printText(`\x1b[32m✔ Graph written to ${path.relative(process.cwd(), outPath)}\x1b[0m`);
    printText(`  ${nodes.length} nodes, ${edges.length} edges`);
  } else {
    process.stdout.write(output + "\n");
  }
}
