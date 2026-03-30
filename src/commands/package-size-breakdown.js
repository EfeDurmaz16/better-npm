/**
 * better package-size-breakdown — show size breakdown of a package
 *
 * Fetches a package from the npm registry and shows which files contribute
 * most to the install size, similar to bundlephobia.
 *
 * Usage:
 *   better package-size-breakdown <package>
 *   better package-size-breakdown <package>@<version>
 *   better package-size-breakdown --json <package>
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";
import zlib from "node:zlib";
import { promisify } from "node:util";
import path from "node:path";

const gunzip = promisify(zlib.gunzip);

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "better-npm/1.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function fmtBytes(b) {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

function bar(size, max, width = 20) {
  const pct = Math.min(size / Math.max(max, 1), 1);
  const filled = Math.round(pct * width);
  const color = pct > 0.5 ? "\x1b[31m" : pct > 0.25 ? "\x1b[33m" : "\x1b[36m";
  return `${color}${"█".repeat(filled)}${"░".repeat(width - filled)}\x1b[0m`;
}

function parseTarEntry(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.slice(offset, offset + 512);
    const nameRaw = header.slice(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeStr = header.slice(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = header.slice(156, 157).toString("ascii");
    if (!nameRaw) break;
    if (typeFlag !== "5") { // not directory
      entries.push({ name: nameRaw, size });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export async function cmdPackageSizeBreakdown(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      top:   { type: "string", default: "15" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better package-size-breakdown <package[@version]> [options]

Show size breakdown of files inside an npm package.

Options:
  --top <n>    Show top N largest files (default: 15)
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better package-size-breakdown lodash
  better package-size-breakdown react@18.2.0
`);
    return;
  }

  const pkgArg = positionals[0];
  if (!pkgArg) {
    printText("Error: Package name required. Usage: better package-size-breakdown <package>");
    process.exitCode = 1;
    return;
  }

  // Parse package@version
  const atIdx = pkgArg.lastIndexOf("@");
  const pkgName = atIdx > 0 ? pkgArg.slice(0, atIdx) : pkgArg;
  const pkgVersion = atIdx > 0 ? pkgArg.slice(atIdx + 1) : "latest";

  if (!values.json) {
    printText(`\n\x1b[1mbetter package-size-breakdown\x1b[0m\n`);
    process.stderr.write(`\x1b[90mFetching ${pkgName}@${pkgVersion}...\x1b[0m\n`);
  }

  // Get metadata to find tarball URL
  let tarballUrl, resolvedVersion;
  try {
    const metaUrl = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}`;
    const { status, body } = await httpGet(metaUrl);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const meta = JSON.parse(body.toString("utf8"));
    resolvedVersion = pkgVersion === "latest" ? meta["dist-tags"]?.latest : pkgVersion;
    tarballUrl = meta.versions?.[resolvedVersion]?.dist?.tarball;
    if (!tarballUrl) throw new Error(`Version ${resolvedVersion} not found`);
  } catch (e) {
    const msg = `Cannot fetch package metadata: ${e.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // Download tarball
  let entries;
  try {
    const { status, body } = await httpGet(tarballUrl);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const decompressed = await gunzip(body);
    entries = parseTarEntry(decompressed);
  } catch (e) {
    const msg = `Cannot download/parse tarball: ${e.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // Group by extension
  const byExt = new Map();
  let totalSize = 0;
  for (const e of entries) {
    totalSize += e.size;
    const ext = path.extname(e.name).toLowerCase() || "(no ext)";
    const prev = byExt.get(ext) || { count: 0, size: 0 };
    byExt.set(ext, { count: prev.count + 1, size: prev.size + e.size });
  }

  // Top files by size
  const topN = parseInt(values.top, 10) || 15;
  const topFiles = entries.sort((a, b) => b.size - a.size).slice(0, topN);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.package-size-breakdown",
      package: pkgName,
      version: resolvedVersion,
      totalFiles: entries.length,
      totalSize,
      topFiles: topFiles.map(f => ({ name: f.name, size: f.size })),
      byExtension: Object.fromEntries(
        [...byExt.entries()].sort((a, b) => b[1].size - a[1].size)
      ),
    });
    return;
  }

  printText(`  Package: \x1b[1m${pkgName}@${resolvedVersion}\x1b[0m`);
  printText(`  Total: \x1b[1m${fmtBytes(totalSize)}\x1b[0m in ${entries.length} files\n`);

  printText(`  \x1b[1mTop ${topFiles.length} largest files:\x1b[0m`);
  for (const f of topFiles) {
    const b = bar(f.size, topFiles[0].size);
    const name = f.name.replace(/^package\//, "");
    printText(`  ${b}  ${fmtBytes(f.size).padStart(8)}  ${name}`);
  }

  printText(`\n  \x1b[1mBy file type:\x1b[0m`);
  const extSorted = [...byExt.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8);
  for (const [ext, { count, size }] of extSorted) {
    const pct = ((size / totalSize) * 100).toFixed(1);
    printText(`  \x1b[90m${ext.padEnd(12)}\x1b[0m  ${fmtBytes(size).padStart(8)}  ${pct}%  (${count} files)`);
  }
  printText("");
}
