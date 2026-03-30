/**
 * better workspace-deps — visualize workspace dependency graph
 *
 * Shows how packages in a monorepo workspace depend on each other,
 * highlighting cross-package dependencies and potential issues.
 *
 * Usage:
 *   better workspace-deps
 *   better workspace-deps --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { createRequire } from "node:module";

async function expandGlob(base, pattern) {
  const dirs = [];
  if (pattern.includes("*")) {
    const prefix = pattern.slice(0, pattern.indexOf("*")).replace(/\/$/, "");
    const prefixDir = path.join(base, prefix);
    try {
      const entries = await fs.readdir(prefixDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) dirs.push(path.join(prefixDir, e.name));
      }
    } catch {}
  } else {
    dirs.push(path.join(base, pattern));
  }
  return dirs;
}

export async function cmdWorkspaceDeps(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      dot:   { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better workspace-deps [options]

Visualize dependency graph between workspace packages.

Options:
  --dot        Output Graphviz DOT format
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better workspace-deps
  better workspace-deps --dot | dot -Tpng -o graph.png
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json && !values.dot) {
    printText(`\n\x1b[1mbetter workspace-deps\x1b[0m\n`);
  }

  let rootPkg = {};
  try {
    rootPkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read root package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const workspaceGlobs = rootPkg.workspaces || rootPkg.workspaces?.packages || [];
  if (workspaceGlobs.length === 0) {
    const msg = "No workspaces configured in package.json";
    if (values.json) { printJson({ ok: true, kind: "better.workspace-deps", packages: [] }); return; }
    printText(`  \x1b[90m${msg}\x1b[0m\n`);
    return;
  }

  // Find all workspace packages
  const wsDirs = [];
  const patterns = Array.isArray(workspaceGlobs) ? workspaceGlobs : workspaceGlobs.packages || [];
  for (const pattern of patterns) {
    const expanded = await expandGlob(projectRoot, pattern);
    wsDirs.push(...expanded);
  }

  const packages = [];
  for (const dir of wsDirs) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
      if (pkg.name) {
        packages.push({
          name: pkg.name,
          version: pkg.version,
          dir: path.relative(projectRoot, dir),
          deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }),
        });
      }
    } catch {}
  }

  if (packages.length === 0) {
    const msg = "No workspace packages found";
    if (values.json) { printJson({ ok: true, kind: "better.workspace-deps", packages: [] }); return; }
    printText(`  \x1b[90m${msg}\x1b[0m\n`);
    return;
  }

  const wsNames = new Set(packages.map(p => p.name));

  // Build edges: source → [ targets in workspace ]
  const edges = [];
  for (const pkg of packages) {
    for (const dep of pkg.deps) {
      if (wsNames.has(dep)) {
        edges.push({ from: pkg.name, to: dep });
      }
    }
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.workspace-deps",
      packageCount: packages.length,
      edgeCount: edges.length,
      packages: packages.map(p => ({
        name: p.name,
        version: p.version,
        dir: p.dir,
        workspaceDeps: edges.filter(e => e.from === p.name).map(e => e.to),
      })),
    });
    return;
  }

  if (values.dot) {
    printText(`digraph workspace {`);
    printText(`  rankdir=LR;`);
    printText(`  node [shape=box, style=filled, fillcolor=lightblue];`);
    for (const pkg of packages) {
      printText(`  "${pkg.name}";`);
    }
    for (const e of edges) {
      printText(`  "${e.from}" -> "${e.to}";`);
    }
    printText(`}`);
    return;
  }

  printText(`  Workspace packages: \x1b[1m${packages.length}\x1b[0m  |  Cross-package deps: \x1b[1m${edges.length}\x1b[0m\n`);

  for (const pkg of packages) {
    const outgoing = edges.filter(e => e.from === pkg.name).map(e => e.to);
    const incoming = edges.filter(e => e.to === pkg.name).map(e => e.from);
    printText(`  \x1b[1m${pkg.name}\x1b[0m@${pkg.version}  \x1b[90m(${pkg.dir})\x1b[0m`);
    if (outgoing.length > 0) {
      printText(`    \x1b[90m→ depends on: ${outgoing.join(", ")}\x1b[0m`);
    }
    if (incoming.length > 0) {
      printText(`    \x1b[90m← depended by: ${incoming.join(", ")}\x1b[0m`);
    }
  }

  if (edges.length === 0) {
    printText(`\n  \x1b[90mNo cross-workspace dependencies found.\x1b[0m`);
  }
  printText("");
}
