/**
 * better circular — detect circular imports in source code
 *
 * Statically analyzes ESM and CJS import/require statements to find
 * circular dependency chains in your own source code.
 *
 * Usage:
 *   better circular
 *   better circular --entry src/index.js
 *   better circular --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const IMPORT_RE = /(?:^|\n)\s*(?:import\s+(?:[\w*{},\s]+\s+from\s+)?|(?:const|let|var)\s+\S+\s*=\s*require\()['"](\.[^'"]+)['"]/g;

function resolveRelative(fromFile, importPath) {
  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, importPath);
  // Try with extensions
  return resolved;
}

async function resolveFile(resolved) {
  const extensions = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  // Try index file
  for (const ext of [".js", ".mjs", ".ts", ".tsx", "/index.js", "/index.ts", "/index.mjs"]) {
    const candidate = resolved + ext;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  return null;
}

async function buildGraph(entryDir, projectRoot) {
  const graph = {}; // file -> Set<file>
  const queue = [];
  const seen = new Set();

  // Find all JS/TS files
  async function collectFiles(dir, depth = 0) {
    if (depth > 8) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await collectFiles(full, depth + 1);
      else if (/\.[jt]sx?$/.test(e.name) || e.name.endsWith(".mjs")) {
        queue.push(full);
      }
    }
  }

  await collectFiles(entryDir);

  for (const file of queue) {
    if (seen.has(file)) continue;
    seen.add(file);
    let content;
    try { content = await fs.readFile(file, "utf8"); } catch { continue; }

    graph[file] = new Set();
    let m;
    const re = new RegExp(IMPORT_RE.source, "g");
    while ((m = re.exec(content)) !== null) {
      const importPath = m[1];
      const resolved = resolveRelative(file, importPath);
      const actualFile = await resolveFile(resolved);
      if (actualFile && actualFile !== file) {
        graph[file].add(actualFile);
      }
    }
  }

  return graph;
}

function findCycles(graph) {
  const cycles = [];
  const visited = new Set();
  const stack = [];
  const stackSet = new Set();

  function dfs(node) {
    if (stackSet.has(node)) {
      // Found cycle — extract the cycle from the stack
      const cycleStart = stack.indexOf(node);
      if (cycleStart !== -1) {
        const cycle = [...stack.slice(cycleStart), node];
        // Check if this cycle is already recorded
        const cycleKey = cycle.slice(0, -1).sort().join("|");
        if (!cycles.some(c => c.slice(0, -1).sort().join("|") === cycleKey)) {
          cycles.push(cycle);
        }
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.push(node);
    stackSet.add(node);

    for (const neighbor of (graph[node] || [])) {
      dfs(neighbor);
    }

    stack.pop();
    stackSet.delete(node);
  }

  for (const node of Object.keys(graph)) {
    dfs(node);
  }

  return cycles;
}

export async function cmdCircular(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      entry:  { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better circular [options]

Detect circular imports in source code.

Options:
  --entry <dir>  Entry directory to analyze (default: src/)
  --json         Machine-readable output
  -h, --help     Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  // Determine entry directory
  let entryDir;
  if (values.entry) {
    entryDir = path.resolve(projectRoot, values.entry);
  } else {
    // Try common source dirs
    for (const candidate of ["src", "lib", "app", "."]) {
      try {
        await fs.access(path.join(projectRoot, candidate));
        entryDir = path.join(projectRoot, candidate);
        break;
      } catch {}
    }
  }

  if (!entryDir) entryDir = projectRoot;

  if (!values.json) {
    process.stderr.write(`\x1b[90mAnalyzing imports in ${path.relative(projectRoot, entryDir) || "."}…\x1b[0m\n`);
  }

  const graph = await buildGraph(entryDir, projectRoot);
  const cycles = findCycles(graph);

  const totalFiles = Object.keys(graph).length;

  if (values.json) {
    printJson({
      ok: cycles.length === 0,
      kind: "better.circular",
      filesAnalyzed: totalFiles,
      cyclesFound: cycles.length,
      cycles: cycles.map(cycle =>
        cycle.map(f => path.relative(projectRoot, f))
      ),
    });
    if (cycles.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter circular\x1b[0m — ${totalFiles} files analyzed\n`);

  if (cycles.length === 0) {
    printText(`\x1b[32m✔ No circular imports found.\x1b[0m`);
    return;
  }

  printText(`\x1b[31m✖ ${cycles.length} circular dependency chain(s) found:\x1b[0m\n`);

  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    printText(`  \x1b[31mCycle ${i + 1}:\x1b[0m`);
    for (let j = 0; j < cycle.length; j++) {
      const rel = path.relative(projectRoot, cycle[j]);
      const arrow = j === cycle.length - 1 ? "↺" : "→";
      printText(`    ${arrow} ${rel}`);
    }
    printText("");
  }

  printText(`\x1b[90mCircular imports can cause initialization issues and hard-to-debug bugs.\x1b[0m`);
  process.exitCode = 1;
}
