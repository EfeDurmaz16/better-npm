/**
 * Bundle size impact tracking (#20).
 *
 * Computes installed size (disk footprint) of packages in node_modules:
 *   - own size: bytes belonging directly to the package directory
 *   - subtree size: own + all unique transitive dependencies
 *   - % of total node_modules
 *
 * This is disk footprint (not webpack bundle size), but serves as a
 * good proxy for dependency weight and is computable without bundling.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Walk a directory and sum file sizes.
 * Returns { bytes, files }.
 */
export async function dirSize(dirPath) {
  let bytes = 0;
  let files = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) return; // don't follow symlinks
      if (entry.isDirectory()) {
        const sub = await dirSize(full);
        bytes += sub.bytes;
        files += sub.files;
      } else if (entry.isFile()) {
        try {
          const st = await fs.stat(full);
          bytes += st.size;
          files++;
        } catch { /* ignore */ }
      }
    }));
  } catch { /* ignore */ }
  return { bytes, files };
}

/**
 * Compute the installed size of a single package in node_modules.
 *
 * @param {string} nodeModulesDir  - path to node_modules
 * @param {string} packageName     - e.g. "lodash" or "@scope/pkg"
 * @returns {Promise<{ bytes: number, files: number } | null>}
 */
export async function packageSize(nodeModulesDir, packageName) {
  const pkgDir = path.join(nodeModulesDir, ...packageName.split("/"));
  try {
    await fs.access(pkgDir);
    return dirSize(pkgDir);
  } catch {
    return null;
  }
}

/**
 * Read a package's direct dependencies from its package.json.
 *
 * @param {string} nodeModulesDir
 * @param {string} packageName
 * @returns {Promise<string[]>}
 */
export async function packageDeps(nodeModulesDir, packageName) {
  const pkgJsonPath = path.join(nodeModulesDir, ...packageName.split("/"), "package.json");
  try {
    const raw = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
    return Object.keys(raw?.dependencies ?? {});
  } catch {
    return [];
  }
}

/**
 * Compute subtree size for a package (own + unique transitive deps).
 * Uses BFS; avoids double-counting shared deps.
 *
 * @param {string} nodeModulesDir
 * @param {string} rootPackage
 * @param {Map<string, number>} [sizeCache] - optional shared cache
 * @returns {Promise<{ subtreeBytes: number, ownBytes: number, depCount: number }>}
 */
export async function subtreeSize(nodeModulesDir, rootPackage, sizeCache = new Map()) {
  const visited = new Set();
  const queue = [rootPackage];
  let subtreeBytes = 0;
  let ownBytes = 0;
  let depCount = 0;

  while (queue.length > 0) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);

    let bytes = sizeCache.get(name);
    if (bytes == null) {
      const sz = await packageSize(nodeModulesDir, name);
      bytes = sz?.bytes ?? 0;
      sizeCache.set(name, bytes);
    }

    if (name === rootPackage) {
      ownBytes = bytes;
    } else {
      depCount++;
    }
    subtreeBytes += bytes;

    const deps = await packageDeps(nodeModulesDir, name);
    for (const dep of deps) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  return { subtreeBytes, ownBytes, depCount };
}

/**
 * Compute size stats for a list of packages.
 *
 * @param {string} nodeModulesDir
 * @param {string[]} packageNames
 * @returns {Promise<Array<{ name, ownBytes, subtreeBytes, depCount }>>}
 */
export async function sizeReport(nodeModulesDir, packageNames) {
  const sizeCache = new Map();
  const results = await Promise.allSettled(
    packageNames.map(async (name) => {
      const { subtreeBytes, ownBytes, depCount } = await subtreeSize(nodeModulesDir, name, sizeCache);
      return { name, ownBytes, subtreeBytes, depCount };
    })
  );

  return results
    .filter(r => r.status === "fulfilled")
    .map(r => r.value)
    .sort((a, b) => b.subtreeBytes - a.subtreeBytes);
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
