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

export async function listInstalledPackageDirs(nodeModulesDir) {
  const out = [];
  if (!(await exists(nodeModulesDir))) return out;

  const queue = [nodeModulesDir];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
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
          scoped = await fs.readdir(full, { withFileTypes: true });
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

export async function countInstalledPackages(nodeModulesDir) {
  const dirs = await listInstalledPackageDirs(nodeModulesDir);
  const identities = new Set();
  for (const dir of dirs) {
    const ident = await readPackageIdentity(dir);
    if (ident) identities.add(ident);
  }
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

  const [size, packageCount] = await Promise.all([
    scanTreeWithBestEngine(nodeModulesPath, {
      coreMode: opts.coreMode ?? "auto",
      duFallback: opts.duFallback ?? "auto"
    }),
    includePackageCount ? countInstalledPackages(nodeModulesPath) : Promise.resolve(null)
  ]);

  if (!size.ok) {
    return {
      ok: false,
      path: nodeModulesPath,
      exists: true,
      packageCount,
      reason: size.reason ?? "scan_failed"
    };
  }

  return {
    ok: true,
    path: nodeModulesPath,
    exists: true,
    packageCount,
    logicalBytes: size.logicalBytes,
    physicalBytes: size.physicalBytes,
    physicalBytesApprox: !!size.physicalBytesApprox,
    fileCount: size.fileCount
  };
}
