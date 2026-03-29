import fs from "node:fs/promises";
import path from "node:path";
import { parseIntegrity, toHexFromBase64 } from "./ssri.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function casKeyFromIntegrity(integrity) {
  const parts = parseIntegrity(integrity);
  const sha512 = parts.find((p) => p.algorithm === "sha512");
  const chosen = sha512 ?? parts[0];
  if (!chosen) return null;
  const hex = toHexFromBase64(chosen.base64);
  return { algorithm: chosen.algorithm, hex };
}

export function tarballPath(layout, key) {
  const a = key.hex.slice(0, 2);
  const b = key.hex.slice(2, 4);
  return path.join(layout.store.tarballsDir, key.algorithm, a, b, `${key.hex}.tgz`);
}

export function unpackedPath(layout, key) {
  const a = key.hex.slice(0, 2);
  const b = key.hex.slice(2, 4);
  return path.join(layout.store.unpackedDir, key.algorithm, a, b, key.hex);
}

export async function ensureCasDirsForKey(layout, key) {
  await fs.mkdir(path.dirname(tarballPath(layout, key)), { recursive: true });
  await fs.mkdir(unpackedPath(layout, key), { recursive: true });
}

export async function writeTarballToCas(layout, key, srcFilePath) {
  const dest = tarballPath(layout, key);
  if (await exists(dest)) return { ok: true, path: dest, reused: true };
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = path.join(layout.store.tmpDir, `tar-${Date.now()}-${Math.random().toString(16).slice(2)}.tgz`);
  await fs.copyFile(srcFilePath, tmp);
  await fs.rename(tmp, dest);
  return { ok: true, path: dest, reused: false };
}

export function manifestPath(layout) {
  return path.join(layout.store.root ?? path.dirname(layout.store.tarballsDir), "manifest.json");
}

export async function readManifest(layout) {
  const mp = manifestPath(layout);
  try {
    const raw = await fs.readFile(mp, "utf8");
    return JSON.parse(raw);
  } catch {
    return { version: 1, blobs: {}, refCounts: {} };
  }
}

export async function writeManifest(layout, manifest) {
  const mp = manifestPath(layout);
  await fs.mkdir(path.dirname(mp), { recursive: true });
  const tmp = `${mp}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n");
  await fs.rename(tmp, mp);
}

export async function incrementRefCount(layout, key, projectId) {
  const manifest = await readManifest(layout);
  const hexKey = key.hex;
  if (!manifest.refCounts[hexKey]) {
    manifest.refCounts[hexKey] = { count: 0, projects: {} };
  }
  manifest.refCounts[hexKey].count += 1;
  manifest.refCounts[hexKey].projects[projectId] = new Date().toISOString();

  if (!manifest.blobs[hexKey]) {
    manifest.blobs[hexKey] = {
      algorithm: key.algorithm,
      hex: hexKey,
      addedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString()
    };
  } else {
    manifest.blobs[hexKey].lastAccessedAt = new Date().toISOString();
  }

  await writeManifest(layout, manifest);
  return manifest.refCounts[hexKey];
}

export async function decrementRefCount(layout, key, projectId) {
  const manifest = await readManifest(layout);
  const hexKey = key.hex;
  if (!manifest.refCounts[hexKey]) return { count: 0, projects: {} };

  manifest.refCounts[hexKey].count = Math.max(0, manifest.refCounts[hexKey].count - 1);
  delete manifest.refCounts[hexKey].projects[projectId];

  await writeManifest(layout, manifest);
  return manifest.refCounts[hexKey];
}

export async function getCasInventory(layout) {
  const manifest = await readManifest(layout);
  const blobCount = Object.keys(manifest.blobs).length;
  const totalRefCount = Object.values(manifest.refCounts).reduce((sum, rc) => sum + (rc.count ?? 0), 0);
  const orphanedBlobs = Object.keys(manifest.blobs).filter(hex => {
    const rc = manifest.refCounts[hex];
    return !rc || rc.count === 0;
  });

  return {
    version: manifest.version,
    blobCount,
    totalRefCount,
    orphanedBlobCount: orphanedBlobs.length,
    orphanedBlobs
  };
}

