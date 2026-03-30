/**
 * better workspace-deps — analyze cross-workspace dependency graph
 *
 * Maps workspace-to-workspace dependencies in a monorepo,
 * detects circular dependencies, and shows which workspaces
 * depend on each other.
 *
 * Usage:
 *   better workspace-deps
 *   better workspace-deps --cycles
 *   better workspace-deps --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function expandGlob(pattern, root) {
  const parts = pattern.split("/");
  let results = [root];
  for (const part of parts) {
    if (part === "**") continue;
    const next = [];
    for (const dir of results) {
      if (part.includes("*")) {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (e.isDirectory()) {
            const re = new RegExp("^" + part.replace(/\*/g, ".*") + "$");
            if (re.test(e.name)) next.push(path.join(dir, e.name));
          }
        }
      } else {
        const candidate = path.join(dir, part);
        try { await fs.access(candidate); next.push(candidate); } catch {}
      }
    }
    results = next;
  }
  return results;
}

function findCycles(graph) {
  const cycles = [];
  const visited = new Set();
  const inStack = new Set();

  function dfs(node, stack) {
    visited.add(node);
    inStack.add(node);
    for (const dep of (graph[node] || [])) {
      if (inStack.has(dep)) {
        const cycleStart = stack.indexOf(dep);
        if (cycleStart >= 0) cycles.push([...stack.slice(cycleStart), dep]);
      } else if (!visited.has(dep)) {
        dfs(dep, [...stack, dep]);
      }
    }
    inStack.delete(node);
  }

  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) dfs(node, [node]);
  }
  return cycles;
}

export async function cmdWorkspaceDeps(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      cycles: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better workspace-deps [options]

Analyze cross-workspace dependencies in a monorepo.

Options:
  --cycles     Show only circular dependency warnings
  --json       Machine-readable output
  -h, --help   Show this help

Shows which workspace packages depend on each other,
detects circular dependencies, and identifies leaf/root workspaces.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let rootPkg;
  try {
    rootPkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const workspacePatterns = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : Array.isArray(rootPkg.workspaces?.packages)
    ? rootPkg.workspaces.packages
    : [];

  if (workspacePatterns.length === 0) {
    const msg = "No workspaces field found in package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  // Discover workspaces
  const workspacePaths = [];
  for (const pattern of workspacePatterns) {
    const expanded = await expandGlob(pattern, projectRoot);
    for (const dir of expanded) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
        if (pkg.name) workspacePaths.push({ dir, name: pkg.name, pkg });
      } catch {}
    }
  }

  if (workspacePaths.length === 0) {
    const msg = "No workspace packages found";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    return;
  }

  const wsNames = new Set(workspacePaths.map(w => w.name));

  // Build dependency graph (workspace → workspace deps)
  const graph = {};
  for (const ws of workspacePaths) {
    const allDeps = { ...ws.pkg.dependencies, ...ws.pkg.devDependencies, ...ws.pkg.peerDependencies };
    const wsDeps = Object.keys(allDeps).filter(d => wsNames.has(d));
    graph[ws.name] = wsDeps;
  }

  const cycles = findCycles(graph);

  if (values.json) {
    printJson({
      ok: cycles.length === 0,
      kind: "better.workspace-deps",
      workspaces: workspacePaths.length,
      graph,
      cycles,
    });
    if (cycles.length > 0) process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter workspace-deps\x1b[0m — ${workspacePaths.length} workspace(s)\n`);
  }

  if (values.cycles) {
    if (cycles.length === 0) {
      printText(`\x1b[32m✔ No circular workspace dependencies.\x1b[0m`);
    } else {
      for (const cycle of cycles) {
        printText(`  \x1b[31m✖ Cycle: ${cycle.join(" → ")}\x1b[0m`);
      }
      process.exitCode = 1;
    }
    printText("");
    return;
  }

  // Show graph
  for (const ws of workspacePaths) {
    const deps = graph[ws.name] || [];
    const dir = path.relative(projectRoot, ws.dir);
    if (deps.length === 0) {
      printText(`  \x1b[90m${ws.name}\x1b[0m  \x1b[90m(${dir})\x1b[0m`);
    } else {
      printText(`  \x1b[1m${ws.name}\x1b[0m  \x1b[90m(${dir})\x1b[0m`);
      for (const dep of deps) {
        printText(`    \x1b[90m└→\x1b[0m ${dep}`);
      }
    }
  }

  if (cycles.length > 0) {
    printText(`\n\x1b[31mCircular dependencies detected:\x1b[0m`);
    for (const cycle of cycles) {
      printText(`  \x1b[31m✖\x1b[0m  ${cycle.join(" → ")}`);
    }
    printText("");
    printText(`\x1b[31m✖ ${cycles.length} circular dependency cycle(s) found.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\n\x1b[32m✔ No circular workspace dependencies.\x1b[0m`);
  }
  printText("");
}
