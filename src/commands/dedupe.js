import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// ========== Inline Semver Implementation (Zero Dependencies) ==========

function parseSemver(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?(?:\+(.+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
    build: match[5] || null,
    raw: version
  };
}

function parseRange(range) {
  const trimmed = range.trim();

  // Exact version
  if (/^\d+\.\d+\.\d+/.test(trimmed)) {
    const v = parseSemver(trimmed);
    return v ? { type: "exact", version: v } : null;
  }

  // Caret range: ^1.2.3
  if (trimmed.startsWith("^")) {
    const v = parseSemver(trimmed.slice(1));
    if (!v) return null;
    return { type: "caret", version: v };
  }

  // Tilde range: ~1.2.3
  if (trimmed.startsWith("~")) {
    const v = parseSemver(trimmed.slice(1));
    if (!v) return null;
    return { type: "tilde", version: v };
  }

  // >= range
  if (trimmed.startsWith(">=")) {
    const v = parseSemver(trimmed.slice(2).trim());
    if (!v) return null;
    return { type: "gte", version: v };
  }

  // > range
  if (trimmed.startsWith(">")) {
    const v = parseSemver(trimmed.slice(1).trim());
    if (!v) return null;
    return { type: "gt", version: v };
  }

  // <= range
  if (trimmed.startsWith("<=")) {
    const v = parseSemver(trimmed.slice(2).trim());
    if (!v) return null;
    return { type: "lte", version: v };
  }

  // < range
  if (trimmed.startsWith("<")) {
    const v = parseSemver(trimmed.slice(1).trim());
    if (!v) return null;
    return { type: "lt", version: v };
  }

  // x-range: 1.x, 1.2.x
  if (trimmed.includes(".x")) {
    const parts = trimmed.split(".");
    if (parts[0] !== "x" && /^\d+$/.test(parts[0])) {
      const major = Number(parts[0]);
      const minor = parts[1] === "x" ? null : Number(parts[1]);
      return { type: "x-range", major, minor };
    }
  }

  // Wildcard: *
  if (trimmed === "*" || trimmed === "") {
    return { type: "any" };
  }

  return null;
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Prerelease comparison
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) {
    return a.prerelease.localeCompare(b.prerelease);
  }

  return 0;
}

function satisfies(version, range) {
  const v = typeof version === "string" ? parseSemver(version) : version;
  if (!v) return false;

  const r = typeof range === "string" ? parseRange(range) : range;
  if (!r) return false;

  switch (r.type) {
    case "exact":
      return compareVersions(v, r.version) === 0;

    case "caret": {
      // ^1.2.3 := >=1.2.3 <2.0.0
      // ^0.2.3 := >=0.2.3 <0.3.0
      // ^0.0.3 := >=0.0.3 <0.0.4
      const base = r.version;
      if (base.major > 0) {
        return v.major === base.major && compareVersions(v, base) >= 0;
      } else if (base.minor > 0) {
        return v.major === 0 && v.minor === base.minor && compareVersions(v, base) >= 0;
      } else {
        return v.major === 0 && v.minor === 0 && v.patch === base.patch;
      }
    }

    case "tilde": {
      // ~1.2.3 := >=1.2.3 <1.3.0
      const base = r.version;
      return v.major === base.major && v.minor === base.minor && compareVersions(v, base) >= 0;
    }

    case "gte":
      return compareVersions(v, r.version) >= 0;

    case "gt":
      return compareVersions(v, r.version) > 0;

    case "lte":
      return compareVersions(v, r.version) <= 0;

    case "lt":
      return compareVersions(v, r.version) < 0;

    case "x-range":
      if (r.minor === null) {
        return v.major === r.major;
      }
      return v.major === r.major && v.minor === r.minor;

    case "any":
      return true;

    default:
      return false;
  }
}

function findBestVersion(versions, ranges) {
  // Find the highest version that satisfies all ranges
  const parsed = versions.map(v => parseSemver(v)).filter(Boolean);
  if (parsed.length === 0) return null;

  parsed.sort((a, b) => compareVersions(b, a)); // Descending order

  for (const v of parsed) {
    const satisfiesAll = ranges.every(r => satisfies(v, r));
    if (satisfiesAll) return v.raw;
  }

  return null;
}

// ========== Package Lock Analysis ==========

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

function extractPackagesFromLock(lockData) {
  const packages = new Map();

  if (!lockData || typeof lockData !== "object") return packages;

  // npm lockfile v2/v3
  if (lockData.packages) {
    for (const [pkgPath, data] of Object.entries(lockData.packages)) {
      if (!pkgPath || pkgPath === "") continue; // Skip root

      // Extract package name from path like "node_modules/debug" or "node_modules/foo/node_modules/debug"
      const pathParts = pkgPath.split("/");
      let name = null;

      for (let i = pathParts.length - 1; i >= 0; i--) {
        if (pathParts[i] === "node_modules" && i + 1 < pathParts.length) {
          const candidate = pathParts[i + 1];
          if (candidate.startsWith("@") && i + 2 < pathParts.length) {
            name = `${candidate}/${pathParts[i + 2]}`;
          } else {
            name = candidate;
          }
          break;
        }
      }

      if (!name || !data.version) continue;

      if (!packages.has(name)) {
        packages.set(name, []);
      }

      packages.get(name).push({
        version: data.version,
        path: pkgPath,
        resolved: data.resolved || null,
        integrity: data.integrity || null
      });
    }
  }

  // npm lockfile v1 (dependencies format)
  if (lockData.dependencies) {
    const traverse = (deps, parentPath = "") => {
      for (const [name, data] of Object.entries(deps)) {
        if (!data.version) continue;

        const currentPath = parentPath ? `${parentPath}/node_modules/${name}` : `node_modules/${name}`;

        if (!packages.has(name)) {
          packages.set(name, []);
        }

        packages.get(name).push({
          version: data.version,
          path: currentPath,
          resolved: data.resolved || null,
          integrity: data.integrity || null
        });

        if (data.dependencies) {
          traverse(data.dependencies, currentPath);
        }
      }
    };

    traverse(lockData.dependencies);
  }

  return packages;
}

async function estimateNodeModulesSize(projectRoot, packageName) {
  const nmPath = path.join(projectRoot, "node_modules", packageName);
  if (!(await exists(nmPath))) return 0;

  try {
    let totalSize = 0;
    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          totalSize += stat.size;
        }
      }
    };
    await walk(nmPath);
    return totalSize;
  } catch {
    return 0;
  }
}

async function analyzeDuplicates(projectRoot, packageLock) {
  const packages = extractPackagesFromLock(packageLock);
  const duplicates = [];

  for (const [name, instances] of packages.entries()) {
    if (instances.length <= 1) continue;

    // Get unique versions
    const versionSet = new Set(instances.map(i => i.version));
    const versions = Array.from(versionSet).sort((a, b) => {
      const pa = parseSemver(a);
      const pb = parseSemver(b);
      if (!pa || !pb) return 0;
      return compareVersions(pb, pa); // Descending
    });

    if (versions.length <= 1) continue;

    // Try to find if these can be deduplicated
    // Check if the highest version is compatible with all lower versions using caret ranges
    const ranges = versions.map(v => `^${v}`);
    const targetVersion = findBestVersion(versions, ranges);

    const canDedupe = targetVersion !== null;
    const savedInstances = canDedupe ? instances.length - 1 : 0;

    duplicates.push({
      name,
      versions,
      instances: instances.length,
      canDedupe,
      targetVersion: canDedupe ? targetVersion : null,
      savedInstances,
      paths: instances.map(i => i.path)
    });
  }

  return duplicates;
}

// ========== Command Implementation ==========

export async function cmdDedupe(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better dedupe [--json] [--dry-run] [--project-root PATH]

Detects duplicate packages in the dependency tree that could be deduplicated.

Options:
  --json              Output machine-readable JSON
  --dry-run          Report mode only (default: true)
  --project-root PATH Override project root directory
  -h, --help         Show this help message
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "dedupe" });

  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "dry-run": { type: "boolean", default: true },
      "project-root": { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]), reason: "flag:--project-root" }
    : await resolveInstallProjectRoot(process.cwd());

  const projectRoot = resolvedRoot.root;

  commandLogger.info("analyzing package-lock.json for duplicates", { projectRoot });

  // Look for package-lock.json
  const lockPath = path.join(projectRoot, "package-lock.json");
  if (!(await exists(lockPath))) {
    const result = {
      ok: false,
      kind: "better.dedupe",
      schemaVersion: 1,
      error: "package-lock.json not found",
      projectRoot
    };

    if (values.json) {
      printJson(result);
    } else {
      printText(`Error: package-lock.json not found at ${lockPath}`);
    }
    return;
  }

  const packageLock = await readJsonIfExists(lockPath);
  if (!packageLock) {
    const result = {
      ok: false,
      kind: "better.dedupe",
      schemaVersion: 1,
      error: "failed to parse package-lock.json",
      projectRoot
    };

    if (values.json) {
      printJson(result);
    } else {
      printText(`Error: failed to parse package-lock.json`);
    }
    return;
  }

  const duplicates = await analyzeDuplicates(projectRoot, packageLock);

  const deduplicatable = duplicates.filter(d => d.canDedupe);
  const totalSavedInstances = deduplicatable.reduce((sum, d) => sum + d.savedInstances, 0);

  const result = {
    ok: true,
    kind: "better.dedupe",
    schemaVersion: 1,
    projectRoot,
    duplicates: duplicates.map(d => ({
      name: d.name,
      versions: d.versions,
      instances: d.instances,
      canDedupe: d.canDedupe,
      targetVersion: d.targetVersion,
      savedInstances: d.savedInstances
    })),
    summary: {
      totalDuplicates: duplicates.length,
      deduplicatable: deduplicatable.length,
      estimatedSavedPackages: totalSavedInstances
    }
  };

  if (values.json) {
    printJson(result);
  } else {
    if (duplicates.length === 0) {
      printText("No duplicate packages found.");
    } else {
      const lines = [
        `Found ${duplicates.length} package(s) with multiple versions:`,
        ""
      ];

      for (const dup of duplicates) {
        lines.push(`${dup.name}:`);
        lines.push(`  Versions: ${dup.versions.join(", ")}`);
        lines.push(`  Instances: ${dup.instances}`);
        if (dup.canDedupe) {
          lines.push(`  Can dedupe to: ${dup.targetVersion} (saves ${dup.savedInstances} instance(s))`);
        } else {
          lines.push(`  Cannot dedupe (incompatible version ranges)`);
        }
        lines.push("");
      }

      lines.push("Summary:");
      lines.push(`  Total duplicates: ${result.summary.totalDuplicates}`);
      lines.push(`  Deduplicatable: ${result.summary.deduplicatable}`);
      lines.push(`  Estimated saved packages: ${result.summary.estimatedSavedPackages}`);

      printText(lines.join("\n"));
    }
  }
}
