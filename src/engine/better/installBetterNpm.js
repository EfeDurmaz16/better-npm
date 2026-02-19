import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { readNpmLockfile, detectNonRootNodeModulesEntries, listWorkspacePackageEntries, iterNodeModulesPackages } from "./npmLockfile.js";
import { casKeyFromIntegrity, tarballPath, unpackedPath, ensureCasDirsForKey, writeTarballToCas } from "./cas.js";
import { verifyFileIntegrity, parseIntegrity } from "./ssri.js";
import { extractTgz, extractTarBuffer } from "./tar.js";
import { createGunzip } from "node:zlib";
import { splitLockfilePath, ensureEmptyDir, materializeTree, atomicReplaceDir, createLimiter } from "./materialize.js";
import { writeRootBinLinks } from "./bins.js";
import { runCommand } from "../../lib/spawn.js";
import { tryLoadNapiAddon, runBetterCoreFetchAndExtractNapi } from "../../lib/core.js";
import { ingestPackageToFileCas, materializeFromFileCas, hasFileCasManifest } from "./fileCas.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(u) {
  return typeof u === "string" && (u.startsWith("https://") || u.startsWith("http://"));
}

function isFileUrl(u) {
  return typeof u === "string" && u.startsWith("file:");
}

function fileUrlToPath(u) {
  // Allow file:./relative and file:/absolute
  const rest = u.slice("file:".length);
  if (rest.startsWith("//")) return rest.slice(1);
  return rest;
}

async function symlinkDir(targetAbs, linkAbs) {
  await fs.mkdir(path.dirname(linkAbs), { recursive: true });
  await fs.rm(linkAbs, { recursive: true, force: true });
  if (process.platform === "win32") {
    // "junction" works for directories without elevated privileges in most cases.
    await fs.symlink(targetAbs, linkAbs, "junction");
  } else {
    await fs.symlink(targetAbs, linkAbs, "dir");
  }
}

function isLikelyPathString(s) {
  return (
    typeof s === "string" &&
    (s.startsWith(".") ||
      s.startsWith("/") ||
      s.includes("/") ||
      s.includes("\\"))
  );
}

function resolveWorkspaceTargetAbs({ lock, projectRoot, relPath, meta, workspaceByName }) {
  const resolved = meta?.resolved;
  if (typeof resolved === "string" && resolved.length > 0) {
    if (isFileUrl(resolved)) {
      return path.resolve(projectRoot, fileUrlToPath(resolved));
    }
    // npm workspaces commonly use `resolved: "packages/foo"` (a key in lock.packages).
    if (lock?.packages && Object.prototype.hasOwnProperty.call(lock.packages, resolved)) {
      return path.resolve(projectRoot, resolved);
    }
    if (isLikelyPathString(resolved)) {
      return path.resolve(projectRoot, resolved);
    }
  }

  const name = meta?.name;
  if (typeof name === "string" && name.length > 0) {
    const hit = workspaceByName.get(name);
    if (hit && hit.length === 1) return path.resolve(projectRoot, hit[0]);
  }

  throw new Error(
    `Unable to resolve workspace link target for ${relPath}. ` +
      `Expected resolved to be a workspace path (e.g. "packages/foo") or file: URL, or a unique workspace entry matching name="${meta?.name ?? ""}".`
  );
}

function packageNameFromRelPath(relPath) {
  const segments = splitLockfilePath(relPath);
  const nm = segments.indexOf("node_modules");
  if (nm < 0 || nm + 1 >= segments.length) return null;
  const first = segments[nm + 1];
  if (!first) return null;
  if (first.startsWith("@")) {
    const second = segments[nm + 2];
    if (!second) return null;
    return `${first}/${second}`;
  }
  return first;
}

function normalizeConstraintList(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    const v = raw.trim();
    return v ? [v] : [];
  }
  return [];
}

function matchesPlatformConstraint(rawConstraint, runtimeValue) {
  const values = normalizeConstraintList(rawConstraint);
  if (values.length === 0) return true;

  const denied = new Set(values.filter((v) => v.startsWith("!")).map((v) => v.slice(1)));
  const allowed = values.filter((v) => !v.startsWith("!"));
  if (runtimeValue && denied.has(runtimeValue)) return false;
  if (allowed.length > 0) {
    if (!runtimeValue) return false;
    return allowed.includes(runtimeValue);
  }
  return true;
}

function detectRuntimeLibc() {
  if (process.platform !== "linux") return null;
  try {
    const header = process.report?.getReport?.()?.header ?? null;
    if (header?.glibcVersionRuntime || header?.glibcVersionCompiler) return "glibc";
    const shared = process.report?.getReport?.()?.sharedObjects;
    if (Array.isArray(shared) && shared.some((entry) => String(entry).toLowerCase().includes("musl"))) {
      return "musl";
    }
  } catch {
    // noop
  }
  return null;
}

function evaluatePlatformSupport(meta, runtime) {
  const reasons = [];

  if (!matchesPlatformConstraint(meta?.os, runtime.os)) {
    reasons.push(`os=${JSON.stringify(meta?.os)} runtime=${runtime.os}`);
  }
  if (!matchesPlatformConstraint(meta?.cpu, runtime.cpu)) {
    reasons.push(`cpu=${JSON.stringify(meta?.cpu)} runtime=${runtime.cpu}`);
  }

  const hasLibcConstraint = normalizeConstraintList(meta?.libc).length > 0;
  if (hasLibcConstraint && runtime.os === "linux" && !matchesPlatformConstraint(meta?.libc, runtime.libc)) {
    reasons.push(`libc=${JSON.stringify(meta?.libc)} runtime=${runtime.libc ?? "unknown"}`);
  }

  return {
    ok: reasons.length === 0,
    reasons
  };
}

async function detectExtractedPackageDir(destDir) {
  const explicit = path.join(destDir, "package");
  if (await exists(path.join(explicit, "package.json"))) return explicit;
  if (await exists(path.join(destDir, "package.json"))) return destDir;
  const entries = await fs.readdir(destDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && e.name !== ".better_extracted").map((e) => e.name).sort();
  if (dirs.length === 1) {
    const candidate = path.join(destDir, dirs[0]);
    if (await exists(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`tar extract missing package root in ${destDir}`);
}

function createSharedAgents() {
  return {
    https: new https.Agent({ keepAlive: true, maxSockets: 16 }),
    http: new http.Agent({ keepAlive: true, maxSockets: 16 })
  };
}

function destroySharedAgents(agents) {
  if (agents) {
    agents.https.destroy();
    agents.http.destroy();
  }
}

async function downloadToFile(url, destFile, agents) {
  await fs.mkdir(path.dirname(destFile), { recursive: true });
  const tmp = `${destFile}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const isHttps = url.startsWith("https://");
  const client = isHttps ? https : http;
  const agent = agents ? (isHttps ? agents.https : agents.http) : undefined;
  await new Promise((resolve, reject) => {
    const req = client.get(url, { agent }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(res.headers.location, destFile, agents).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`download failed: ${url} status=${res.statusCode}`));
        res.resume();
        return;
      }
      const file = fssync.createWriteStream(tmp);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
  await fs.rename(tmp, destFile);
}

/**
 * Streaming download+hash+extract in a single pass.
 * Tees the HTTP response into: (a) CAS file write, (b) hash computation, (c) gunzip->tar buffer.
 * Returns { tarPath, hashOk, extractedBuf } so caller can write to CAS and extract without re-reading.
 */
async function streamingDownloadVerifyExtract(url, casFileDest, integrity, unpackDir, agents) {
  await fs.mkdir(path.dirname(casFileDest), { recursive: true });
  await fs.mkdir(unpackDir, { recursive: true });
  const tmp = `${casFileDest}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const parsed = parseIntegrity(integrity);
  const sha512 = parsed.find((p) => p.algorithm === "sha512");
  const chosen = sha512 ?? parsed[0];
  if (!chosen) throw new Error("No supported integrity hash for streaming verify");

  const isHttps = url.startsWith("https://");
  const client = isHttps ? https : http;
  const agent = agents ? (isHttps ? agents.https : agents.http) : undefined;

  const result = await new Promise((resolve, reject) => {
    function doFetch(fetchUrl) {
      const fetchClient = fetchUrl.startsWith("https://") ? https : http;
      const fetchAgent = agents ? (fetchUrl.startsWith("https://") ? agents.https : agents.http) : undefined;
      const req = fetchClient.get(fetchUrl, { agent: fetchAgent }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          doFetch(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`download failed: ${fetchUrl} status=${res.statusCode}`));
          res.resume();
          return;
        }

        const hasher = crypto.createHash(chosen.algorithm);
        const fileOut = fssync.createWriteStream(tmp);
        const gunzip = createGunzip();
        const tarChunks = [];

        let fileFinished = false;
        let gunzipFinished = false;

        function maybeResolve() {
          if (fileFinished && gunzipFinished) {
            const digest = hasher.digest();
            const expected = Buffer.from(chosen.base64, "base64");
            resolve({
              hashOk: digest.equals(expected),
              algorithm: chosen.algorithm,
              tarBuf: Buffer.concat(tarChunks)
            });
          }
        }

        // Tee: each chunk goes to hasher, file, and gunzip
        res.on("data", (chunk) => {
          hasher.update(chunk);
          fileOut.write(chunk);
          gunzip.write(chunk);
        });
        res.on("end", () => {
          fileOut.end();
          gunzip.end();
        });
        res.on("error", reject);

        fileOut.on("finish", () => { fileFinished = true; fileOut.close(() => maybeResolve()); });
        fileOut.on("error", reject);

        gunzip.on("data", (chunk) => tarChunks.push(chunk));
        gunzip.on("end", () => { gunzipFinished = true; maybeResolve(); });
        gunzip.on("error", reject);
      });
      req.on("error", reject);
    }
    doFetch(url);
  });

  // Finalize CAS file
  await fs.rename(tmp, casFileDest);

  // Verify integrity
  if (!result.hashOk) {
    // Clean up the bad file
    await fs.rm(casFileDest, { force: true }).catch(() => {});
    throw new Error(`Integrity check failed during streaming download (${result.algorithm})`);
  }

  // Extract tar buffer to unpack dir
  await extractTarBuffer(result.tarBuf, unpackDir);

  return { tarPath: casFileDest, hashOk: true };
}

function verifiedMarkerPath(layout, key) {
  return tarballPath(layout, key) + ".verified";
}

async function isAlreadyVerified(layout, key) {
  return exists(verifiedMarkerPath(layout, key));
}

async function markVerified(layout, key) {
  const p = verifiedMarkerPath(layout, key);
  await fs.writeFile(p, "1\n").catch(() => {});
}

async function ensureTarballAvailable(layout, key, resolved, projectRoot, agents) {
  const dest = tarballPath(layout, key);
  if (await exists(dest)) return { path: dest, reused: true };
  await ensureCasDirsForKey(layout, key);

  if (isFileUrl(resolved)) {
    const fp = fileUrlToPath(resolved);
    const abs = path.resolve(projectRoot, fp);
    const wrote = await writeTarballToCas(layout, key, abs);
    return { path: wrote.path, reused: wrote.reused };
  }
  if (isHttpUrl(resolved)) {
    await downloadToFile(resolved, dest, agents);
    return { path: dest, reused: false };
  }
  throw new Error(`Unsupported resolved URL: ${resolved}`);
}

async function readPackageIdentity(packageDir) {
  try {
    const raw = await fs.readFile(path.join(packageDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return {
      name: typeof pkg?.name === "string" ? pkg.name : null,
      version: typeof pkg?.version === "string" ? pkg.version : null
    };
  } catch {
    return { name: null, version: null };
  }
}

async function isInstalledPackageUpToDate(destPkgDir, expectedName, expectedVersion) {
  const id = await readPackageIdentity(destPkgDir);
  return id.name === expectedName && id.version === expectedVersion;
}

async function listInstalledRootRelPaths(projectRoot) {
  const out = [];
  const root = path.join(projectRoot, "node_modules");
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const name = entry.name;
    if (!name || name === ".bin" || name.startsWith(".")) continue;
    if (name.startsWith("@") && entry.isDirectory()) {
      const scopeDir = path.join(root, name);
      let scoped = [];
      try {
        scoped = await fs.readdir(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      scoped.sort((a, b) => a.name.localeCompare(b.name));
      for (const pkg of scoped) {
        if (!pkg.name || pkg.name.startsWith(".")) continue;
        if (!pkg.isDirectory() && !pkg.isSymbolicLink()) continue;
        out.push(`node_modules/${name}/${pkg.name}`);
      }
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    out.push(`node_modules/${name}`);
  }
  return out;
}

export async function installFromNpmLockfile(projectRoot, layout, opts = {}) {
  const {
    verify = "integrity-required", // integrity-required|best-effort
    linkStrategy = "auto", // auto|hardlink|copy
    scripts = "rebuild", // rebuild|off (Phase 3 default rebuild via npm)
    binLinks = "rootOnly",
    incremental = true,
    fsConcurrency = 16
  } = opts;

  const lockfilePath = path.join(projectRoot, "package-lock.json");
  if (!(await exists(lockfilePath))) {
    const hints = [];
    if (await exists(path.join(projectRoot, "bun.lock")) || await exists(path.join(projectRoot, "bun.lockb"))) {
      hints.push("Found bun.lock/bun.lockb. Try: better install --engine bun");
    }
    if (await exists(path.join(projectRoot, "pnpm-lock.yaml"))) {
      hints.push("Found pnpm-lock.yaml. Try: better install --engine pm --pm pnpm");
    }
    if (await exists(path.join(projectRoot, "yarn.lock"))) {
      hints.push("Found yarn.lock. Try: better install --engine pm --pm yarn");
    }
    const hint = hints.length ? ` (${hints.join("; ")})` : "";
    throw new Error(`Engine 'better' requires package-lock.json (npm lockfile v2/v3).${hint}`);
  }

  const lock = await readNpmLockfile(lockfilePath);
  const runtimeTarget = {
    os: process.platform,
    cpu: process.arch,
    libc: detectRuntimeLibc()
  };
  if (detectNonRootNodeModulesEntries(lock)) {
    throw new Error(
      "This package-lock.json contains non-root install paths (e.g. 'packages/*/node_modules/*'). " +
        "Better engine currently only supports root 'node_modules/*' entries. (Phase 4.2)"
    );
  }

  const workspaceEntries = listWorkspacePackageEntries(lock);
  const workspaceByName = new Map(); // name -> [relPath]
  for (const it of workspaceEntries) {
    const n = it?.meta?.name;
    if (typeof n !== "string" || n.length === 0) continue;
    const arr = workspaceByName.get(n) || [];
    arr.push(it.relPath);
    workspaceByName.set(n, arr);
  }

  const items = iterNodeModulesPackages(lock);
  const installMode = incremental ? "incremental" : "full_replace";
  const stagingNm = installMode === "full_replace"
    ? path.join(projectRoot, `.better-staging-node_modules-${Date.now()}`)
    : null;
  if (stagingNm) {
    await ensureEmptyDir(stagingNm);
  } else {
    await fs.mkdir(path.join(projectRoot, "node_modules"), { recursive: true });
  }

  const packagesByPath = new Map(); // installPath -> absPath
  const desiredRelPaths = new Set();
  const extracted = { reusedTarballs: 0, downloadedTarballs: 0, extractedUnpacked: 0, reusedUnpacked: 0 };
  const skipped = { platform: 0 };
  const incrementalOps = {
    mode: installMode,
    kept: 0,
    relinked: 0,
    removed: 0,
    binRelinked: 0
  };
  const packageCacheEntries = [];
  const fileCasStats = { ingested: 0, ingestFailed: 0, totalFiles: 0, newFiles: 0, existingFiles: 0, totalBytes: 0 };
  const fileCasMaterializeStats = { linked: 0, copied: 0, symlinks: 0, fallback: 0 };

  const agents = createSharedAgents();
  try {

  // === Phase A: Filter & categorize all packages (fast, single pass) ===
  const toInstall = []; // items needing download/extract/materialize
  for (const it of items) {
    const relPath = it.relPath;
    const meta = it.meta || {};
    const resolved = meta.resolved;
    const integrity = meta.integrity;
    const isLink = meta.link === true;
    const support = evaluatePlatformSupport(meta, runtimeTarget);
    if (!support.ok) {
      if (meta.optional === true) {
        skipped.platform += 1;
        packageCacheEntries.push({
          name: meta?.name ?? packageNameFromRelPath(relPath),
          version: meta?.version ?? null,
          relPath,
          source: "platform-skip",
          cacheHit: false,
          cacheMiss: false,
          cas: null,
          skipped: {
            reason: "platform",
            details: support.reasons
          }
        });
        continue;
      }
      throw new Error(
        `Platform-incompatible non-optional package ${relPath}: ${support.reasons.join("; ")}`
      );
    }

    desiredRelPaths.add(relPath);
    if (isLink) {
      const segments = splitLockfilePath(relPath);
      const destPkgDir = installMode === "full_replace"
        ? path.join(stagingNm, ...segments.slice(1))
        : path.join(projectRoot, ...segments);
      const targetAbs = resolveWorkspaceTargetAbs({ lock, projectRoot, relPath, meta, workspaceByName });
      if (installMode === "incremental") {
        try {
          const current = await fs.readlink(destPkgDir);
          const currentAbs = path.resolve(path.dirname(destPkgDir), current);
          if (currentAbs === targetAbs) {
            packagesByPath.set(relPath, destPkgDir);
            incrementalOps.kept += 1;
            packageCacheEntries.push({
              name: meta?.name ?? packageNameFromRelPath(relPath),
              version: meta?.version ?? null,
              relPath,
              source: "workspace-link",
              cacheHit: false,
              cacheMiss: false,
              cas: null,
              skipped: { reason: "up_to_date_link" }
            });
            continue;
          }
        } catch {
          // proceed to rewrite link
        }
      }
      await symlinkDir(targetAbs, destPkgDir);
      packagesByPath.set(relPath, destPkgDir);
      if (installMode === "incremental") {
        incrementalOps.relinked += 1;
      }
      packageCacheEntries.push({
        name: meta?.name ?? packageNameFromRelPath(relPath),
        version: meta?.version ?? null,
        relPath,
        source: "workspace-link",
        cacheHit: false,
        cacheMiss: false,
        cas: null
      });
      continue;
    }

    if (!resolved || typeof resolved !== "string") {
      throw new Error(`Missing resolved for ${relPath}`);
    }

    if (!integrity || typeof integrity !== "string") {
      if (verify === "integrity-required") throw new Error(`Missing integrity for ${relPath}`);
    }

    const pkgName = meta?.name ?? packageNameFromRelPath(relPath);
    const pkgVersion = meta?.version ?? null;
    const segments = splitLockfilePath(relPath);
    const destPkgDir = installMode === "full_replace"
      ? path.join(stagingNm, ...segments.slice(1))
      : path.join(projectRoot, ...segments);
    if (installMode === "incremental") {
      const isUpToDate = await isInstalledPackageUpToDate(destPkgDir, pkgName, pkgVersion);
      if (isUpToDate) {
        packagesByPath.set(relPath, destPkgDir);
        incrementalOps.kept += 1;
        packageCacheEntries.push({
          name: pkgName,
          version: pkgVersion,
          relPath,
          source: "incremental-reuse",
          cacheHit: true,
          cacheMiss: false,
          cas: null,
          skipped: { reason: "up_to_date_package" }
        });
        continue;
      }
    }

    const key = integrity ? casKeyFromIntegrity(integrity) : null;
    if (!key) {
      throw new Error(`Unable to derive CAS key for ${relPath} (integrity missing/invalid).`);
    }

    toInstall.push({ relPath, meta, resolved, integrity, pkgName, pkgVersion, key, segments, destPkgDir });
  }

  // === Rust fast path: pre-populate CAS via NAPI if available ===
  if (toInstall.length > 0) {
    try {
      const napiResult = runBetterCoreFetchAndExtractNapi(lockfilePath, layout.root, {
        jobs: fsConcurrency
      });
      if (napiResult) {
        // Rust populated the CAS cache with tarballs + unpacked dirs;
        // JS Phase B+C below will find cache hits and skip HTTP downloads.
      }
    } catch {
      // NAPI addon unavailable or fetch failed — JS pipeline handles everything below.
    }
  }

  // === Phase B+C: Concurrent download+verify+extract (16 concurrent) ===
  // Cache hits: verify marker check + extract from disk
  // Cache misses: streaming download -> tee(hash, CAS write, gunzip->extract)
  const fetchExtractLimiter = createLimiter(16);
  const extractResults = await Promise.all(
    toInstall.map((item) =>
      fetchExtractLimiter(async () => {
        await ensureCasDirsForKey(layout, item.key);
        const tarDest = tarballPath(layout, item.key);
        const unpackDir = unpackedPath(layout, item.key);
        const tarExists = await exists(tarDest);

        if (tarExists) {
          // Cache hit path: skip verify if already verified, extract from disk
          extracted.reusedTarballs += 1;
          const skipVerify = await isAlreadyVerified(layout, item.key);
          if (!skipVerify) {
            const ver = await verifyFileIntegrity(tarDest, item.integrity, { required: verify === "integrity-required" });
            if (verify === "integrity-required" && !ver.ok) {
              throw new Error(`Integrity check failed for ${item.relPath} (${ver.algorithm})`);
            }
            if (ver.ok) await markVerified(layout, item.key);
          }
          const extractRes = await extractTgz(tarDest, unpackDir);
          if (extractRes.reused) extracted.reusedUnpacked += 1;
          else extracted.extractedUnpacked += 1;
          packageCacheEntries.push({
            name: item.pkgName, version: item.pkgVersion, relPath: item.relPath,
            source: item.resolved, cacheHit: true, cacheMiss: false,
            cas: { algorithm: item.key.algorithm, keyHex: item.key.hex }
          });
          return { ...item, extractRes };
        }

        // Cache miss: streaming download+verify+extract in single pass
        extracted.downloadedTarballs += 1;
        if (!isHttpUrl(item.resolved)) {
          // File URL or other: fall back to sequential path
          if (isFileUrl(item.resolved)) {
            const fp = fileUrlToPath(item.resolved);
            const abs = path.resolve(projectRoot, fp);
            await writeTarballToCas(layout, item.key, abs);
          } else {
            throw new Error(`Unsupported resolved URL: ${item.resolved}`);
          }
          const ver = await verifyFileIntegrity(tarDest, item.integrity, { required: verify === "integrity-required" });
          if (verify === "integrity-required" && !ver.ok) {
            throw new Error(`Integrity check failed for ${item.relPath} (${ver.algorithm})`);
          }
          if (ver.ok) await markVerified(layout, item.key);
          const extractRes = await extractTgz(tarDest, unpackDir);
          extracted.extractedUnpacked += 1;
          packageCacheEntries.push({
            name: item.pkgName, version: item.pkgVersion, relPath: item.relPath,
            source: item.resolved, cacheHit: false, cacheMiss: true,
            cas: { algorithm: item.key.algorithm, keyHex: item.key.hex }
          });
          return { ...item, extractRes };
        }

        // Streaming HTTP: download + hash + extract in one pass
        await fs.mkdir(unpackDir, { recursive: true });
        // Clear any stale extraction
        const marker = path.join(unpackDir, ".better_extracted");
        const hasMarker = await exists(marker);
        if (hasMarker) {
          await fs.rm(unpackDir, { recursive: true, force: true });
          await fs.mkdir(unpackDir, { recursive: true });
        }

        await streamingDownloadVerifyExtract(item.resolved, tarDest, item.integrity, unpackDir, agents);
        await markVerified(layout, item.key);
        await fs.writeFile(marker, "ok\n");

        // Detect package dir after extraction
        const extractRes = { ok: true, reused: false, packageDir: await detectExtractedPackageDir(unpackDir) };
        extracted.extractedUnpacked += 1;
        packageCacheEntries.push({
          name: item.pkgName, version: item.pkgVersion, relPath: item.relPath,
          source: item.resolved, cacheHit: false, cacheMiss: true,
          cas: { algorithm: item.key.algorithm, keyHex: item.key.hex }
        });
        return { ...item, extractRes };
      })
    )
  );

  // === Phase D-alt: File CAS ingest (if file CAS store available) ===
  const fileCasRoot = path.join(layout.root, "file-store");
  const ingestLimiter = createLimiter(fsConcurrency);
  await Promise.all(
    extractResults.map((item) =>
      ingestLimiter(async () => {
        try {
          const result = await ingestPackageToFileCas(
            fileCasRoot,
            item.key.algorithm,
            item.key.hex,
            item.extractRes.packageDir
          );
          fileCasStats.ingested++;
          fileCasStats.totalFiles += result.stats.totalFiles;
          fileCasStats.newFiles += result.stats.newFiles;
          fileCasStats.existingFiles += result.stats.existingFiles;
          fileCasStats.totalBytes += result.stats.totalBytes;
        } catch (err) {
          fileCasStats.ingestFailed++;
          // Non-fatal: fall back to regular materialize below
        }
      })
    )
  );

  // === Phase D-prep: Batch mkdir for all destination directories ===
  {
    const dirsNeeded = new Set();
    for (const item of extractResults) {
      // Collect parent dir of each destination and the destination itself
      dirsNeeded.add(path.dirname(item.destPkgDir));
      dirsNeeded.add(item.destPkgDir);
    }
    // Sort shortest-first so parents are created before children
    const sorted = [...dirsNeeded].sort((a, b) => a.length - b.length);
    // Incremental mode: remove stale destinations first (concurrently)
    if (installMode === "incremental") {
      const rmLimiter = createLimiter(fsConcurrency);
      await Promise.all(
        extractResults.map((item) =>
          rmLimiter(() => fs.rm(item.destPkgDir, { recursive: true, force: true }))
        )
      );
    }
    // Create all directories in batch
    const mkdirLimiter = createLimiter(fsConcurrency);
    await Promise.all(
      sorted.map((dir) => mkdirLimiter(() => fs.mkdir(dir, { recursive: true })))
    );
  }

  // === Phase D: Concurrent materialize (16 concurrent) ===
  // Try file CAS first, fall back to regular materializeTree if not available
  const materializeLimiter = createLimiter(fsConcurrency);
  await Promise.all(
    extractResults.map((item) =>
      materializeLimiter(async () => {
        // Try file CAS materialize first
        const casResult = await materializeFromFileCas(
          fileCasRoot,
          item.key.algorithm,
          item.key.hex,
          item.destPkgDir,
          { linkStrategy }
        );

        if (casResult.ok) {
          // File CAS materialize succeeded
          fileCasMaterializeStats.linked += casResult.stats.linked;
          fileCasMaterializeStats.copied += casResult.stats.copied;
          fileCasMaterializeStats.symlinks += casResult.stats.symlinks;
        } else {
          // File CAS manifest not found, fall back to regular materialize
          fileCasMaterializeStats.fallback++;
          const srcPkgDir = item.extractRes.packageDir;
          await materializeTree(srcPkgDir, item.destPkgDir, { linkStrategy, fsConcurrency });
        }

        packagesByPath.set(item.relPath, item.destPkgDir);
        if (installMode === "incremental") {
          incrementalOps.relinked += 1;
        }
      })
    )
  );

  if (installMode === "full_replace") {
    // Atomically replace node_modules
    await atomicReplaceDir(stagingNm, path.join(projectRoot, "node_modules"));
  } else {
    const installed = await listInstalledRootRelPaths(projectRoot);
    for (const relPath of installed) {
      if (desiredRelPaths.has(relPath)) continue;
      const segments = splitLockfilePath(relPath);
      await fs.rm(path.join(projectRoot, ...segments), { recursive: true, force: true });
      incrementalOps.removed += 1;
    }
  }

  // Root .bin links (MVP) - must run after node_modules is in place.
  const installedPackagesByPath = new Map();
  for (const relPath of packagesByPath.keys()) {
    const segments = splitLockfilePath(relPath);
    installedPackagesByPath.set(relPath, path.join(projectRoot, "node_modules", ...segments.slice(1)));
  }
  const bins = await writeRootBinLinks(projectRoot, installedPackagesByPath, {
    linkMode: binLinks,
    clean: installMode === "incremental"
  });
  incrementalOps.binRelinked = Number(bins?.linksWritten ?? 0);

  } finally {
    destroySharedAgents(agents);
  }

  // Scripts/native addons: Phase 3 uses npm rebuild fallback.
  let scriptsResult = null;
  if (scripts === "rebuild") {
    const rebuild = await runCommand(
      "npm",
      ["rebuild", "--no-audit", "--no-fund"],
      { cwd: projectRoot, passthroughStdio: true, captureLimitBytes: 1024 * 256 }
    );
    scriptsResult = {
      status: rebuild.exitCode === 0 ? "ok" : "failed",
      wallTimeMs: rebuild.wallTimeMs,
      exitCode: rebuild.exitCode,
      stderrTail: rebuild.stderrTail
    };
  } else {
    scriptsResult = { status: "off" };
  }

  return {
    ok: true,
    engine: "better",
    lockfile: { type: "npm", lockfileVersion: lock.lockfileVersion },
    verify,
    linkStrategy,
    fsConcurrency,
    extracted,
    skipped,
    incrementalOps,
    packages: packageCacheEntries,
    scripts: scriptsResult,
    binLinks: { mode: binLinks },
    fileCasStats: {
      ...fileCasStats,
      materialize: fileCasMaterializeStats
    }
  };
}
