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

