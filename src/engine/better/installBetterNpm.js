import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { readNpmLockfile, detectNonRootNodeModulesEntries, listWorkspacePackageEntries, iterNodeModulesPackages } from "./npmLockfile.js";
import { casKeyFromIntegrity, tarballPath, unpackedPath, ensureCasDirsForKey, writeTarballToCas } from "./cas.js";
import { verifyFileIntegrity } from "./ssri.js";
import { extractTgz } from "./tar.js";
import { splitLockfilePath, ensureEmptyDir, materializeTree, atomicReplaceDir } from "./materialize.js";
import { writeRootBinLinks } from "./bins.js";
import { runCommand } from "../../lib/spawn.js";

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

async function downloadToFile(url, destFile) {
  await fs.mkdir(path.dirname(destFile), { recursive: true });
  const tmp = `${destFile}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const client = url.startsWith("https://") ? https : http;
  await new Promise((resolve, reject) => {
    const req = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(res.headers.location, destFile).then(resolve, reject);
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

async function ensureTarballAvailable(layout, key, resolved, projectRoot) {
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
    await downloadToFile(resolved, dest);
    return { path: dest, reused: false };
  }
  throw new Error(`Unsupported resolved URL: ${resolved}`);
}

export async function installFromNpmLockfile(projectRoot, layout, opts = {}) {
  const {
    verify = "integrity-required", // integrity-required|best-effort
    linkStrategy = "auto", // auto|hardlink|copy
    scripts = "rebuild", // rebuild|off (Phase 3 default rebuild via npm)
    binLinks = "rootOnly"
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
  const stagingNm = path.join(projectRoot, `.better-staging-node_modules-${Date.now()}`);
  await ensureEmptyDir(stagingNm);

  const packagesByPath = new Map(); // installPath -> absPath
  const extracted = { reusedTarballs: 0, downloadedTarballs: 0, extractedUnpacked: 0, reusedUnpacked: 0 };
  const skipped = { platform: 0 };
  const packageCacheEntries = [];

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

    if (isLink) {
      const segments = splitLockfilePath(relPath);
      const destPkgDir = path.join(stagingNm, ...segments.slice(1)); // drop leading node_modules
      const targetAbs = resolveWorkspaceTargetAbs({ lock, projectRoot, relPath, meta, workspaceByName });
      await symlinkDir(targetAbs, destPkgDir);
      packagesByPath.set(relPath, destPkgDir);
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

    const key = integrity ? casKeyFromIntegrity(integrity) : null;
    if (!key) {
      throw new Error(`Unable to derive CAS key for ${relPath} (integrity missing/invalid).`);
    }

    const tar = await ensureTarballAvailable(layout, key, resolved, projectRoot);
    if (tar.reused) extracted.reusedTarballs += 1;
    else extracted.downloadedTarballs += 1;

    const pkgName = meta?.name ?? packageNameFromRelPath(relPath);
    const pkgVersion = meta?.version ?? null;
    packageCacheEntries.push({
      name: pkgName,
      version: pkgVersion,
      relPath,
      source: resolved,
      cacheHit: tar.reused,
      cacheMiss: !tar.reused,
      cas: {
        algorithm: key.algorithm,
        keyHex: key.hex
      }
    });

    const ver = await verifyFileIntegrity(tar.path, integrity, { required: verify === "integrity-required" });
    if (verify === "integrity-required" && !ver.ok) {
      throw new Error(`Integrity check failed for ${relPath} (${ver.algorithm})`);
    }

    const unpackDir = unpackedPath(layout, key);
    const extractRes = await extractTgz(tar.path, unpackDir);
    if (extractRes.reused) extracted.reusedUnpacked += 1;
    else extracted.extractedUnpacked += 1;

    // Support tarballs that extract to package/ or a source-specific top-level folder.
    const srcPkgDir = extractRes.packageDir;

    const segments = splitLockfilePath(relPath);
    const destPkgDir = path.join(stagingNm, ...segments.slice(1)); // drop leading node_modules
    await fs.mkdir(path.dirname(destPkgDir), { recursive: true });
    await materializeTree(srcPkgDir, destPkgDir, { linkStrategy });
    packagesByPath.set(relPath, destPkgDir);
  }

  // Atomically replace node_modules
  await atomicReplaceDir(stagingNm, path.join(projectRoot, "node_modules"));

  // Root .bin links (MVP) - must run after node_modules is in place.
  const installedPackagesByPath = new Map();
  for (const relPath of packagesByPath.keys()) {
    const segments = splitLockfilePath(relPath);
    installedPackagesByPath.set(relPath, path.join(projectRoot, "node_modules", ...segments.slice(1)));
  }
  await writeRootBinLinks(projectRoot, installedPackagesByPath, { linkMode: binLinks });

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
    extracted,
    skipped,
    packages: packageCacheEntries,
    scripts: scriptsResult,
    binLinks: { mode: binLinks }
  };
}
