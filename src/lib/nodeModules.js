import fs from "node:fs/promises";
import path from "node:path";
import { scanTreeWithBestEngine } from "./scanFacade.js";

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

export async function listInstalledPackageDirs(nodeModulesDir, opts = {}) {
  const readDirectory = async (dir) => opts.directoryEntries?.get(dir) ?? fs.readdir(dir, { withFileTypes: true });
  const out = [];
  if (!(await exists(nodeModulesDir))) return out;

  const queue = [nodeModulesDir];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      const real = await fs.realpath(current);
      if (visited.has(real)) continue;
      visited.add(real);
      entries = await readDirectory(current);
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (!(await isDirOrSymlinkToDir(full, entry))) continue;
      if (entry.name === ".bin") continue;
      if (entry.name === ".pnpm") {
        queue.push(full);
        continue;
      }
      if (entry.name.startsWith(".")) continue;

      if (entry.name.startsWith("@")) {
        let scoped;
        try {
          scoped = await readDirectory(full);
        } catch {
          continue;
        }
        scoped.sort((a, b) => a.name.localeCompare(b.name));
        for (const scopedEntry of scoped) {
          const scopedFull = path.join(full, scopedEntry.name);
          if (!(await isDirOrSymlinkToDir(scopedFull, scopedEntry))) continue;
          out.push(scopedFull);
          const nested = path.join(scopedFull, "node_modules");
          if (await exists(nested)) queue.push(nested);
        }
        continue;
      }

      out.push(full);
      const nested = path.join(full, "node_modules");
      if (await exists(nested)) queue.push(nested);
    }
  }

  return out;
}

async function readPackageIdentity(pkgDir) {
  const pkgJsonPath = path.join(pkgDir, "package.json");
  try {
    const raw = await fs.readFile(pkgJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.name || !parsed?.version) return null;
    return `${parsed.name}@${parsed.version}`;
  } catch {
    return null;
  }
}

export async function countInstalledPackages(nodeModulesDir, opts = {}) {
  const dirs = await listInstalledPackageDirs(nodeModulesDir, opts);
  const identities = new Set();
  let next = 0;
  // Bound open descriptors and queued promises independently of package count.
  const workerCount = Math.min(8, dirs.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < dirs.length) {
      const dir = dirs[next++];
      const ident = await readPackageIdentity(dir);
      if (ident) identities.add(ident);
    }
  }));
  return identities.size;
}

export async function collectNodeModulesSnapshot(projectRoot, opts = {}) {
  const nodeModulesPath = path.join(projectRoot, "node_modules");
  const includePackageCount = opts.includePackageCount !== false;
  const present = await exists(nodeModulesPath);
  if (!present) {
    return {
      ok: true,
      path: nodeModulesPath,
      exists: false,
      packageCount: 0,
      logicalBytes: 0,
      physicalBytes: 0,
      physicalBytesApprox: false,
      fileCount: 0
    };
  }

  // Only retain entries needed for package enumeration, and only for this
  // observation. The JS size fallback supplies them during its existing walk.
  const directoryEntries = new Map();
  const size = await scanTreeWithBestEngine(nodeModulesPath, {
    coreMode: opts.coreMode ?? "auto",
    duFallback: opts.duFallback ?? "auto",
    quickLogical: opts.quickLogical === true,
    observeDirectory: includePackageCount ? (dir, entries) => {
      const name = path.basename(dir);
      if (name === "node_modules" || name === ".pnpm" || name.startsWith("@")) {
        directoryEntries.set(dir, entries);
      }
    } : undefined
  });
  // Native size counts are not distinct package identities. Preserve that
  // contract until the native scanner exports a compatible identity inventory.
  const packageCount = includePackageCount
    ? await countInstalledPackages(nodeModulesPath, { directoryEntries })
    : null;
  const resolvedPackageCount = packageCount ?? (
    Number.isFinite(size?.packageCount) ? Number(size.packageCount) : null
  );

  if (!size.ok) {
    return {
      ok: false,
      path: nodeModulesPath,
      exists: true,
      packageCount: resolvedPackageCount,
      reason: size.reason ?? "scan_failed"
    };
  }

  return {
    ok: true,
    path: nodeModulesPath,
    exists: true,
    packageCount: resolvedPackageCount,
    logicalBytes: size.logicalBytes,
    physicalBytes: size.physicalBytes,
    physicalBytesApprox: !!size.physicalBytesApprox,
    fileCount: size.fileCount
  };
}
