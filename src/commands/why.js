import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { printJson, printText, toErrorJson } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const HELP = `
Usage: better why <package> [options]

Shows WHY a package is installed by tracing dependency paths.

Arguments:
  <package>              Package name to trace

Options:
  --json                 Output JSON instead of text
  --project-root PATH    Override project root directory
  -h, --help            Show this help message

Examples:
  better why lodash
  better why express --json
  better why webpack --project-root /path/to/project
`.trim();

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw);
}

/**
 * Parse package-lock.json (v2/v3 format) to build dependency graph
 */
function parsePkgLock(lockData) {
  const graph = new Map();
  const packages = lockData.packages || {};

  // Root package
  const rootPkg = packages[""];
  if (rootPkg) {
    const rootDeps = {
      ...rootPkg.dependencies,
      ...rootPkg.devDependencies,
      ...rootPkg.optionalDependencies
    };
    graph.set("__ROOT__", { deps: rootDeps || {}, version: rootPkg.version || "0.0.0" });
  }

  // All other packages
  for (const [pkgPath, pkgData] of Object.entries(packages)) {
    if (pkgPath === "") continue;

    // Extract package name from path like "node_modules/lodash" or "node_modules/@babel/core"
    const name = pkgPath.startsWith("node_modules/")
      ? pkgPath.slice("node_modules/".length).split("/node_modules/").pop()
      : pkgPath;

    const deps = {
      ...pkgData.dependencies,
      ...pkgData.devDependencies,
      ...pkgData.optionalDependencies
    };

    if (!graph.has(name)) {
      graph.set(name, { deps: deps || {}, version: pkgData.version || "unknown" });
    }
  }

  return graph;
}

/**
 * Parse pnpm-lock.yaml (basic support)
 */
function parsePnpmLock(yamlContent) {
  const graph = new Map();
  const lines = yamlContent.split("\n");

  let inDependencies = false;
  let inPackages = false;
  const rootDeps = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Root dependencies section
    if (line.match(/^dependencies:/)) {
      inDependencies = true;
      inPackages = false;
      continue;
    }

    if (line.match(/^devDependencies:/)) {
      inDependencies = true;
      inPackages = false;
      continue;
    }

    if (line.match(/^packages:/)) {
      inPackages = true;
      inDependencies = false;
      continue;
    }

    // Parse root dependencies
    if (inDependencies && line.match(/^  \w/)) {
      const match = line.match(/^  ([^:]+):\s*(.+)/);
      if (match) {
        rootDeps[match[1]] = match[2];
      }
    }

    // Reset on new top-level section
    if (line.match(/^\w/) && !line.match(/^(dependencies|devDependencies|packages):/)) {
      inDependencies = false;
      inPackages = false;
    }
  }

  graph.set("__ROOT__", { deps: rootDeps, version: "0.0.0" });

  // Basic package parsing - this is simplified
  // Real pnpm parsing would need a proper YAML parser
  return graph;
}

/**
 * Parse yarn.lock (basic support)
 */
function parseYarnLock(lockContent) {
  const graph = new Map();
  const lines = lockContent.split("\n");

  // Yarn lock doesn't have full dependency tree, so we return minimal graph
  // To properly support this, we'd need to read package.json as well
  graph.set("__ROOT__", { deps: {}, version: "0.0.0" });

  return graph;
}

/**
 * Find all paths from root to target package using DFS
 */
function findAllPaths(graph, targetPkg) {
  const paths = [];

  function dfs(currentPkg, currentPath, visited) {
    if (currentPath.length > 100) return; // Prevent infinite loops

    if (visited.has(currentPkg)) return; // Prevent cycles

    if (currentPkg === targetPkg && currentPath.length > 1) {
      paths.push([...currentPath]);
      return;
    }

    const node = graph.get(currentPkg);
    if (!node) return;

    const newVisited = new Set(visited);
    newVisited.add(currentPkg);

    for (const [depName, range] of Object.entries(node.deps)) {
      const nextPath = [...currentPath, depName];
      dfs(depName, nextPath, newVisited);
    }
  }

  dfs("__ROOT__", ["__ROOT__"], new Set());

  return paths.map(p => p.slice(1)); // Remove __ROOT__ from display
}

/**
 * Find all packages that directly depend on the target
 */
function findReverseDeps(graph, targetPkg) {
  const reverseDeps = [];

  for (const [pkgName, pkgData] of graph.entries()) {
    if (pkgName === "__ROOT__" || pkgName === targetPkg) continue;

    if (pkgData.deps[targetPkg]) {
      reverseDeps.push({
        name: pkgName,
        version: pkgData.version,
        range: pkgData.deps[targetPkg]
      });
    }
  }

  return reverseDeps;
}

/**
 * Format dependency paths as a tree
 */
function formatPathsAsTree(paths, targetPkg, version) {
  if (paths.length === 0) {
    return `Package "${targetPkg}" not found in dependency tree`;
  }

  const lines = [];
  lines.push(`${targetPkg}@${version}`);

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const isLast = i === paths.length - 1;

    lines.push("");
    lines.push(`Path ${i + 1}:`);

    for (let j = 0; j < path.length; j++) {
      const pkg = path[j];
      const isLastInPath = j === path.length - 1;
      const prefix = "  ".repeat(j);
      const connector = isLastInPath ? "└─" : "├─";
      lines.push(`${prefix}${connector} ${pkg}`);
    }
  }

  return lines.join("\n");
}

export async function cmdWhy(argv) {
  const log = childLogger({ cmd: "why" });

  try {
    const args = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h", default: false },
        json: { type: "boolean", default: false },
        "project-root": { type: "string" }
      },
      allowPositionals: true,
      strict: true
    });

    if (args.values.help) {
      printText(HELP);
      return;
    }

    const config = getRuntimeConfig();
    const useJson = args.values.json || config.json;

    // Get package name from positional args
    if (args.positionals.length === 0) {
      const err = new Error("Missing required argument: <package>");
      if (useJson) {
        printJson(toErrorJson(err));
      } else {
        printText(`Error: ${err.message}\n\n${HELP}`);
      }
      process.exitCode = 1;
      return;
    }

    const targetPkg = args.positionals[0];

    // Determine project root
    let projectRoot;
    if (args.values["project-root"]) {
      projectRoot = path.resolve(args.values["project-root"]);
    } else {
      const resolved = await resolveInstallProjectRoot(process.cwd());
      projectRoot = resolved.root;
      log.debug("Resolved project root", { root: projectRoot, reason: resolved.reason });
    }

    // Try to find and parse lockfile
    let graph = null;
    let lockfileType = null;

    // Try package-lock.json first
    const pkgLockPath = path.join(projectRoot, "package-lock.json");
    if (await exists(pkgLockPath)) {
      const lockData = await readJson(pkgLockPath);
      graph = parsePkgLock(lockData);
      lockfileType = "package-lock.json";
      log.debug("Parsed package-lock.json", { packages: graph.size });
    }

    // Try pnpm-lock.yaml
    if (!graph) {
      const pnpmLockPath = path.join(projectRoot, "pnpm-lock.yaml");
      if (await exists(pnpmLockPath)) {
        const yamlContent = await fs.readFile(pnpmLockPath, "utf8");
        graph = parsePnpmLock(yamlContent);
        lockfileType = "pnpm-lock.yaml";
        log.debug("Parsed pnpm-lock.yaml", { packages: graph.size });
      }
    }

    // Try yarn.lock
    if (!graph) {
      const yarnLockPath = path.join(projectRoot, "yarn.lock");
      if (await exists(yarnLockPath)) {
        const lockContent = await fs.readFile(yarnLockPath, "utf8");
        graph = parseYarnLock(lockContent);
        lockfileType = "yarn.lock";
        log.debug("Parsed yarn.lock", { packages: graph.size });
      }
    }

    if (!graph) {
      const err = new Error("No lockfile found (package-lock.json, pnpm-lock.yaml, or yarn.lock)");
      if (useJson) {
        printJson(toErrorJson(err));
      } else {
        printText(`Error: ${err.message}`);
      }
      process.exitCode = 1;
      return;
    }

    // Check if package exists in graph
    const targetNode = graph.get(targetPkg);
    if (!targetNode) {
      const err = new Error(`Package "${targetPkg}" not found in dependency tree`);
      if (useJson) {
        printJson({
          ok: false,
          kind: "better.why",
          schemaVersion: 1,
          package: targetPkg,
          error: err.message
        });
      } else {
        printText(`Error: ${err.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const version = targetNode.version;

    // Check if it's a direct dependency
    const rootNode = graph.get("__ROOT__");
    const isDirect = rootNode && rootNode.deps[targetPkg] != null;

    // Find all dependency paths
    const dependencyPaths = findAllPaths(graph, targetPkg);

    // Find reverse dependencies
    const dependedOnBy = findReverseDeps(graph, targetPkg);

    if (useJson) {
      printJson({
        ok: true,
        kind: "better.why",
        schemaVersion: 1,
        package: targetPkg,
        version,
        isDirect,
        dependencyPaths,
        dependedOnBy,
        totalPaths: dependencyPaths.length
      });
    } else {
      const tree = formatPathsAsTree(dependencyPaths, targetPkg, version);
      printText(tree);

      if (isDirect) {
        printText("\nThis is a DIRECT dependency.");
      } else {
        printText("\nThis is a TRANSITIVE dependency.");
      }

      if (dependedOnBy.length > 0) {
        printText(`\nDepended on by ${dependedOnBy.length} package(s):`);
        for (const dep of dependedOnBy) {
          printText(`  - ${dep.name}@${dep.version} (requires ${dep.range})`);
        }
      }
    }

  } catch (err) {
    log.error("Command failed", { error: err.message });
    const config = getRuntimeConfig();
    if (config.json) {
      printJson(toErrorJson(err));
    } else {
      printText(`Error: ${err.message}`);
    }
    process.exitCode = 1;
  }
}
