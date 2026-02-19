import fs from "node:fs/promises";
import path from "node:path";

/**
 * Read overrides/resolutions from package.json.
 * Supports npm overrides, yarn resolutions, and pnpm overrides.
 *
 * @param {string} projectRoot
 * @returns {{ ok: boolean, overrides: Object, format: string, count: number }}
 */
export async function loadOverrides(projectRoot) {
  let pkg;
  try {
    const raw = await fs.readFile(path.join(projectRoot, "package.json"), "utf8");
    pkg = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "no_package_json", overrides: {}, format: null, count: 0 };
  }

  // npm overrides (package.json "overrides" field)
  if (pkg.overrides && typeof pkg.overrides === "object") {
    const flat = flattenOverrides(pkg.overrides);
    return { ok: true, overrides: pkg.overrides, flat, format: "npm", count: flat.length };
  }

  // yarn resolutions (package.json "resolutions" field)
  if (pkg.resolutions && typeof pkg.resolutions === "object") {
    const flat = Object.entries(pkg.resolutions).map(([pattern, version]) => ({
      pattern,
      version,
      source: "resolutions"
    }));
    return { ok: true, overrides: pkg.resolutions, flat, format: "yarn", count: flat.length };
  }

  // pnpm overrides (package.json "pnpm.overrides" field)
  if (pkg.pnpm?.overrides && typeof pkg.pnpm.overrides === "object") {
    const flat = Object.entries(pkg.pnpm.overrides).map(([pattern, version]) => ({
      pattern,
      version,
      source: "pnpm.overrides"
    }));
    return { ok: true, overrides: pkg.pnpm.overrides, flat, format: "pnpm", count: flat.length };
  }

  return { ok: true, overrides: {}, flat: [], format: null, count: 0 };
}

/**
 * Flatten npm-style nested overrides into a list of { pattern, version } entries.
 */
function flattenOverrides(overrides, parentPath = "") {
  const result = [];
  for (const [key, value] of Object.entries(overrides)) {
    const currentPath = parentPath ? `${parentPath} > ${key}` : key;
    if (typeof value === "string") {
      result.push({ pattern: currentPath, version: value, source: "overrides" });
    } else if (typeof value === "object" && value !== null) {
      // npm overrides can have a "." key for the direct version
      if (typeof value["."] === "string") {
        result.push({ pattern: currentPath, version: value["."], source: "overrides" });
      }
      // Recurse for nested overrides
      const nested = flattenOverrides(value, currentPath);
      result.push(...nested.filter(n => n.pattern !== currentPath));
    }
  }
  return result;
}

/**
 * Validate overrides against actual lockfile packages.
 * Checks that override targets exist and versions match.
 *
 * @param {Object[]} flatOverrides - from loadOverrides().flat
 * @param {Object} lockPackages - packages from package-lock.json
 * @returns {{ valid: Object[], warnings: Object[] }}
 */
export function validateOverrides(flatOverrides, lockPackages) {
  const valid = [];
  const warnings = [];

  for (const override of flatOverrides) {
    // Extract the package name from the pattern
    const pkgName = extractPackageName(override.pattern);
    if (!pkgName) {
      warnings.push({
        ...override,
        issue: "unparseable_pattern",
        message: `Cannot parse override pattern: ${override.pattern}`
      });
      continue;
    }

    // Check if the package exists in the lockfile
    const lockKey = `node_modules/${pkgName}`;
    const lockEntry = lockPackages?.[lockKey];

    if (!lockEntry) {
      warnings.push({
        ...override,
        package: pkgName,
        issue: "package_not_in_lockfile",
        message: `Override target '${pkgName}' not found in lockfile`
      });
      continue;
    }

    // Check if the version matches the override
    const actualVersion = lockEntry.version;
    const overrideVersion = override.version.replace(/^\^|~|>=|<=|>|<|=/, "");

    if (actualVersion === overrideVersion) {
      valid.push({
        ...override,
        package: pkgName,
        actualVersion,
        status: "applied"
      });
    } else {
      warnings.push({
        ...override,
        package: pkgName,
        actualVersion,
        issue: "version_mismatch",
        message: `Override specifies '${override.version}' but lockfile has '${actualVersion}'`
      });
    }
  }

  return { valid, warnings };
}

/**
 * Extract the base package name from an override pattern.
 * Handles patterns like "lodash", "@scope/pkg", "express > lodash"
 */
function extractPackageName(pattern) {
  // For nested patterns like "express > lodash", take the last segment
  const parts = pattern.split(">").map(s => s.trim());
  const last = parts[parts.length - 1];
  if (!last) return null;

  // Handle scoped packages
  if (last.startsWith("@") && last.includes("/")) return last;
  // Handle simple package names
  if (/^[a-z0-9@][a-z0-9._-]*$/i.test(last)) return last;
  return null;
}

/**
 * Suggest overrides for vulnerable packages found by audit.
 *
 * @param {Object[]} vulnNodes - vulnerability graph nodes
 * @param {string} format - "npm" | "yarn" | "pnpm"
 * @returns {Object} - suggested overrides object to add to package.json
 */
export function suggestOverridesForVulns(vulnNodes, format = "npm") {
  const suggestions = {};

  for (const node of vulnNodes) {
    if (!node.name || !node.vulns) continue;

    for (const vuln of node.vulns) {
      const fixedVersions = (vuln.ranges ?? [])
        .filter(r => r.fixed)
        .map(r => r.fixed);

      if (fixedVersions.length === 0) continue;

      // Use the highest fixed version
      const fixVersion = fixedVersions.sort(compareSemver).pop();
      if (!fixVersion) continue;

      if (format === "yarn" || format === "pnpm") {
        suggestions[`${node.name}`] = fixVersion;
      } else {
        suggestions[node.name] = fixVersion;
      }
    }
  }

  return suggestions;
}

/**
 * Basic semver comparison for sorting.
 */
function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}
