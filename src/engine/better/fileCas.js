import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Compute SHA-256 hash of a file, return hex string.
 */
export async function hashFile(filePath) {
  // Use streaming hash with fs.createReadStream
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fssync.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Get the store path for a file by its content hash.
 */
export function fileStorePath(storeRoot, hex) {
  const a = hex.slice(0, 2);
  const b = hex.slice(2, 4);
  return path.join(storeRoot, "files", "sha256", a, b, hex);
}

/**
 * Get the manifest path for a package.
 */
export function packageManifestDir(storeRoot, algorithm, pkgHex) {
  const a = pkgHex.slice(0, 2);
  const b = pkgHex.slice(2, 4);
  return path.join(storeRoot, "packages", algorithm, a, b, pkgHex);
}

export function packageManifestPath(storeRoot, algorithm, pkgHex) {
  return path.join(packageManifestDir(storeRoot, algorithm, pkgHex), "manifest.json");
}

/**
 * Ingest a package directory into the file-level CAS.
 * Hashes each file individually, stores unique ones in the global store,
 * and writes a package manifest mapping relative paths to file hashes.
 *
 * @param {string} storeRoot - Root of the file CAS store
 * @param {string} pkgAlgorithm - Hash algorithm of the package integrity (e.g. "sha512")
 * @param {string} pkgHex - Hex hash of the package integrity
 * @param {string} unpackedDir - Directory containing the extracted package files
 * @returns {{ manifest: object, stats: { totalFiles: number, newFiles: number, existingFiles: number, totalBytes: number } }}
 */
export async function ingestPackageToFileCas(storeRoot, pkgAlgorithm, pkgHex, unpackedDir) {
  const manifestDir = packageManifestDir(storeRoot, pkgAlgorithm, pkgHex);
  const manifestFile = path.join(manifestDir, "manifest.json");

  // If manifest already exists, skip ingestion
  try {
    const existing = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    if (existing && existing.files) {
      return {
        manifest: existing,
        stats: { totalFiles: Object.keys(existing.files).length, newFiles: 0, existingFiles: Object.keys(existing.files).length, totalBytes: 0 },
        reused: true
      };
    }
  } catch {
    // manifest doesn't exist, proceed with ingestion
  }

  const files = {};
  const stats = { totalFiles: 0, newFiles: 0, existingFiles: 0, totalBytes: 0 };

  // Walk the unpacked directory recursively
  async function walkAndIngest(dir, relPrefix) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".better_extracted") continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walkAndIngest(fullPath, relPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(fullPath);
        files[relPath] = { type: "symlink", target };
        continue;
      }

      if (entry.isFile()) {
        stats.totalFiles++;
        const hex = await hashFile(fullPath);
        const storePath = fileStorePath(storeRoot, hex);

        try {
          await fs.access(storePath);
          stats.existingFiles++;
        } catch {
          // File doesn't exist in store yet - copy it in
          await fs.mkdir(path.dirname(storePath), { recursive: true });
          const tmp = `${storePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          await fs.copyFile(fullPath, tmp);
          try {
            await fs.rename(tmp, storePath);
          } catch {
            // Another process may have created it - that's fine
            await fs.rm(tmp, { force: true }).catch(() => {});
          }
          stats.newFiles++;
        }

        const st = await fs.stat(fullPath);
        stats.totalBytes += st.size;
        files[relPath] = { type: "file", hash: hex, size: st.size, mode: st.mode };
      }
    }
  }

  await walkAndIngest(unpackedDir, "");

  const manifest = {
    version: 1,
    pkgAlgorithm,
    pkgHex,
    files,
    createdAt: new Date().toISOString(),
    fileCount: stats.totalFiles
  };

  // Write manifest
  await fs.mkdir(manifestDir, { recursive: true });
  const tmpManifest = `${manifestFile}.tmp-${Date.now()}`;
  await fs.writeFile(tmpManifest, JSON.stringify(manifest, null, 2) + "\n");
  await fs.rename(tmpManifest, manifestFile);

  return { manifest, stats, reused: false };
}

/**
 * Materialize a package from the file CAS into a destination directory.
 * Creates hardlinks from the global store to the destination.
 * Falls back to copy if hardlink fails.
 *
 * @param {string} storeRoot - Root of the file CAS store
 * @param {string} pkgAlgorithm - Hash algorithm of the package integrity
 * @param {string} pkgHex - Hex hash of the package integrity
 * @param {string} destDir - Destination directory (e.g. node_modules/pkg)
 * @param {{ linkStrategy?: string }} opts
 * @returns {{ ok: boolean, stats: { files: number, linked: number, copied: number, symlinks: number } }}
 */
export async function materializeFromFileCas(storeRoot, pkgAlgorithm, pkgHex, destDir, opts = {}) {
  const { linkStrategy = "auto" } = opts;
  const manifestFile = packageManifestPath(storeRoot, pkgAlgorithm, pkgHex);

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  } catch {
    return { ok: false, reason: "manifest_not_found", stats: { files: 0, linked: 0, copied: 0, symlinks: 0 } };
  }

  const stats = { files: 0, linked: 0, copied: 0, symlinks: 0 };

  // Collect all directories needed (sorted shortest-first for correct creation order)
  const dirsNeeded = new Set([destDir]);
  for (const relPath of Object.keys(manifest.files)) {
    dirsNeeded.add(path.join(destDir, path.dirname(relPath)));
  }
  const sortedDirs = [...dirsNeeded].sort((a, b) => a.length - b.length);
  for (const dir of sortedDirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  // Materialize files
  for (const [relPath, entry] of Object.entries(manifest.files)) {
    const dest = path.join(destDir, relPath);

    if (entry.type === "symlink") {
      try { await fs.rm(dest, { force: true }); } catch {}
      await fs.symlink(entry.target, dest);
      stats.symlinks++;
      continue;
    }

    if (entry.type === "file") {
      const storePath = fileStorePath(storeRoot, entry.hash);
      stats.files++;

      if (linkStrategy === "copy") {
        await fs.copyFile(storePath, dest);
        stats.copied++;
        continue;
      }

      // Try hardlink first (auto or hardlink strategy)
      try {
        await fs.link(storePath, dest);
        stats.linked++;
      } catch {
        await fs.copyFile(storePath, dest);
        stats.copied++;
      }

      // Restore file mode if stored
      if (entry.mode) {
        try { await fs.chmod(dest, entry.mode); } catch {}
      }
    }
  }

  return { ok: true, stats };
}

/**
 * Check if a package manifest exists in the file CAS.
 */
export async function hasFileCasManifest(storeRoot, pkgAlgorithm, pkgHex) {
  try {
    await fs.access(packageManifestPath(storeRoot, pkgAlgorithm, pkgHex));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get stats about the file CAS store.
 */
export async function getFileCasStats(storeRoot) {
  const stats = {
    uniqueFiles: 0,
    totalFileBytes: 0,
    packageManifests: 0,
    storeRoot
  };

  const filesDir = path.join(storeRoot, "files");
  const packagesDir = path.join(storeRoot, "packages");

  // Count unique files
  async function countFiles(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await countFiles(full);
        } else if (entry.isFile()) {
          stats.uniqueFiles++;
          try {
            const st = await fs.stat(full);
            stats.totalFileBytes += st.size;
          } catch {}
        }
      }
    } catch {}
  }

  // Count package manifests
  async function countManifests(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await countManifests(full);
        } else if (entry.isFile() && entry.name === "manifest.json") {
          stats.packageManifests++;
        }
      }
    } catch {}
  }

  await Promise.all([countFiles(filesDir), countManifests(packagesDir)]);

  return stats;
}

/**
 * Remove unreferenced files from the store.
 * Scans all manifests to find referenced file hashes, then deletes any files not referenced.
 */
export async function gcFileCas(storeRoot, opts = {}) {
  const { dryRun = false } = opts;
  const referencedHashes = new Set();
  const packagesDir = path.join(storeRoot, "packages");

  // Collect all referenced hashes from manifests
  async function scanManifests(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanManifests(full);
        } else if (entry.isFile() && entry.name === "manifest.json") {
          try {
            const manifest = JSON.parse(await fs.readFile(full, "utf8"));
            for (const fileEntry of Object.values(manifest.files || {})) {
              if (fileEntry.hash) referencedHashes.add(fileEntry.hash);
            }
          } catch {}
        }
      }
    } catch {}
  }

  await scanManifests(packagesDir);

  // Walk files dir and delete unreferenced
  const filesDir = path.join(storeRoot, "files");
  let removed = 0;
  let bytesFreed = 0;

  async function cleanFiles(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await cleanFiles(full);
        } else if (entry.isFile()) {
          if (!referencedHashes.has(entry.name)) {
            try {
              const st = await fs.stat(full);
              bytesFreed += st.size;
            } catch {}
            if (!dryRun) {
              await fs.rm(full, { force: true });
            }
            removed++;
          }
        }
      }
    } catch {}
  }

  await cleanFiles(filesDir);

  return { removed, bytesFreed, dryRun, referencedCount: referencedHashes.size };
}
