import fs from "node:fs/promises";
import path from "node:path";

export const FALLBACK_REASONS = {
  EPERM: "eperm",
  EXDEV: "exdev",
  ENOSPC: "enospc",
  EMLINK: "emlink",
  UNKNOWN: "unknown_link_error"
};

function classifyLinkError(err) {
  const code = err?.code ?? "";
  const msg = String(err?.message ?? "");
  if (code === "EPERM" || msg.includes("EPERM") || msg.includes("operation not permitted")) return FALLBACK_REASONS.EPERM;
  if (code === "EXDEV" || msg.includes("EXDEV") || msg.includes("cross-device")) return FALLBACK_REASONS.EXDEV;
  if (code === "ENOSPC" || msg.includes("ENOSPC") || msg.includes("no space")) return FALLBACK_REASONS.ENOSPC;
  if (code === "EMLINK" || msg.includes("EMLINK") || msg.includes("too many links")) return FALLBACK_REASONS.EMLINK;
  return FALLBACK_REASONS.UNKNOWN;
}

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

function createLimiter(maxConcurrent) {
  const concurrency = Math.max(1, Number(maxConcurrent) || 1);
  let active = 0;
  const queue = [];

  const pump = () => {
    if (active >= concurrency) return;
    const next = queue.shift();
    if (!next) return;
    active += 1;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
}

export async function materializeTree(srcDir, destDir, opts = {}) {
  const {
    linkStrategy = "auto", // auto|hardlink|copy
    stats = null,
    fsConcurrency = 16,
    __limiter = null
  } = opts;
  const limiter = __limiter ?? createLimiter(fsConcurrency);
  await fs.mkdir(destDir, { recursive: true });

  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const tasks = [];
  for (const ent of entries) {
    if (ent.name === "node_modules") continue; // never vendor nested node_modules from tarball
    if (ent.name === ".better_extracted") continue;
    const src = path.join(srcDir, ent.name);
    const dst = path.join(destDir, ent.name);

    if (ent.isDirectory()) {
      if (stats) {
        stats.directories = Number(stats.directories ?? 0) + 1;
      }
      // Recurse without consuming limiter slots to avoid directory-task deadlocks
      // (a parent task waiting for children while still holding a slot).
      tasks.push(materializeTree(src, dst, { ...opts, fsConcurrency, __limiter: limiter }));
      continue;
    }

    if (ent.isSymbolicLink()) {
      tasks.push(
        limiter(async () => {
          const link = await fs.readlink(src);
          await fs.symlink(link, dst);
          if (stats) {
            stats.symlinks = Number(stats.symlinks ?? 0) + 1;
          }
        })
      );
      continue;
    }

    if (ent.isFile()) {
      tasks.push(
        limiter(async () => {
          if (stats) {
            stats.files = Number(stats.files ?? 0) + 1;
          }
          if (linkStrategy === "copy") {
            await fs.copyFile(src, dst);
            if (stats) {
              stats.filesCopied = Number(stats.filesCopied ?? 0) + 1;
            }
            return;
          }
          if (linkStrategy === "hardlink" || linkStrategy === "auto") {
            try {
              await fs.link(src, dst);
              if (stats) {
                stats.filesLinked = Number(stats.filesLinked ?? 0) + 1;
              }
              return;
            } catch (linkErr) {
              const fallbackCode = classifyLinkError(linkErr);
              if (stats) {
                stats.fallbackReasons = stats.fallbackReasons ?? {};
                stats.fallbackReasons[fallbackCode] = (stats.fallbackReasons[fallbackCode] ?? 0) + 1;
              }
              await fs.copyFile(src, dst);
              if (stats) {
                stats.filesCopied = Number(stats.filesCopied ?? 0) + 1;
                stats.linkFallbackCopies = Number(stats.linkFallbackCopies ?? 0) + 1;
                stats.lastFallbackCode = fallbackCode;
              }
              return;
            }
          }
          await fs.copyFile(src, dst);
          if (stats) {
            stats.filesCopied = Number(stats.filesCopied ?? 0) + 1;
          }
        })
      );
      continue;
    }
  }

  await Promise.all(tasks);
}

export async function materializeTreeWithRetry(srcDir, destDir, opts = {}) {
  const { maxRetries = 1, ...restOpts } = opts;
  const fsConcurrency = restOpts.fsConcurrency ?? 16;

  try {
    await materializeTree(srcDir, destDir, restOpts);
    return { ok: true, retried: false, attempts: 1 };
  } catch (err) {
    if (maxRetries <= 0) throw err;

    // Retry with reduced concurrency
    const reducedConcurrency = Math.max(1, Math.floor(fsConcurrency / 2));
    const retryOpts = { ...restOpts, fsConcurrency: reducedConcurrency };

    // Clean destination before retry
    await ensureEmptyDir(destDir);

    try {
      await materializeTree(srcDir, destDir, retryOpts);
      return { ok: true, retried: true, attempts: 2, reducedConcurrency, originalError: err?.message };
    } catch (retryErr) {
      throw retryErr;
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
