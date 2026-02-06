import fs from "node:fs/promises";
import path from "node:path";
import { scanTree } from "../lib/fsScan.js";
import { scanTreeAttributed } from "../lib/fsScan.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirOrSymlinkToDir(fullPath, dirent) {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    const st = await fs.stat(fullPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function readJson(p) {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw);
}

function depthFromPath(packagePath) {
  // Depth = number of node_modules segments leading to this package.
  return packagePath.split(path.sep).filter((seg) => seg === "node_modules").length;
}

async function listPackagesInNodeModules(nodeModulesDir) {
  const packages = [];
  const queue = [nodeModulesDir];

  while (queue.length) {
    const nm = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(nm, { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) continue;
      throw err;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const ent of entries) {
      const fullEnt = path.join(nm, ent.name);
      if (!(await isDirOrSymlinkToDir(fullEnt, ent))) continue;
      if (ent.name === ".bin") continue;
      if (ent.name.startsWith(".")) continue;

      if (ent.name.startsWith("@")) {
        const scopeDir = fullEnt;
        let scoped;
        try {
          scoped = await fs.readdir(scopeDir, { withFileTypes: true });
        } catch {
          continue;
        }
        scoped.sort((a, b) => a.name.localeCompare(b.name));
        for (const sc of scoped) {
          const scopedEnt = path.join(scopeDir, sc.name);
          if (!(await isDirOrSymlinkToDir(scopedEnt, sc))) continue;
          const pkgDir = scopedEnt;
          packages.push(pkgDir);
          const nested = path.join(pkgDir, "node_modules");
          if (await exists(nested)) queue.push(nested);
        }
        continue;
      }

      const pkgDir = fullEnt;
      packages.push(pkgDir);
      const nested = path.join(pkgDir, "node_modules");
      if (await exists(nested)) queue.push(nested);
    }
  }

  return packages;
}

async function tryReadPackageIdentity(pkgDir) {
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!(await exists(pkgJsonPath))) return null;
  try {
    const pkg = await readJson(pkgJsonPath);
    if (!pkg?.name || !pkg?.version) return null;
    return { name: pkg.name, version: pkg.version };
  } catch {
    return null;
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

export async function analyzeProject(projectRoot, opts = {}) {
  const { includeGraph = true } = opts;

  const nodeModulesDir = path.join(projectRoot, "node_modules");
  if (!(await exists(nodeModulesDir))) {
    return {
      ok: false,
      reason: "node_modules_not_found",
      projectRoot
    };
  }

  const totals = await scanTree(nodeModulesDir);
  const packageDirs = await listPackagesInNodeModules(nodeModulesDir);

  const seen = new Set();
  const packages = [];
  const byKey = new Map();
  const depths = [];

  for (const dir of packageDirs.sort()) {
    const ident = await tryReadPackageIdentity(dir);
    if (!ident) continue;
    const key = `${ident.name}@${ident.version}`;
    const depth = depthFromPath(dir);
    depths.push(depth);

    const size = await scanTreeAttributed(dir, seen, { excludeDirNames: new Set(["node_modules"]) });
    const entry = {
      key,
      name: ident.name,
      version: ident.version,
      paths: [dir],
      depthStats: { minDepth: depth, maxDepth: depth },
      sizes: size.ok
        ? {
            logicalBytes: size.logicalBytes,
            physicalBytes: size.physicalBytes,
            sharedBytes: size.sharedBytes,
            physicalBytesApprox: size.physicalBytesApprox,
            fileCount: size.fileCount
          }
        : { ok: false, reason: size.reason }
    };

    const existing = byKey.get(key);
    if (existing) {
      existing.paths.push(dir);
      existing.depthStats.minDepth = Math.min(existing.depthStats.minDepth, depth);
      existing.depthStats.maxDepth = Math.max(existing.depthStats.maxDepth, depth);
      // Keep sizes as aggregate logical/physical across locations (still deterministic).
      if (existing.sizes?.logicalBytes != null && entry.sizes?.logicalBytes != null) {
        existing.sizes.logicalBytes += entry.sizes.logicalBytes;
        existing.sizes.physicalBytes += entry.sizes.physicalBytes;
        existing.sizes.sharedBytes += entry.sizes.sharedBytes;
        existing.sizes.fileCount += entry.sizes.fileCount;
        existing.sizes.physicalBytesApprox = existing.sizes.physicalBytesApprox || entry.sizes.physicalBytesApprox;
      }
    } else {
      byKey.set(key, entry);
      packages.push(entry);
    }
  }

  // Duplicate detection.
  const byName = new Map();
  for (const p of packages) {
    const list = byName.get(p.name) ?? [];
    list.push(p);
    byName.set(p.name, list);
  }

  const duplicates = [];
  for (const [name, list] of byName.entries()) {
    const versions = [...new Set(list.map((x) => x.version))].sort();
    if (versions.length <= 1) continue;
    const majors = [...new Set(versions.map((v) => String(parseInt(String(v).split(".")[0] ?? "0", 10) || 0)))].sort();
    duplicates.push({
      name,
      versions,
      majors,
      count: list.length
    });
  }

  const depth = {
    maxDepth: depths.length ? Math.max(...depths) : 0,
    p95Depth: percentile(depths, 95)
  };

  let graph = null;
  if (includeGraph) {
    // Best-effort graph from filesystem: for each package location, look at its immediate node_modules children.
    const nodes = {};
    const edges = [];

    for (const p of packages) {
      nodes[p.key] = { key: p.key, name: p.name, version: p.version };
    }

    for (const p of packages) {
      for (const pkgPath of p.paths) {
        const nm = path.join(pkgPath, "node_modules");
        if (!(await exists(nm))) continue;
        let entries;
        try {
          entries = await fs.readdir(nm, { withFileTypes: true });
        } catch {
          continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const ent of entries) {
          const fullEnt = path.join(nm, ent.name);
          if (!(await isDirOrSymlinkToDir(fullEnt, ent))) continue;
          if (ent.name === ".bin" || ent.name.startsWith(".")) continue;

          const depDirs = [];
          if (ent.name.startsWith("@")) {
            const scopeDir = fullEnt;
            let scoped;
            try {
              scoped = await fs.readdir(scopeDir, { withFileTypes: true });
            } catch {
              continue;
            }
            scoped.sort((a, b) => a.name.localeCompare(b.name));
            for (const sc of scoped) {
              const scopedEnt = path.join(scopeDir, sc.name);
              if (!(await isDirOrSymlinkToDir(scopedEnt, sc))) continue;
              depDirs.push(scopedEnt);
            }
          } else {
            depDirs.push(fullEnt);
          }

          for (const depDir of depDirs) {
            const depIdent = await tryReadPackageIdentity(depDir);
            if (!depIdent) continue;
            const depKey = `${depIdent.name}@${depIdent.version}`;
            edges.push({ from: p.key, to: depKey, kind: "installed" });
          }
        }
      }
    }

    graph = { nodes, edges };
  }

  return {
    ok: true,
    kind: "better.analyze.report",
    schemaVersion: 1,
    projectRoot,
    nodeModules: totals.ok
      ? {
          path: nodeModulesDir,
          logicalBytes: totals.logicalBytes,
          physicalBytes: totals.physicalBytes,
          physicalBytesApprox: totals.physicalBytesApprox,
          fileCount: totals.fileCount
        }
      : { ok: false, reason: totals.reason },
    packages,
    duplicates,
    depth,
    graph
  };
}
