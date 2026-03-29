/**
 * Delta update engine (#26).
 *
 * On `better install` after a lockfile change, computes the minimal set
 * of packages that actually changed and only re-fetches / re-materialises
 * those. Unchanged packages: verified by inode / mtime against CAS.
 *
 * Algorithm:
 *   1. Load "baseline" snapshot: stored package-version list from last run
 *   2. Parse current lockfile to get new package-version list
 *   3. Diff → { added, removed, changed, unchanged }
 *   4. Return delta for the install engine to act on
 *
 * The snapshot is stored in the better cache dir as a JSON file keyed by
 * project root hash.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const SNAPSHOT_VERSION = 1;

/**
 * Parse a package-lock.json into a flat Map<name@version, true>.
 *
 * @param {string} lockfilePath
 * @returns {Promise<Map<string, string>>} name → version
 */
export async function parseLockfilePackages(lockfilePath) {
  const map = new Map();
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(lockfilePath, "utf8"));
  } catch {
    return map;
  }

  if (raw.packages) {
    // npm lockfile v2/v3
    for (const [pkgPath, info] of Object.entries(raw.packages)) {
      if (!pkgPath || pkgPath === "") continue;
      const name = pkgPath.replace(/^node_modules\//, "").replace(/.*node_modules\//, "");
      if (name && info.version) map.set(name, info.version);
    }
  } else if (raw.dependencies) {
    // npm lockfile v1
    function walk(deps) {
      for (const [name, info] of Object.entries(deps)) {
        if (info.version) map.set(name, info.version);
        if (info.dependencies) walk(info.dependencies);
      }
    }
    walk(raw.dependencies);
  }

  return map;
}

/**
 * Compute a diff between two package maps.
 *
 * @param {Map<string, string>} baseline - previous install
 * @param {Map<string, string>} current  - current lockfile
 * @returns {{ added: string[], removed: string[], changed: string[], unchanged: string[] }}
 */
export function diffPackageMaps(baseline, current) {
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [name, version] of current) {
    if (!baseline.has(name)) {
      added.push({ name, version });
    } else if (baseline.get(name) !== version) {
      changed.push({ name, from: baseline.get(name), to: version });
    } else {
      unchanged.push({ name, version });
    }
  }

  for (const [name, version] of baseline) {
    if (!current.has(name)) {
      removed.push({ name, version });
    }
  }

  return { added, removed, changed, unchanged };
}

/**
 * Load a stored snapshot for a project.
 *
 * @param {string} cacheDir - better cache root
 * @param {string} projectRoot
 * @returns {Promise<Map<string, string> | null>}
 */
export async function loadSnapshot(cacheDir, projectRoot) {
  const snapshotPath = snapshotFile(cacheDir, projectRoot);
  try {
    const raw = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
    if (raw.version !== SNAPSHOT_VERSION) return null;
    return new Map(Object.entries(raw.packages ?? {}));
  } catch {
    return null;
  }
}

/**
 * Save a snapshot for a project.
 *
 * @param {string} cacheDir
 * @param {string} projectRoot
 * @param {Map<string, string>} packages
 */
export async function saveSnapshot(cacheDir, projectRoot, packages) {
  const snapshotPath = snapshotFile(cacheDir, projectRoot);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  const data = {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    projectRoot,
    packages: Object.fromEntries(packages)
  };
  await fs.writeFile(snapshotPath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function snapshotFile(cacheDir, projectRoot) {
  const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  return path.join(cacheDir, "snapshots", `${hash}.json`);
}

/**
 * Compute the delta for a given project root.
 * Returns the diff + whether a full install is needed.
 *
 * @param {string} cacheDir
 * @param {string} projectRoot
 * @param {string} lockfilePath
 * @returns {Promise<{
 *   ok: boolean,
 *   fullInstallNeeded: boolean,
 *   delta: Object,
 *   totalPackages: number,
 *   changedPackages: number,
 *   reason?: string
 * }>}
 */
export async function computeDelta(cacheDir, projectRoot, lockfilePath) {
  const [baseline, current] = await Promise.all([
    loadSnapshot(cacheDir, projectRoot),
    parseLockfilePackages(lockfilePath)
  ]);

  if (!baseline) {
    return {
      ok: true,
      fullInstallNeeded: true,
      delta: null,
      totalPackages: current.size,
      changedPackages: current.size,
      reason: "no_baseline"
    };
  }

  if (current.size === 0) {
    return {
      ok: false,
      fullInstallNeeded: true,
      delta: null,
      totalPackages: 0,
      changedPackages: 0,
      reason: "empty_lockfile"
    };
  }

  const delta = diffPackageMaps(baseline, current);
  const changedPackages = delta.added.length + delta.removed.length + delta.changed.length;

  return {
    ok: true,
    fullInstallNeeded: changedPackages === current.size, // everything changed = do full install
    delta,
    totalPackages: current.size,
    changedPackages,
    unchangedPackages: delta.unchanged.length
  };
}
