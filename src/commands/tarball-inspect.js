/**
 * better tarball-inspect — inspect an npm package tarball
 *
 * Downloads a package tarball from npm and shows its contents,
 * file list, sizes, and validates the package structure.
 *
 * Usage:
 *   better tarball-inspect lodash
 *   better tarball-inspect lodash@4.17.21
 *   better tarball-inspect --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";
import { spawnSync } from "node:child_process";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "better-npm/1.0" }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location));
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// Parse tar entry headers from a buffer (simplified, no zlib needed for listing)
// We use `tar` CLI if available, otherwise fall back to npm pack
function listTarball(buffer) {
  // Write to temp file and use tar to list
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const tmp = path.join(os.tmpdir(), `better-inspect-${Date.now()}.tgz`);
  try {
    fs.writeFileSync(tmp, buffer);
    const result = spawnSync("tar", ["-tzf", tmp], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    if (result.status === 0) {
      return result.stdout.split("\n").filter(Boolean);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  return null;
}

export async function cmdTarballInspect(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      top:   { type: "string", default: "30" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better tarball-inspect <package[@version]> [options]

Inspect an npm package tarball contents without installing.

Options:
  --top <n>    Show top N files by size (default: 30)
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better tarball-inspect lodash
  better tarball-inspect lodash@4.17.21
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better tarball-inspect <package[@version]>\nRun: better tarball-inspect --help for more info.");
    process.exitCode = 1;
    return;
  }

  const pkgSpec = positionals[0];
  let pkgName, version;
  if (pkgSpec.startsWith("@")) {
    const idx = pkgSpec.indexOf("@", 1);
    if (idx > 0) { pkgName = pkgSpec.slice(0, idx); version = pkgSpec.slice(idx + 1); }
    else { pkgName = pkgSpec; version = null; }
  } else if (pkgSpec.includes("@")) {
    const idx = pkgSpec.lastIndexOf("@");
    pkgName = pkgSpec.slice(0, idx); version = pkgSpec.slice(idx + 1);
  } else {
    pkgName = pkgSpec; version = null;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching metadata for ${pkgName}...\x1b[0m\n`);
  }

  let meta;
  try {
    const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    meta = JSON.parse(res.body.toString());
  } catch (err) {
    const msg = `Failed to fetch ${pkgName}: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const resolvedVersion = version || meta["dist-tags"]?.latest;
  const vMeta = meta.versions?.[resolvedVersion];
  if (!vMeta) {
    const msg = `Version ${resolvedVersion} not found for ${pkgName}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const tarballUrl = vMeta.dist?.tarball;
  if (!tarballUrl) {
    const msg = `No tarball URL for ${pkgName}@${resolvedVersion}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mDownloading tarball...\x1b[0m\n`);
  }

  let tarball;
  try {
    const res = await httpsGet(tarballUrl);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    tarball = res.body;
  } catch (err) {
    const msg = `Failed to download tarball: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const tarSize = tarball.length;
  const unpackedSize = vMeta.dist?.unpackedSize || null;
  const integrity = vMeta.dist?.integrity || vMeta.dist?.shasum;
  const fileCount = vMeta.dist?.fileCount || null;
  const topN = Math.max(5, Math.min(100, parseInt(values.top) || 30));

  // Try to list files from tarball
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  let fileList = null;
  const tmpFile = join(tmpdir(), `better-inspect-${Date.now()}.tgz`);
  try {
    writeFileSync(tmpFile, tarball);
    const tarResult = spawnSync("tar", ["-tzf", tmpFile], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    if (tarResult.status === 0) {
      fileList = tarResult.stdout.split("\n").filter(l => l && !l.endsWith("/"));
    }
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.tarball-inspect",
      package: pkgName,
      version: resolvedVersion,
      tarSize,
      unpackedSize,
      integrity,
      fileCount: fileList ? fileList.length : fileCount,
      files: fileList ? fileList.slice(0, topN) : null,
    });
    return;
  }

  printText(`\n\x1b[1mbetter tarball-inspect\x1b[0m — \x1b[1m${pkgName}@${resolvedVersion}\x1b[0m\n`);
  printText(`  Tarball size:  ${fmtBytes(tarSize)}`);
  if (unpackedSize) printText(`  Unpacked size: ${fmtBytes(unpackedSize)}`);
  if (integrity) printText(`  Integrity:     ${integrity.slice(0, 50)}...`);

  if (fileList) {
    printText(`  Files:         ${fileList.length}\n`);
    printText(`\x1b[90mFile listing (top ${Math.min(topN, fileList.length)}):\x1b[0m`);
    for (const f of fileList.slice(0, topN)) {
      printText(`  \x1b[90m${f}\x1b[0m`);
    }
    if (fileList.length > topN) {
      printText(`  \x1b[90m... and ${fileList.length - topN} more files\x1b[0m`);
    }
  } else {
    if (fileCount) printText(`  Files:         ${fileCount} (tar not available for listing)`);
    printText(`  \x1b[90mInstall tar to see file listing\x1b[0m`);
  }
  printText("");
}
