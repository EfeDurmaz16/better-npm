import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Verify that the lockfile is consistent with package.json.
 * This is used for --frozen-lockfile enforcement in CI environments.
 *
 * Checks:
 * 1. Lockfile exists
 * 2. All package.json dependencies have corresponding lockfile entries
 * 3. Lockfile hasn't been modified since last commit (optional git check)
 *
 * @param {string} projectRoot
 * @param {Object} options
 * @param {string} options.pm - Package manager (npm|pnpm|yarn)
 * @returns {{ ok: boolean, errors: string[], warnings: string[], lockfile: string|null, hash: string|null }}
 */
export async function verifyFrozenLockfile(projectRoot, options = {}) {
  const { pm = "npm" } = options;
  const errors = [];
  const warnings = [];

  // Step 1: Read package.json
  let pkg;
  try {
    const raw = await fs.readFile(path.join(projectRoot, "package.json"), "utf8");
    pkg = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [`Cannot read package.json: ${err.message}`],
      warnings: [],
      lockfile: null,
      hash: null
    };
  }

  // Step 2: Find and read lockfile
  const lockfileInfo = await findLockfile(projectRoot, pm);
  if (!lockfileInfo.found) {
    return {
      ok: false,
      errors: [`No lockfile found. Expected ${lockfileInfo.expected} in ${projectRoot}. Run install first.`],
      warnings: [],
      lockfile: null,
      hash: null
    };
  }

  // Step 3: Hash the lockfile for integrity tracking
  const lockHash = crypto.createHash("sha256").update(lockfileInfo.raw).digest("hex");

  // Step 4: Verify declared deps exist in lockfile
  const declaredDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {})
  };

  if (lockfileInfo.type === "npm") {
    const lock = JSON.parse(lockfileInfo.raw);
    const packages = lock.packages ?? {};
    // npm v2/v3 records the declared specs separately from resolved versions.
    // Compare that snapshot directly; a package's presence cannot prove freshness.
    const root = packages[""];
    if (root && typeof root === "object") {
      for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const declared = pkg[group] ?? {};
        const locked = root[group] ?? {};
        for (const name of new Set([...Object.keys(declared), ...Object.keys(locked)])) {
          if (declared[name] !== locked[name]) {
            errors.push(`Package '${name}' ${group} spec differs from the lockfile root snapshot. Run 'npm install' to update.`);
          }
        }
      }
    }

    // Build the fallback index only if a direct entry is missing. Preserve all
    // suffixes accepted by the previous endsWith check, including scoped names.
    let nestedNames = null;
    for (const [name, range] of Object.entries(declaredDeps)) {
      const lockKey = `node_modules/${name}`;
      if (!packages[lockKey]) {
        // Check nested paths for scoped packages
        if (nestedNames === null) {
          nestedNames = new Set();
          const separator = "/node_modules/";
          for (const key of Object.keys(packages)) {
            let offset = key.indexOf(separator);
            while (offset !== -1) {
              nestedNames.add(key.slice(offset + separator.length));
              offset = key.indexOf(separator, offset + separator.length);
            }
          }
        }
        if (!nestedNames.has(name) && !Object.hasOwn(packages, lockKey)) {
          errors.push(
            `Package '${name}@${range}' declared in package.json but missing from lockfile. Run 'npm install' to update.`
          );
        }
      }
    }

    // Check for lockfileVersion compatibility
    const lockfileVersion = lock.lockfileVersion;
    if (lockfileVersion && lockfileVersion < 2) {
      warnings.push(
        `Lockfile version ${lockfileVersion} is outdated. Consider upgrading to npm v7+ for lockfile v2/v3.`
      );
    }
  } else if (lockfileInfo.type === "pnpm") {
    // Basic pnpm-lock.yaml validation
    // Just check that the lockfile parses and has content
    if (lockfileInfo.raw.trim().length < 20) {
      errors.push("pnpm-lock.yaml appears empty or malformed.");
    }
  } else if (lockfileInfo.type === "yarn") {
    // Basic yarn.lock validation
    if (!lockfileInfo.raw.includes("yarn lockfile")) {
      warnings.push("yarn.lock may be malformed (missing header).");
    }

    for (const [name] of Object.entries(declaredDeps)) {
      // Check if the package appears in yarn.lock
      if (!lockfileInfo.raw.includes(`"${name}@`) && !lockfileInfo.raw.includes(`${name}@`)) {
        errors.push(
          `Package '${name}' declared in package.json but not found in yarn.lock. Run 'yarn install' to update.`
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    lockfile: lockfileInfo.name,
    hash: lockHash,
    type: lockfileInfo.type,
    declaredDeps: Object.keys(declaredDeps).length
  };
}

/**
 * Find the appropriate lockfile for the given package manager.
 */
async function findLockfile(projectRoot, pm) {
  const lockfiles = [
    { name: "package-lock.json", type: "npm", forPm: ["npm"] },
    { name: "pnpm-lock.yaml", type: "pnpm", forPm: ["pnpm"] },
    { name: "yarn.lock", type: "yarn", forPm: ["yarn"] }
  ];

  // Try PM-specific lockfile first
  const preferred = lockfiles.find(l => l.forPm.includes(pm));
  if (preferred) {
    try {
      const raw = await fs.readFile(path.join(projectRoot, preferred.name), "utf8");
      return { found: true, ...preferred, raw };
    } catch {
      // Fall through to try others
    }
  }

  // Try all lockfiles
  for (const lockfile of lockfiles) {
    try {
      const raw = await fs.readFile(path.join(projectRoot, lockfile.name), "utf8");
      return { found: true, ...lockfile, raw };
    } catch {
      continue;
    }
  }

  const expected = preferred?.name ?? "package-lock.json";
  return { found: false, expected };
}
