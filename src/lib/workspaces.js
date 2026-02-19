import fs from "node:fs/promises";
import path from "node:path";

/**
 * Detect and resolve workspace packages for npm, pnpm, and yarn workspaces.
 * Zero dependencies — uses only node:* built-ins.
 */

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Expand a single glob pattern (supports only `*` and `**`) against the filesystem.
 * This is intentionally minimal — we only need workspace glob expansion.
 */
async function expandGlob(baseDir, pattern) {
  const results = [];
  const segments = pattern.split("/").filter(Boolean);

  async function walk(dir, segIndex) {
    if (segIndex >= segments.length) {
      if (await exists(path.join(dir, "package.json"))) {
        results.push(dir);
      }
      return;
    }

    const seg = segments[segIndex];

    if (seg === "**") {
      // Match zero or more directories
      await walk(dir, segIndex + 1);
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const sub = path.join(dir, entry.name);
        await walk(sub, segIndex); // continue ** matching
      }
    } else if (seg === "*") {
      // Match any single directory
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(path.join(dir, entry.name), segIndex + 1);
      }
    } else {
      // Literal directory name
      const next = path.join(dir, seg);
      if (await exists(next)) {
        await walk(next, segIndex + 1);
      }
    }
  }

  await walk(baseDir, 0);
  return results;
}

/**
 * Detect workspace configuration type and raw patterns.
 * Returns { type: "npm"|"pnpm"|"yarn"|null, patterns: string[], root: string }
 */
export async function detectWorkspaceConfig(projectRoot) {
  const pkg = await readJsonFile(path.join(projectRoot, "package.json"));

  // Check for pnpm workspaces (pnpm-workspace.yaml)
  const pnpmWorkspacePath = path.join(projectRoot, "pnpm-workspace.yaml");
  if (await exists(pnpmWorkspacePath)) {
    const raw = await fs.readFile(pnpmWorkspacePath, "utf8");
    const patterns = parsePnpmWorkspaceYaml(raw);
    if (patterns.length > 0) {
      return { type: "pnpm", patterns, root: projectRoot };
    }
  }

  // Check for npm/yarn workspaces in package.json
  if (pkg?.workspaces) {
    const patterns = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : Array.isArray(pkg.workspaces.packages)
        ? pkg.workspaces.packages
        : [];

    if (patterns.length > 0) {
      // Distinguish yarn from npm by lockfile presence
      const hasYarnLock = await exists(path.join(projectRoot, "yarn.lock"));
      const type = hasYarnLock ? "yarn" : "npm";
      return { type, patterns, root: projectRoot };
    }
  }

  return { type: null, patterns: [], root: projectRoot };
}

/**
 * Minimal pnpm-workspace.yaml parser.
 * Extracts patterns from `packages:` list without a YAML library.
 */
function parsePnpmWorkspaceYaml(raw) {
  const patterns = [];
  let inPackages = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "packages:" || trimmed === "packages: ") {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (trimmed.startsWith("- ")) {
        const value = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, "");
        if (value) patterns.push(value);
      } else if (trimmed && !trimmed.startsWith("#")) {
        // End of packages list
        break;
      }
    }
  }

  return patterns;
}

/**
 * Resolve all workspace packages from patterns.
 * Returns array of WorkspacePackage objects.
 *
 * @typedef {Object} WorkspacePackage
 * @property {string} name - Package name from package.json
 * @property {string} version - Package version
 * @property {string} dir - Absolute path to workspace package directory
 * @property {string} relativeDir - Relative path from workspace root
 * @property {Object} pkg - Full package.json contents
 * @property {Object} dependencies - Combined deps (dependencies + devDependencies)
 * @property {string[]} workspaceDeps - Names of other workspace packages this depends on
 */
export async function resolveWorkspacePackages(projectRoot, config = null) {
  if (!config) {
    config = await detectWorkspaceConfig(projectRoot);
  }

  if (!config.type || config.patterns.length === 0) {
    return { ok: false, reason: "no_workspaces", packages: [] };
  }

  const allDirs = [];
  for (const pattern of config.patterns) {
    // Handle negation patterns
    if (pattern.startsWith("!")) continue;
    const expanded = await expandGlob(projectRoot, pattern);
    allDirs.push(...expanded);
  }

  // Deduplicate
  const uniqueDirs = [...new Set(allDirs.map(d => path.resolve(d)))];

  // Load package.json for each workspace
  const packages = [];
  const nameSet = new Set();

  for (const dir of uniqueDirs) {
    const pkgPath = path.join(dir, "package.json");
    const pkg = await readJsonFile(pkgPath);
    if (!pkg || !pkg.name) continue;

    nameSet.add(pkg.name);
    packages.push({
      name: pkg.name,
      version: pkg.version ?? "0.0.0",
      dir,
      relativeDir: path.relative(projectRoot, dir),
      pkg,
      dependencies: {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
        ...(pkg.peerDependencies ?? {})
      },
      workspaceDeps: [] // filled below
    });
  }

  // Resolve workspace-internal dependencies
  for (const wp of packages) {
    wp.workspaceDeps = Object.keys(wp.dependencies).filter(dep => nameSet.has(dep));
  }

  return {
    ok: true,
    type: config.type,
    root: projectRoot,
    patterns: config.patterns,
    packages,
    packageNames: [...nameSet]
  };
}

/**
 * Check if a project root is a workspace/monorepo.
 */
export async function isWorkspace(projectRoot) {
  const config = await detectWorkspaceConfig(projectRoot);
  return config.type !== null;
}

/**
 * Find the workspace root by walking up from a given directory.
 * Returns null if no workspace root is found.
 */
export async function findWorkspaceRoot(startDir) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (current !== root) {
    const config = await detectWorkspaceConfig(current);
    if (config.type) return current;
    current = path.dirname(current);
  }

  return null;
}

/**
 * Get a summary of workspace structure for display.
 */
export function workspaceSummary(resolved) {
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  const totalDeps = resolved.packages.reduce(
    (sum, p) => sum + Object.keys(p.dependencies).length,
    0
  );
  const internalEdges = resolved.packages.reduce(
    (sum, p) => sum + p.workspaceDeps.length,
    0
  );

  return {
    ok: true,
    type: resolved.type,
    packageCount: resolved.packages.length,
    totalDependencies: totalDeps,
    internalDependencies: internalEdges,
    packages: resolved.packages.map(p => ({
      name: p.name,
      version: p.version,
      relativeDir: p.relativeDir,
      depCount: Object.keys(p.dependencies).length,
      workspaceDeps: p.workspaceDeps
    }))
  };
}
