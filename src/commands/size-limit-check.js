/**
 * better size-limit-check — check if package size is within limits
 *
 * Estimates the gzipped bundle size of your package's main entry
 * point and checks it against configured size limits (like size-limit tool).
 *
 * Usage:
 *   better size-limit-check
 *   better size-limit-check --limit 50kb
 *   better size-limit-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const gzip = promisify(zlib.gzip);

function parseSize(s) {
  if (!s) return 0;
  const m = String(s).toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(gb|mb|kb|b)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case "gb": return Math.round(n * 1024 * 1024 * 1024);
    case "mb": return Math.round(n * 1024 * 1024);
    case "kb": return Math.round(n * 1024);
    default:   return Math.round(n);
  }
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

export async function cmdSizeLimitCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      limit: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better size-limit-check [options]

Check package entry point size against configurable limits.

Options:
  --limit <s>   Size limit (e.g., 50kb, 1mb). Default: from package.json
  --json        Machine-readable output
  -h, --help    Show this help

Reads size limit from package.json "better.sizeLimit" or "size-limit" config.
Measures raw and gzipped size of the main/module/exports entry point.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter size-limit-check\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  // Find entry point
  const entryPoints = [];
  if (pkgJson.main) entryPoints.push({ field: "main", file: pkgJson.main });
  if (pkgJson.module) entryPoints.push({ field: "module", file: pkgJson.module });
  if (typeof pkgJson.exports === "string") entryPoints.push({ field: "exports", file: pkgJson.exports });
  else if (pkgJson.exports?.["."]?.default) entryPoints.push({ field: "exports[.]", file: pkgJson.exports["."].default });
  else if (pkgJson.exports?.["."]?.import) entryPoints.push({ field: "exports[.]", file: pkgJson.exports["."].import });

  // Also check dist/ index
  for (const distFile of ["dist/index.js", "dist/index.mjs", "lib/index.js"]) {
    try {
      await fs.access(path.join(projectRoot, distFile));
      if (!entryPoints.some(e => e.file === distFile)) {
        entryPoints.push({ field: "dist", file: distFile });
      }
    } catch {}
  }

  if (entryPoints.length === 0) {
    const msg = "No entry point found (main/module/exports/dist)";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m\n`); }
    return;
  }

  // Determine size limit
  const configuredLimit = values.limit
    ? parseSize(values.limit)
    : parseSize(pkgJson.better?.sizeLimit || pkgJson["size-limit"]?.[0]?.limit);

  const results = [];
  for (const ep of entryPoints.slice(0, 3)) {
    try {
      const filePath = path.resolve(projectRoot, ep.file);
      const content = await fs.readFile(filePath);
      const compressed = await gzip(content);
      const rawSize = content.length;
      const gzipSize = compressed.length;
      const withinLimit = configuredLimit ? gzipSize <= configuredLimit : true;

      results.push({ field: ep.field, file: ep.file, rawSize, gzipSize, withinLimit, limit: configuredLimit });
    } catch {
      results.push({ field: ep.field, file: ep.file, rawSize: null, gzipSize: null, withinLimit: true, error: "File not found" });
    }
  }

  const allOk = results.every(r => r.withinLimit);

  if (values.json) {
    printJson({ ok: allOk, kind: "better.size-limit-check", limit: configuredLimit, results });
    if (!allOk) process.exitCode = 1;
    return;
  }

  if (configuredLimit) {
    printText(`  Limit: ${fmtBytes(configuredLimit)}\n`);
  }

  for (const r of results) {
    if (r.error) {
      printText(`  \x1b[90m?\x1b[0m  ${r.field}: ${r.file}  \x1b[90m(not found)\x1b[0m`);
      continue;
    }
    const icon = r.withinLimit ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    const limitStr = configuredLimit ? (r.withinLimit ? ` \x1b[32m< ${fmtBytes(configuredLimit)}\x1b[0m` : ` \x1b[31m> ${fmtBytes(configuredLimit)}!\x1b[0m`) : "";
    printText(`  ${icon}  ${r.field}: ${r.file}`);
    printText(`       Raw: ${fmtBytes(r.rawSize)}  |  Gzipped: \x1b[1m${fmtBytes(r.gzipSize)}\x1b[0m${limitStr}`);
  }

  printText("");
  if (!allOk) {
    printText(`\x1b[31m✘ Bundle exceeds size limit. Optimize your build.\x1b[0m`);
    process.exitCode = 1;
  }
}
