import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Compute SHA256 hash of a file
 */
async function hashFile(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null; // File doesn't exist
  }
}

/**
 * Snapshot lockfile hashes before install
 * @param {string} projectRoot
 * @returns {Promise<Object>} lockfile hashes
 */
export async function snapshotLockfiles(projectRoot) {
  const lockfiles = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb"
  ];

  const snapshot = {};
  for (const name of lockfiles) {
    const hash = await hashFile(path.join(projectRoot, name));
    if (hash) {
      snapshot[name] = hash;
    }
  }
  return snapshot;
}

/**
 * Detect drift between before/after snapshots
 * @param {Object} before - snapshot before install
 * @param {Object} after - snapshot after install
 * @returns {Object} drift report
 */
export function detectDrift(before, after) {
  const result = {
    hasDrift: false,
    added: [],
    removed: [],
    modified: [],
  };

  // Check for added lockfiles
  for (const name of Object.keys(after)) {
    if (!before[name]) {
      result.added.push(name);
      result.hasDrift = true;
    }
  }

  // Check for removed lockfiles
  for (const name of Object.keys(before)) {
    if (!after[name]) {
      result.removed.push(name);
      result.hasDrift = true;
    }
  }

  // Check for modified lockfiles
  for (const name of Object.keys(before)) {
    if (after[name] && before[name] !== after[name]) {
      result.modified.push(name);
      result.hasDrift = true;
    }
  }

  return result;
}
