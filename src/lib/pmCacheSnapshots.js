import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeJsonAtomic } from "./cache.js";

export function pmCacheSnapshotKey(pmCacheDir) {
  return path.resolve(pmCacheDir);
}

function snapshotFile(layout, key) {
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(layout.root, "pm-cache-snapshots", `${digest}.json`);
}

async function readSnapshot(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    // Optional measurements can be rebuilt. They never authorize cache reuse.
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function loadPmCacheSnapshotStore(layout, pmCacheDir) {
  const key = pmCacheSnapshotKey(pmCacheDir);
  const file = snapshotFile(layout, key);
  const record = await readSnapshot(file);
  if (record?.schemaVersion === 1 && record.key === key && record.sample) {
    return { file, snapshots: { [key]: record.sample } };
  }
  // Read-only migration: retain the old index so older versions can still use it.
  const legacy = await readSnapshot(path.join(layout.root, "pm-cache-snapshots.json"));
  return { file, snapshots: legacy?.snapshots?.[key] ? { [key]: legacy.snapshots[key] } : {} };
}

export async function persistPmCacheSnapshot(layout, store, pmCacheDir, sample) {
  if (!sample?.ok) return;
  const key = pmCacheSnapshotKey(pmCacheDir);
  const entry = {
    logicalBytes: Number(sample.logicalBytes ?? 0),
    physicalBytes: Number(sample.physicalBytes ?? 0),
    updatedAt: new Date().toISOString()
  };
  await writeJsonAtomic(snapshotFile(layout, key), { schemaVersion: 1, key, sample: entry });
  store.snapshots[key] = entry;
}
