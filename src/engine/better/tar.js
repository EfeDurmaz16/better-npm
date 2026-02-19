import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageDir(destDir) {
  const explicit = path.join(destDir, "package");
  if (await exists(path.join(explicit, "package.json"))) return explicit;

  if (await exists(path.join(destDir, "package.json"))) return destDir;

  const entries = await fs.readdir(destDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  if (dirs.length === 1) {
    const candidate = path.join(destDir, dirs[0]);
    if (await exists(path.join(candidate, "package.json"))) return candidate;
  }
  return null;
}

// Parse a null-terminated ASCII string from a tar header field
function parseStr(buf, offset, len) {
  let end = offset;
  const limit = offset + len;
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString("utf8", offset, end);
}

// Parse an octal number from a tar header field
function parseOctal(buf, offset, len) {
  if (buf[offset] & 0x80) {
    let val = 0;
    for (let i = offset + len - 8; i < offset + len; i++) {
      val = val * 256 + buf[i];
    }
    return val;
  }
  const str = parseStr(buf, offset, len).trim();
  if (str.length === 0) return 0;
  return parseInt(str, 8) || 0;
}

function parsePaxHeaders(data) {
  const result = {};
  let pos = 0;
  while (pos < data.length) {
    const spaceIdx = data.indexOf(" ", pos);
    if (spaceIdx < 0) break;
    const len = parseInt(data.slice(pos, spaceIdx), 10);
    if (!len || isNaN(len)) break;
    const record = data.slice(spaceIdx + 1, pos + len - 1);
    const eqIdx = record.indexOf("=");
    if (eqIdx > 0) {
      result[record.slice(0, eqIdx)] = record.slice(eqIdx + 1);
    }
    pos += len;
  }
  return result;
}

/**
 * Extract entries from a decompressed tar buffer.
 * npm tarballs are typically small (<5MB decompressed), so buffering is fine.
 */
async function extractTarBuffer(buf, destDir) {
  let pos = 0;
  let gnuLongName = null;
  let gnuLongLink = null;
  let paxHeaders = {};
  const createdDirs = new Set();

  async function ensureDir(dir) {
    if (createdDirs.has(dir)) return;
    await fs.mkdir(dir, { recursive: true });
    createdDirs.add(dir);
  }

  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);

    // Check for end-of-archive (zero block)
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) { pos += 512; continue; }

    let name = parseStr(header, 0, 100);
    const mode = parseOctal(header, 100, 8);
    const size = parseOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    let linkname = parseStr(header, 157, 100);
    const prefix = parseStr(header, 345, 155);

    if (prefix) name = prefix + "/" + name;
    if (gnuLongName) { name = gnuLongName; gnuLongName = null; }
    if (gnuLongLink) { linkname = gnuLongLink; gnuLongLink = null; }
    if (paxHeaders.path) { name = paxHeaders.path; }
    if (paxHeaders.linkpath) { linkname = paxHeaders.linkpath; }
    paxHeaders = {};

    pos += 512;
    const dataEnd = pos + size;
    const paddedEnd = pos + (size > 0 ? size + ((512 - (size % 512)) % 512) : 0);

    // Handle meta entries (GNU long name/link, pax)
    if (typeflag === "L") {
      gnuLongName = buf.toString("utf8", pos, dataEnd).replace(/\0+$/, "");
      pos = paddedEnd;
      continue;
    }
    if (typeflag === "K") {
      gnuLongLink = buf.toString("utf8", pos, dataEnd).replace(/\0+$/, "");
      pos = paddedEnd;
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      paxHeaders = parsePaxHeaders(buf.toString("utf8", pos, dataEnd));
      pos = paddedEnd;
      continue;
    }

    // Sanitize path
    const clean = name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean || clean.includes("..")) { pos = paddedEnd; continue; }

    const dest = path.join(destDir, clean);

    // Directory
    if (typeflag === "5") {
      await ensureDir(dest);
      pos = paddedEnd;
      continue;
    }

    // Symlink
    if (typeflag === "2") {
      await ensureDir(path.dirname(dest));
      try { await fs.rm(dest, { force: true }); } catch {}
      await fs.symlink(linkname, dest);
      pos = paddedEnd;
      continue;
    }

    // Regular file (typeflag "0", "\0", or "")
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      await ensureDir(path.dirname(dest));
      const data = buf.subarray(pos, dataEnd);
      await fs.writeFile(dest, data);
      if (mode) {
        try { await fs.chmod(dest, mode); } catch {}
      }
      pos = paddedEnd;
      continue;
    }

    // Skip unknown types
    pos = paddedEnd;
  }
}

/**
 * Decompress a .tgz into a buffer, then extract.
 */
function decompressToBuffer(tgzPath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const gunzip = createGunzip();
    const source = fssync.createReadStream(tgzPath);
    source.pipe(gunzip);
    gunzip.on("data", (chunk) => chunks.push(chunk));
    gunzip.on("end", () => resolve(Buffer.concat(chunks)));
    gunzip.on("error", reject);
    source.on("error", reject);
  });
}

/**
 * Pure-JS .tgz extraction. Replaces subprocess `tar -xzf`.
 */
export async function extractTarball(tgzPath, destDir) {
  const tarBuf = await decompressToBuffer(tgzPath);
  await extractTarBuffer(tarBuf, destDir);
}

/**
 * Streaming extraction from a readable stream (for download-to-extract pipeline).
 */
export async function extractTarballStream(readableStream, destDir) {
  const chunks = [];
  const gunzip = createGunzip();
  await new Promise((resolve, reject) => {
    readableStream.pipe(gunzip);
    gunzip.on("data", (chunk) => chunks.push(chunk));
    gunzip.on("end", resolve);
    gunzip.on("error", reject);
    readableStream.on("error", reject);
  });
  await extractTarBuffer(Buffer.concat(chunks), destDir);
}

export { extractTarBuffer };

export async function extractTgz(tgzPath, destDir) {
  const marker = path.join(destDir, ".better_extracted");
  await fs.mkdir(destDir, { recursive: true });

  const hasMarker = await exists(marker);
  const detectedBefore = await detectPackageDir(destDir);
  if (hasMarker && detectedBefore) {
    return { ok: true, reused: true, packageDir: detectedBefore };
  }
  if (hasMarker && !detectedBefore) {
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.mkdir(destDir, { recursive: true });
  }

  await extractTarball(tgzPath, destDir);
  const detectedAfter = await detectPackageDir(destDir);
  if (!detectedAfter) {
    throw new Error(`tar extract missing package root for ${tgzPath}`);
  }
  await fs.writeFile(marker, "ok\n");
  return { ok: true, reused: false, packageDir: detectedAfter };
}
