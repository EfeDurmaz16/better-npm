// src/parity/checker.js
import path from "node:path";
import { snapshotLockfiles, detectDrift } from "./lockfileDrift.js";
import { buildPackageSet, hashPackageSet, comparePackageSets } from "./packageSetHash.js";

/**
 * Run parity check after install
 * @param {Object} options
 * @param {string} options.projectRoot - Project root directory
 * @param {Object} options.lockfileBefore - Lockfile snapshot before install
 * @param {Set} options.packageSetBefore - Package set before install (optional)
 * @param {string} options.mode - "warn" or "strict"
 * @returns {Promise<Object>} Parity check results
 */
export async function runParityCheck(options) {
  const { projectRoot, lockfileBefore, packageSetBefore, mode = "warn" } = options;
  const nodeModulesPath = path.join(projectRoot, "node_modules");

  const result = {
    ok: true,
    mode,
    checks: {
      lockfileDrift: null,
      packageSet: null
    },
    warnings: [],
    errors: []
  };

  // Check lockfile drift
  const lockfileAfter = await snapshotLockfiles(projectRoot);
  const drift = detectDrift(lockfileBefore, lockfileAfter);
  result.checks.lockfileDrift = {
    hasDrift: drift.hasDrift,
    added: drift.added,
    removed: drift.removed,
    modified: drift.modified
  };

  if (drift.hasDrift) {
    const msg = `Lockfile drift detected: ${[
      drift.added.length ? `added ${drift.added.join(", ")}` : "",
      drift.removed.length ? `removed ${drift.removed.join(", ")}` : "",
      drift.modified.length ? `modified ${drift.modified.join(", ")}` : ""
    ].filter(Boolean).join("; ")}`;

    if (mode === "strict") {
      result.errors.push(msg);
      result.ok = false;
    } else {
      result.warnings.push(msg);
    }
  }

  // Check package set if before snapshot provided
  if (packageSetBefore) {
    const packageSetAfter = await buildPackageSet(nodeModulesPath);
    const comparison = comparePackageSets(packageSetBefore, packageSetAfter);

    result.checks.packageSet = {
      match: comparison.match,
      hashBefore: hashPackageSet(packageSetBefore),
      hashAfter: hashPackageSet(packageSetAfter),
      onlyInBefore: comparison.onlyInA,
      onlyInAfter: comparison.onlyInB,
      sizeBefore: comparison.sizeA,
      sizeAfter: comparison.sizeB
    };

    if (!comparison.match) {
      const msg = `Package set mismatch: ${comparison.onlyInA.length} removed, ${comparison.onlyInB.length} added`;
      if (mode === "strict") {
        result.errors.push(msg);
        result.ok = false;
      } else {
        result.warnings.push(msg);
      }
    }
  }

  return result;
}

/**
 * Create a parity check context before install
 * @param {string} projectRoot
 * @param {boolean} includePackageSet - Whether to snapshot package set (slower)
 * @returns {Promise<Object>} Context for runParityCheck
 */
export async function createParityContext(projectRoot, includePackageSet = false) {
  const context = {
    projectRoot,
    lockfileBefore: await snapshotLockfiles(projectRoot),
    packageSetBefore: null
  };

  if (includePackageSet) {
    const nodeModulesPath = path.join(projectRoot, "node_modules");
    try {
      context.packageSetBefore = await buildPackageSet(nodeModulesPath);
    } catch {
      // node_modules doesn't exist yet
      context.packageSetBefore = new Set();
    }
  }

  return context;
}
