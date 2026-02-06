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

export async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

export async function ensureEmptyDir(p) {
  await rmrf(p);
  await fs.mkdir(p, { recursive: true });
}

export function splitLockfilePath(relPath) {
  // package-lock uses forward slashes even on Windows.
  return relPath.split("/").filter(Boolean);
}

export async function materializeTree(srcDir, destDir, opts = {}) {
  const { linkStrategy = "auto", stats = null } = opts; // auto|hardlink|copy
  await fs.mkdir(destDir, { recursive: true });

  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of entries) {
    if (ent.name === "node_modules") continue; // never vendor nested node_modules from tarball
    if (ent.name === ".better_extracted") continue;
    const src = path.join(srcDir, ent.name);
    const dst = path.join(destDir, ent.name);

    if (ent.isDirectory()) {
      if (stats) {
        stats.directories = Number(stats.directories ?? 0) + 1;
      }
      await materializeTree(src, dst, opts);
      continue;
    }

    if (ent.isSymbolicLink()) {
      const link = await fs.readlink(src);
      await fs.symlink(link, dst);
      if (stats) {
        stats.symlinks = Number(stats.symlinks ?? 0) + 1;
      }
      continue;
    }

    if (ent.isFile()) {
      if (stats) {
        stats.files = Number(stats.files ?? 0) + 1;
      }
      if (linkStrategy === "copy") {
        await fs.copyFile(src, dst);
        if (stats) {
          stats.filesCopied = Number(stats.filesCopied ?? 0) + 1;
        }
        continue;
      }
      if (linkStrategy === "hardlink" || linkStrategy === "auto") {
        try {
          await fs.link(src, dst);
          if (stats) {
            stats.filesLinked = Number(stats.filesLinked ?? 0) + 1;
          }
          continue;
        } catch {
          await fs.copyFile(src, dst);
          if (stats) {
            stats.filesCopied = Number(stats.filesCopied ?? 0) + 1;
            stats.linkFallbackCopies = Number(stats.linkFallbackCopies ?? 0) + 1;
          }
          continue;
        }
      }
    }
  }
}

export async function atomicReplaceDir(stagingDir, finalDir) {
  const parent = path.dirname(finalDir);
  await fs.mkdir(parent, { recursive: true });

  const backup = `${finalDir}.better-old-${Date.now()}`;
  if (await exists(finalDir)) {
    await fs.rename(finalDir, backup);
  }
  await fs.rename(stagingDir, finalDir);
  if (await exists(backup)) {
    await rmrf(backup);
  }
}
