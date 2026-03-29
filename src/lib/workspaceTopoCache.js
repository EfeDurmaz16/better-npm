/**
 * Workspace topology cache (#27).
 *
 * Persists the computed workspace DAG (packages, deps, build order) between
 * runs so `better workspace` and the topological install planner avoid
 * re-scanning on every invocation.
 *
 * Invalidation: any package.json in the workspace that changes mtime
 * causes the cache to be considered stale.
 *
 * Cache location:
 *   ~/.better/workspace-topo/<root-hash>.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const CACHE_VERSION = 1;

/**
 * Compute a cache key for a workspace root.
 * @param {string} root
 * @returns {string}
 */
function cacheKey(root) {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

/**
 * Path to the topology cache file.
 * @param {string} cacheDir  - better cache root
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function topoCachePath(cacheDir, workspaceRoot) {
  return path.join(cacheDir, "workspace-topo", `${cacheKey(workspaceRoot)}.json`);
}

/**
 * Scan a workspace and return the max mtime across all package.json files.
 *
 * @param {string[]} packageDirs  - list of workspace package directories
 * @returns {Promise<number>} max mtime in milliseconds
 */
export async function maxPackageJsonMtime(packageDirs) {
  const mtimes = await Promise.allSettled(
    packageDirs.map(async (dir) => {
      const st = await fs.stat(path.join(dir, "package.json"));
      return st.mtimeMs;
    })
  );
  return mtimes
    .filter(r => r.status === "fulfilled")
    .reduce((max, r) => Math.max(max, r.value), 0);
}

/**
 * Load a cached topology if it is still fresh.
 *
 * @param {string} cacheDir
 * @param {string} workspaceRoot
 * @param {string[]} packageDirs   - current workspace package directories
 * @returns {Promise<Object|null>} cached topo or null if stale/missing
 */
export async function loadTopoCache(cacheDir, workspaceRoot, packageDirs) {
  const cachePath = topoCachePath(cacheDir, workspaceRoot);
  let cached;
  try {
    cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch {
    return null;
  }

  if (cached.version !== CACHE_VERSION) return null;
  if (cached.workspaceRoot !== workspaceRoot) return null;
  if (cached.packageCount !== packageDirs.length) return null;

  // Staleness check: compare maxMtime
  const currentMaxMtime = await maxPackageJsonMtime(packageDirs);
  if (currentMaxMtime > cached.maxMtime) return null;

  return cached.topo;
}

/**
 * Save a topology to the cache.
 *
 * @param {string} cacheDir
 * @param {string} workspaceRoot
 * @param {string[]} packageDirs
 * @param {Object} topo           - the computed topology to cache
 */
export async function saveTopoCache(cacheDir, workspaceRoot, packageDirs, topo) {
  const cachePath = topoCachePath(cacheDir, workspaceRoot);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  const maxMtime = await maxPackageJsonMtime(packageDirs);

  const data = {
    version: CACHE_VERSION,
    savedAt: new Date().toISOString(),
    workspaceRoot,
    packageCount: packageDirs.length,
    maxMtime,
    topo
  };

  await fs.writeFile(cachePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Invalidate the topology cache for a workspace.
 * @param {string} cacheDir
 * @param {string} workspaceRoot
 */
export async function invalidateTopoCache(cacheDir, workspaceRoot) {
  const cachePath = topoCachePath(cacheDir, workspaceRoot);
  await fs.rm(cachePath, { force: true });
}

/**
 * Build a workspace topology (DAG) from a list of workspace packages.
 *
 * Reads each package.json, builds the dependency graph between workspace
 * packages, and returns a topological sort.
 *
 * @param {Array<{ name: string, dir: string }>} wsPackages
 * @returns {Promise<{
 *   packages: Array<{ name: string, dir: string, deps: string[] }>,
 *   order: string[],     // topological order (build order)
 *   levels: string[][]  // parallel build levels
 * }>}
 */
export async function buildTopoGraph(wsPackages) {
  // Read each package.json
  const nodes = await Promise.allSettled(
    wsPackages.map(async ({ name, dir }) => {
      let pkg;
      try {
        pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
      } catch {
        pkg = {};
      }
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies
      };
      return { name: pkg.name ?? name, dir, allDeps };
    })
  );

  const pkgMap = new Map(); // name → node
  for (const r of nodes) {
    if (r.status === "fulfilled") pkgMap.set(r.value.name, r.value);
  }

  const wsNames = new Set(pkgMap.keys());

  // Build adjacency: name → Set<dep names> (only workspace deps)
  const edges = new Map();
  for (const [name, node] of pkgMap) {
    const wsDeps = Object.keys(node.allDeps ?? {}).filter(d => wsNames.has(d));
    edges.set(name, new Set(wsDeps));
  }

  // Kahn's algorithm for topological sort
  const inDegree = new Map([...pkgMap.keys()].map(n => [n, 0]));
  for (const [, deps] of edges) {
    for (const dep of deps) {
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
    }
  }

  const levels = [];
  let queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);

  while (queue.length > 0) {
    levels.push(queue);
    const nextQueue = [];
    for (const name of queue) {
      for (const [other, deps] of edges) {
        if (deps.has(name)) {
          const newDeg = (inDegree.get(other) ?? 0) - 1;
          inDegree.set(other, newDeg);
          if (newDeg === 0) nextQueue.push(other);
        }
      }
    }
    queue = nextQueue;
  }

  const order = levels.flat();
  const packages = [...pkgMap.values()].map(({ name, dir, allDeps }) => ({
    name,
    dir,
    deps: Object.keys(allDeps ?? {}).filter(d => wsNames.has(d))
  }));

  return { packages, order, levels };
}
