// src/parity/packageSetHash.js
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Recursively find all package.json files in node_modules
 * @param {string} nodeModulesPath
 * @returns {Promise<string[]>} array of package.json paths
 */
async function findPackageJsons(nodeModulesPath) {
  const results = [];

  async function walk(dir, depth = 0) {
    if (depth > 20) return; // Prevent infinite recursion

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          // Nested node_modules - recurse
          await walk(fullPath, depth + 1);
        } else if (entry.name.startsWith("@")) {
          // Scoped package directory
          await walk(fullPath, depth);
        } else {
          // Regular package directory - check for package.json
          const pkgPath = path.join(fullPath, "package.json");
          try {
            await fs.access(pkgPath);
            results.push(pkgPath);
          } catch {
            // No package.json
          }
          // Also check for nested node_modules
          const nested = path.join(fullPath, "node_modules");
          try {
            await fs.access(nested);
            await walk(nested, depth + 1);
          } catch {
            // No nested node_modules
          }
        }
      }
    }
  }

  await walk(nodeModulesPath);
  return results;
}

/**
 * Build a set of name@version from node_modules
 * @param {string} nodeModulesPath
 * @returns {Promise<Set<string>>} set of "name@version" strings
 */
export async function buildPackageSet(nodeModulesPath) {
  const pkgJsonPaths = await findPackageJsons(nodeModulesPath);
  const packageSet = new Set();

  for (const pkgPath of pkgJsonPaths) {
    try {
      const content = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(content);
      if (pkg.name && pkg.version) {
        packageSet.add(`${pkg.name}@${pkg.version}`);
      }
    } catch {
      // Skip invalid package.json
    }
  }

  return packageSet;
}

/**
 * Compute deterministic hash of package set
 * @param {Set<string>} packageSet
 * @returns {string} SHA256 hash
 */
export function hashPackageSet(packageSet) {
  const sorted = Array.from(packageSet).sort();
  const content = sorted.join("\n");
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Compare two package sets and return differences
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {Object} comparison result
 */
export function comparePackageSets(setA, setB) {
  const onlyInA = [];
  const onlyInB = [];

  for (const pkg of setA) {
    if (!setB.has(pkg)) {
      onlyInA.push(pkg);
    }
  }

  for (const pkg of setB) {
    if (!setA.has(pkg)) {
      onlyInB.push(pkg);
    }
  }

  return {
    match: onlyInA.length === 0 && onlyInB.length === 0,
    onlyInA: onlyInA.sort(),
    onlyInB: onlyInB.sort(),
    sizeA: setA.size,
    sizeB: setB.size
  };
}
