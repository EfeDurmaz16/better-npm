import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export function defaultCacheRoot() {
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "better");
  }
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ??
      path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "better", "cache");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, "better");
  return path.join(os.homedir(), ".cache", "better");
}

export function getCacheRoot(overridePath) {
  return overridePath ? path.resolve(overridePath) : defaultCacheRoot();
}

export function cacheLayout(cacheRoot) {
  return {
    root: cacheRoot,
    stateFile: path.join(cacheRoot, "state.json"),
    runsDir: path.join(cacheRoot, "runs"),
    analysesDir: path.join(cacheRoot, "analyses"),
    tmpDir: path.join(cacheRoot, "tmp"),
    store: {
      root: path.join(cacheRoot, "store"),
      tarballsDir: path.join(cacheRoot, "store", "tarballs"),
      unpackedDir: path.join(cacheRoot, "store", "unpacked"),
      materializationsDir: path.join(cacheRoot, "store", "materializations"),
      tmpDir: path.join(cacheRoot, "store", "tmp")
    },
    pm: {
      npm: path.join(cacheRoot, "pm", "npm-cache"),
      pnpmStore: path.join(cacheRoot, "pm", "pnpm-store"),
      yarn: path.join(cacheRoot, "pm", "yarn-cache"),
      bun: path.join(cacheRoot, "pm", "bun-cache"),
      bunHome: path.join(cacheRoot, "pm", "bun-home")
    }
  };
}

async function assertDirWritable(dir) {
  const probe = path.join(dir, `.better-write-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await fs.writeFile(probe, "ok\n", { flag: "wx" });
  } finally {
    await fs.rm(probe, { force: true });
  }
}

export async function ensureCacheDirs(layout, opts = {}) {
  const { projectRootForFallback } = opts;
  try {
    await fs.mkdir(layout.root, { recursive: true });
    await fs.mkdir(layout.runsDir, { recursive: true });
    await fs.mkdir(layout.analysesDir, { recursive: true });
    await fs.mkdir(layout.tmpDir, { recursive: true });
    await fs.mkdir(layout.store.root, { recursive: true });
    await fs.mkdir(layout.store.tarballsDir, { recursive: true });
    await fs.mkdir(layout.store.unpackedDir, { recursive: true });
    await fs.mkdir(layout.store.materializationsDir, { recursive: true });
    await fs.mkdir(layout.store.tmpDir, { recursive: true });
    // Probe CAS algorithm directories early so we can fall back if the default cache root isn't writable
    // (e.g. sandboxed environments).
    await fs.mkdir(path.join(layout.store.tarballsDir, "sha512"), { recursive: true });
    await fs.mkdir(path.join(layout.store.unpackedDir, "sha512"), { recursive: true });
    await fs.mkdir(path.dirname(layout.pm.npm), { recursive: true });
    await fs.mkdir(layout.pm.npm, { recursive: true });
    await fs.mkdir(layout.pm.pnpmStore, { recursive: true });
    await fs.mkdir(layout.pm.yarn, { recursive: true });
    await fs.mkdir(layout.pm.bun, { recursive: true });
    await fs.mkdir(layout.pm.bunHome, { recursive: true });
    // Some sandboxes allow read but disallow writes outside a whitelist. mkdir() may "succeed"
    // if the directory already exists, but writes can still fail later. Probe writability now.
    await assertDirWritable(layout.runsDir);
    await assertDirWritable(layout.analysesDir);
    await assertDirWritable(layout.tmpDir);
    return layout;
  } catch (err) {
    const code = err?.code;
    if ((code === "EACCES" || code === "EPERM") && projectRootForFallback) {
      const fallbackRoot = path.join(path.resolve(projectRootForFallback), ".better", "cache");
      const fallback = cacheLayout(fallbackRoot);
      await fs.mkdir(fallback.root, { recursive: true });
      await fs.mkdir(fallback.runsDir, { recursive: true });
      await fs.mkdir(fallback.analysesDir, { recursive: true });
      await fs.mkdir(fallback.tmpDir, { recursive: true });
      await fs.mkdir(fallback.store.root, { recursive: true });
      await fs.mkdir(fallback.store.tarballsDir, { recursive: true });
      await fs.mkdir(fallback.store.unpackedDir, { recursive: true });
      await fs.mkdir(fallback.store.materializationsDir, { recursive: true });
      await fs.mkdir(fallback.store.tmpDir, { recursive: true });
      await fs.mkdir(path.join(fallback.store.tarballsDir, "sha512"), { recursive: true });
      await fs.mkdir(path.join(fallback.store.unpackedDir, "sha512"), { recursive: true });
      await fs.mkdir(path.dirname(fallback.pm.npm), { recursive: true });
      await fs.mkdir(fallback.pm.npm, { recursive: true });
      await fs.mkdir(fallback.pm.pnpmStore, { recursive: true });
      await fs.mkdir(fallback.pm.yarn, { recursive: true });
      await fs.mkdir(fallback.pm.bun, { recursive: true });
      await fs.mkdir(fallback.pm.bunHome, { recursive: true });
      await assertDirWritable(fallback.runsDir);
      await assertDirWritable(fallback.analysesDir);
      await assertDirWritable(fallback.tmpDir);
      return fallback;
    }
    throw err;
  }
}

export async function loadState(layout) {
  try {
    const raw = await fs.readFile(layout.stateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("bad state");
    return {
      schemaVersion: 2,
      projects: {},
      analysesIndex: {},
      cacheMetrics: {
        installRuns: 0,
        cacheHits: 0,
        cacheMisses: 0,
        lastUpdatedAt: null
      },
      cachePackages: {},
      cacheEntries: {},
      materializationIndex: {},
      gc: {
        maxSizeBytes: 20 * 1024 * 1024 * 1024,
        maxAgeDays: 30,
        lruWindowDays: 14,
        lastRunAt: null,
        lastFreedBytes: 0
      },
      ...parsed
    };
  } catch {
    return {
      schemaVersion: 2,
      projects: {},
      analysesIndex: {},
      cacheMetrics: {
        installRuns: 0,
        cacheHits: 0,
        cacheMisses: 0,
        lastUpdatedAt: null
      },
      cachePackages: {},
      cacheEntries: {},
      materializationIndex: {},
      gc: {
        maxSizeBytes: 20 * 1024 * 1024 * 1024,
        maxAgeDays: 30,
        lruWindowDays: 14,
        lastRunAt: null,
        lastFreedBytes: 0
      }
    };
  }
}

export async function saveState(layout, state) {
  const next = {
    schemaVersion: 2,
    projects: {},
    analysesIndex: {},
    cacheMetrics: {
      installRuns: 0,
      cacheHits: 0,
      cacheMisses: 0,
      lastUpdatedAt: null
    },
    cachePackages: {},
    cacheEntries: {},
    materializationIndex: {},
    gc: {
      maxSizeBytes: 20 * 1024 * 1024 * 1024,
      maxAgeDays: 30,
      lruWindowDays: 14,
      lastRunAt: null,
      lastFreedBytes: 0
    },
    ...state
  };
  await fs.writeFile(layout.stateFile, `${JSON.stringify(next, null, 2)}\n`);
}
