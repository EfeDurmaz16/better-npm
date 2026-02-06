import fs from "node:fs/promises";
import path from "node:path";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(p) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Find a sensible "project root" for installs.
 *
 * Heuristic:
 * - If current dir contains a lockfile → use it
 * - Else walk up for the nearest dir that has a known lockfile OR package.json#workspaces
 * - Else return startDir
 *
 * @param {string} startDir
 * @returns {Promise<{root: string, reason: string}>}
 */
export async function resolveInstallProjectRoot(startDir) {
  const lockfiles = [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb"
  ];

  let dir = path.resolve(startDir);
  for (;;) {
    for (const lf of lockfiles) {
      if (await exists(path.join(dir, lf))) {
        return { root: dir, reason: `found:${lf}` };
      }
    }

    const pkg = await readJsonIfExists(path.join(dir, "package.json"));
    if (pkg && typeof pkg === "object" && pkg.workspaces) {
      return { root: dir, reason: "found:package.json#workspaces" };
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: path.resolve(startDir), reason: "default:cwd" };
}

