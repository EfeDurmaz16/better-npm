import fs from "node:fs/promises";
import path from "node:path";

function isMaybeHardlinkable(stat) {
  return typeof stat?.nlink === "number" && stat.nlink > 1;
}

function identityKeyForStat(fullPath, stat) {
  // Best-effort hardlink identity:
  // - On POSIX: dev+ino is stable.
  // - On Windows: Node often reports ino/dev, but may be 0; fall back to path to avoid incorrect dedupe.
  const dev = stat?.dev ?? 0;
  const ino = stat?.ino ?? 0;
  if (dev && ino) return `dev:${dev}:ino:${ino}`;
  return `path:${fullPath}`;
}

function physicalBytesForStat(stat) {
  // Prefer allocated blocks when available (more “physical” than st_size).
  if (typeof stat?.blocks === "number" && stat.blocks > 0) return stat.blocks * 512;
  return stat.size ?? 0;
}

export async function scanTree(rootDir, opts = {}) {
  const {
    excludeDirNames = new Set(),
    includeDotfiles = true,
    followSymlinks = false
  } = opts;

  const result = {
    rootDir,
    ok: true,
    reason: null,
    logicalBytes: 0,
    physicalBytes: 0,
    physicalBytesApprox: false,
    fileCount: 0,
    dirCount: 0,
    symlinkCount: 0
  };

  const seen = new Set(); // identity keys
  const stack = [rootDir];

  try {
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        // Missing directories are common (e.g. no node_modules).
        if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) continue;
        throw err;
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (!includeDotfiles && ent.name.startsWith(".")) continue;
        if (ent.isDirectory() && excludeDirNames.has(ent.name)) continue;

        const full = path.join(dir, ent.name);

        if (ent.isDirectory()) {
          result.dirCount += 1;
          stack.push(full);
          continue;
        }

        if (ent.isSymbolicLink()) {
          result.symlinkCount += 1;
          const lst = await fs.lstat(full);
          result.logicalBytes += lst.size ?? 0;
          result.physicalBytes += physicalBytesForStat(lst);
          result.fileCount += 1;
          if (followSymlinks) {
            // Unsafe by default; only used in controlled scenarios.
            const real = await fs.realpath(full);
            stack.push(real);
          }
          continue;
        }

        if (ent.isFile()) {
          const st = await fs.stat(full);
          result.fileCount += 1;
          result.logicalBytes += st.size ?? 0;

          if (isMaybeHardlinkable(st)) {
            const key = identityKeyForStat(full, st);
            const before = seen.size;
            seen.add(key);
            if (seen.size !== before) {
              result.physicalBytes += physicalBytesForStat(st);
            }
            // If we had to fall back to path keys, physical dedupe is approximate.
            if (key.startsWith("path:") && (st.dev === 0 || st.ino === 0)) {
              result.physicalBytesApprox = true;
            }
          } else {
            result.physicalBytes += physicalBytesForStat(st);
          }
          continue;
        }
      }
    }
  } catch (err) {
    result.ok = false;
    result.reason = err?.message ?? String(err);
  }

  return result;
}

// Similar to scanTree, but supports a caller-provided identity set so that
// hardlinked files can be attributed deterministically across multiple scans.
export async function scanTreeAttributed(rootDir, seenIdentities, opts = {}) {
  const {
    excludeDirNames = new Set(),
    includeDotfiles = true
  } = opts;

  const result = {
    rootDir,
    ok: true,
    reason: null,
    logicalBytes: 0,
    physicalBytes: 0,
    sharedBytes: 0,
    physicalBytesApprox: false,
    fileCount: 0
  };

  const stack = [rootDir];
  try {
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) continue;
        throw err;
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (!includeDotfiles && ent.name.startsWith(".")) continue;
        if (ent.isDirectory() && excludeDirNames.has(ent.name)) continue;
        const full = path.join(dir, ent.name);

        if (ent.isDirectory()) {
          stack.push(full);
          continue;
        }

        if (ent.isSymbolicLink()) {
          const lst = await fs.lstat(full);
          const logical = lst.size ?? 0;
          const physical = physicalBytesForStat(lst);
          result.fileCount += 1;
          result.logicalBytes += logical;
          // Treat symlinks as unique bytes to this package.
          result.physicalBytes += physical;
          continue;
        }

        if (ent.isFile()) {
          const st = await fs.stat(full);
          const logical = st.size ?? 0;
          const physical = physicalBytesForStat(st);
          result.fileCount += 1;
          result.logicalBytes += logical;

          const key = identityKeyForStat(full, st);
          const before = seenIdentities.size;
          seenIdentities.add(key);
          if (seenIdentities.size !== before) {
            result.physicalBytes += physical;
          } else {
            result.sharedBytes += physical;
          }
          if (key.startsWith("path:") && (st.dev === 0 || st.ino === 0)) {
            result.physicalBytesApprox = true;
          }
        }
      }
    }
  } catch (err) {
    result.ok = false;
    result.reason = err?.message ?? String(err);
  }

  return result;
}
