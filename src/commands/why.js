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
 * Parse pnpm-lock.yaml to build full dependency graph.
 *
 * Supports lockfileVersion 5.x / 6.x / 9.x.
 *
 * The `packages` section is keyed by `/{name}@{version}` (v5/v6) or
 * `{name}@{version}` (v9). Each entry may have a `dependencies` and/or
 * `optionalDependencies` map of `name: version`.
 *
 * We build the same adjacency graph used by the npm lock parser so
 * `findAllPaths` and `findReverseDeps` work identically.
 */
function parsePnpmLock(yamlContent) {
  const graph = new Map();
  const lines = yamlContent.split("\n");

  // ── Phase 1: collect root deps & parse packages section ──────────

  let section = null;        // current top-level section name
  let currentPkgKey = null;  // e.g. "/express@4.18.2" or "express@4.18.2"
  let inPkgDeps = false;     // inside a package's dependencies / optionalDependencies
  let indent = 0;            // indentation of the current package key line

  const rootDeps = {};
  // Temporary store: pkgKey -> { version, deps: {name: version} }
  const packagesRaw = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect top-level sections (no leading whitespace)
    if (/^\S/.test(line)) {
      if (/^dependencies:/.test(line)) { section = "dependencies"; }
      else if (/^devDependencies:/.test(line)) { section = "devDependencies"; }
      else if (/^optionalDependencies:/.test(line)) { section = "optionalDependencies"; }
      else if (/^packages:/.test(line)) { section = "packages"; }
      else { section = null; }
      currentPkgKey = null;
      inPkgDeps = false;
      continue;
    }

    // ── Root dependency sections ──────────────────────────────────
    if (section === "dependencies" || section === "devDependencies" || section === "optionalDependencies") {
      // v6/v9 nested format:  "  express:\n    specifier: ^4\n    version: 4.18.2"
      // v5 flat format:       "  express: 4.18.2"
      const depMatch = line.match(/^  ['"]?([^'":]+)['"]?:\s*(.+)?/);
      if (depMatch) {
        const name = depMatch[1].trim();
        const value = (depMatch[2] || "").trim();
        if (value && !value.startsWith("{")) {
          rootDeps[name] = value;
        }
      }
      // Nested specifier/version lines (v6+)
      const versionMatch = line.match(/^\s+version:\s*['"]?([^'"]+)['"]?/);
      if (versionMatch) {
        // We need to associate this with the last dep name we saw
        const prevMatch = lines[i - 1] && lines[i - 1].match(/^  ['"]?([^'":]+)['"]?:/);
        // Check if the previous non-version line was the dep name
        if (!prevMatch) {
          // Could be specifier in between; search upward
          for (let j = i - 1; j >= 0; j--) {
            if (/^\s+specifier:/.test(lines[j])) continue;
            const nm = lines[j].match(/^  ['"]?([^'":]+)['"]?:/);
            if (nm) { rootDeps[nm[1].trim()] = versionMatch[1]; break; }
            break;
          }
        } else {
          rootDeps[prevMatch[1].trim()] = versionMatch[1];
        }
      }
      continue;
    }

    // ── Packages section ──────────────────────────────────────────
    if (section === "packages") {
      // Package key lines — v5/v6: "  /express@4.18.2:" or v9: "  express@4.18.2:"
      // Also handle quoted keys: "  '/express@4.18.2':" or "  'express@4.18.2(peer):"
      const pkgKeyMatch = line.match(/^  ['"]?\/?([^'":][^'":]*?)['"]?:\s*$/);
      if (pkgKeyMatch) {
        currentPkgKey = pkgKeyMatch[1]; // e.g. "express@4.18.2"
        inPkgDeps = false;
        indent = 2;
        if (!packagesRaw.has(currentPkgKey)) {
          packagesRaw.set(currentPkgKey, { version: null, deps: {} });
        }
        continue;
      }

      if (!currentPkgKey) continue;
      const pkg = packagesRaw.get(currentPkgKey);

      // Version line:  "    version: 4.18.2"
      const verMatch = line.match(/^\s{4,}version:\s*['"]?([^'"]+)['"]?/);
      if (verMatch) {
        pkg.version = verMatch[1];
        inPkgDeps = false;
        continue;
      }

      // dependencies: / optionalDependencies: sub-section
      if (/^\s{4}dependencies:\s*$/.test(line) || /^\s{4}optionalDependencies:\s*$/.test(line)) {
        inPkgDeps = true;
        continue;
      }

      // Another 4-space key resets inPkgDeps (e.g. "    resolution:", "    engines:")
      if (/^\s{4}\S/.test(line) && !/^\s{6}/.test(line) && inPkgDeps) {
        inPkgDeps = false;
      }

      // Dependency entries:  "      accepts: 1.3.8"
      if (inPkgDeps) {
        const depEntry = line.match(/^\s{6,}['"]?([^'":]+)['"]?:\s*['"]?([^'"]+)['"]?/);
        if (depEntry) {
          pkg.deps[depEntry[1].trim()] = depEntry[2].trim();
        }
      }
    }
  }

  // ── Phase 2: build graph ─────────────────────────────────────────

  graph.set("__ROOT__", { deps: rootDeps, version: "0.0.0" });

  for (const [pkgKey, pkgData] of packagesRaw) {
    // pkgKey is like "express@4.18.2" or "@babel/core@7.20.0"
    // Extract name: everything up to the last '@'
    const atIdx = pkgKey.lastIndexOf("@");
    if (atIdx <= 0) continue; // malformed
    const name = pkgKey.slice(0, atIdx);
    const version = pkgData.version || pkgKey.slice(atIdx + 1);

    // Remap deps from {name: exactVersion} to simple name refs
    // so that findAllPaths (which walks by package name) works
    const deps = {};
    for (const [depName, depVer] of Object.entries(pkgData.deps)) {
      deps[depName] = depVer;
    }

    if (!graph.has(name)) {
      graph.set(name, { deps, version });
    }
  }

  return graph;
}

/**
 * Parse yarn.lock (v1 classic and v2+ berry) to build full dependency graph.
 *
 * yarn.lock v1 format:
 *   "lodash@^4.17.0":
 *     version "4.17.21"
 *     resolved "…"
 *     dependencies:
 *       some-dep "^1.0.0"
 *
 * yarn.lock v2/berry format (YAML-ish):
 *   "lodash@npm:^4.17.0":
 *     version: 4.17.21
 *     resolution: "…"
 *     dependencies:
 *       some-dep: "npm:^1.0.0"
 *
 * We parse both formats into the same graph structure.
 */
function parseYarnLock(lockContent) {
  const graph = new Map();
  const lines = lockContent.split("\n");

  const isBerry = lines.some(l => /^__metadata:/.test(l));

  // Temporary store: name -> { version, deps }
  // Multiple resolution entries may exist; we keep the first version per name.
  const packagesRaw = new Map();

  let currentNames = [];   // package names from the header line
  let currentVersion = null;
  let currentDeps = {};
  let inDeps = false;

  function flush() {
    if (currentNames.length > 0 && currentVersion) {
      for (const name of currentNames) {
        if (!packagesRaw.has(name)) {
          packagesRaw.set(name, { version: currentVersion, deps: { ...currentDeps } });
        }
      }
    }
    currentNames = [];
    currentVersion = null;
    currentDeps = {};
    inDeps = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comments and empty lines
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    // Skip __metadata block
    if (/^__metadata:/.test(line)) { flush(); continue; }

    // ── Header line (no leading whitespace, or quoted) ──────────
    // v1: "lodash@^4.17.0", "lodash@^4.17.0, lodash@^4.17.21":
    // v2: "lodash@npm:^4.17.0":
    if (/^[^\s]/.test(line) || /^"/.test(line)) {
      flush();

      // Strip trailing colon
      let header = line.replace(/:\s*$/, "").trim();
      // Remove surrounding quotes
      header = header.replace(/^"(.*)"$/, "$1");

      // Split comma-separated entries
      const entries = header.split(/,\s*/);
      const names = new Set();
      for (const entry of entries) {
        let cleaned = entry.replace(/^"(.*)"$/, "$1").trim();
        // Remove npm: protocol prefix for berry: "lodash@npm:^4.17.0" -> "lodash@^4.17.0"
        cleaned = cleaned.replace(/@npm:/, "@");
        // Extract package name (everything before the last @, excluding scoped prefix)
        const atIdx = cleaned.lastIndexOf("@");
        if (atIdx > 0) {
          names.add(cleaned.slice(0, atIdx));
        } else if (atIdx === -1 && cleaned.length > 0) {
          names.add(cleaned);
        }
      }
      currentNames = [...names];
      continue;
    }

    // ── Indented lines (package properties) ──────────────────────
    if (currentNames.length === 0) continue;

    // version line
    // v1: '  version "4.17.21"'
    // v2: '  version: 4.17.21' or '  version: "4.17.21"'
    const verMatch = line.match(/^\s+version[:\s]+["']?([^"'\s]+)["']?/);
    if (verMatch) {
      currentVersion = verMatch[1];
      inDeps = false;
      continue;
    }

    // dependencies / optionalDependencies header
    if (/^\s+dependencies:\s*$/.test(line) || /^\s+optionalDependencies:\s*$/.test(line)) {
      inDeps = true;
      continue;
    }

    // Any other non-dep section header resets inDeps
    if (/^\s{2}\S/.test(line) && !/^\s{4}/.test(line) && inDeps) {
      inDeps = false;
      continue;
    }

    // Dependency entries
    if (inDeps) {
      // v1: '    some-dep "^1.0.0"'
      const v1Dep = line.match(/^\s{4,}["']?([^"'\s]+)["']?\s+["']([^"']+)["']/);
      if (v1Dep) {
        currentDeps[v1Dep[1]] = v1Dep[2];
        continue;
      }
      // v2: '    some-dep: "npm:^1.0.0"' or '    some-dep: ^1.0.0'
      const v2Dep = line.match(/^\s{4,}["']?([^"':\s]+)["']?:\s*["']?([^"'\s]+)["']?/);
      if (v2Dep) {
        currentDeps[v2Dep[1]] = v2Dep[2].replace(/^npm:/, "");
        continue;
      }
    }
  }
  flush();

  // ── Build graph ──────────────────────────────────────────────────

  // Root deps come from the fact that every top-level yarn.lock entry that
  // is referenced in package.json is a direct dep. Since we don't have
  // package.json here, we mark all packages that appear at the top level
  // as potential deps and let the caller's "isDirect" check handle it via
  // the root node's deps map.
  const rootDeps = {};
  for (const [name, data] of packagesRaw) {
    rootDeps[name] = data.version;
    if (!graph.has(name)) {
      graph.set(name, { deps: data.deps, version: data.version });
    }
  }

  graph.set("__ROOT__", { deps: rootDeps, version: "0.0.0" });

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
