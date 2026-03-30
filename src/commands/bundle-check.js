/**
 * better bundle-check — bundle size impact analysis
 *
 * Estimates the bundle size impact of packages by reading
 * package metadata (dist sizes, gzip estimates from bundlephobia).
 * Works offline using package dist information + minification estimates.
 *
 * Usage:
 *   better bundle-check                  # check all prod deps
 *   better bundle-check lodash express   # check specific packages
 *   better bundle-check --threshold 50   # warn if pkg > 50KB
 *   better bundle-check --bundlephobia   # fetch from bundlephobia API
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function fetchBundlephobia(name, version) {
  return new Promise((resolve) => {
    const pkg = version ? `${name}@${version}` : name;
    const url = `https://bundlephobia.com/api/size?package=${encodeURIComponent(pkg)}`;
    https.get(url, {
      headers: { "User-Agent": "better-npm/0.1", "Accept": "application/json" },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

async function estimateSizeFromDist(nmPath, name) {
  // Walk the package's dist/ or lib/ directory to estimate size
  const candidates = ["dist", "lib", "build", "src", "."];
  for (const dir of candidates) {
    const dirPath = path.join(nmPath, name, dir);
    try {
      let totalSize = 0;
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name);
        if ([".js", ".mjs", ".cjs"].includes(ext)) {
          const stat = await fs.stat(path.join(dirPath, entry.name));
          totalSize += stat.size;
        }
      }
      if (totalSize > 0) {
        // Rough gzip estimate: ~30% of original
        return { size: totalSize, gzip: Math.round(totalSize * 0.3), source: "dist" };
      }
    } catch {}
  }

  // Fall back to entire package size
  try {
    let total = 0;
    async function walkSize(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walkSize(full);
        else {
          const ext = path.extname(e.name);
          if ([".js", ".mjs", ".cjs"].includes(ext)) {
            try { total += (await fs.stat(full)).size; } catch {}
          }
        }
      }
    }
    await walkSize(path.join(nmPath, name));
    return { size: total, gzip: Math.round(total * 0.3), source: "walk" };
  } catch {
    return { size: 0, gzip: 0, source: "unknown" };
  }
}

export async function cmdBundleCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      threshold: { type: "string" },
      bundlephobia: { type: "boolean", default: false },
      "top-n": { type: "string", default: "20" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better bundle-check [packages...] [options]

Analyze bundle size impact of dependencies.

Options:
  --threshold N        Warn if estimated gzip > N KB
  --bundlephobia       Fetch accurate data from bundlephobia.com
  --top-n N            Show top N packages by size (default: 20)
  --json               Machine-readable output
  -h, --help           Show this help

Examples:
  better bundle-check
  better bundle-check lodash react
  better bundle-check --threshold 50
  better bundle-check --bundlephobia --top-n 10

Note: Without --bundlephobia, sizes are estimated from local files.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  try {
    await fs.access(nmPath);
  } catch {
    const msg = "node_modules not found. Run 'better install' first.";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const prodDeps = Object.keys(pkgJson.dependencies || {});
  const targetNames = positionals.length > 0 ? positionals : prodDeps;

  if (targetNames.length === 0) {
    const msg = "No production dependencies to check.";
    if (values.json) { printJson({ ok: true, results: [], message: msg }); } else { printText(msg); }
    return;
  }

  if (!values.json) {
    const src = values.bundlephobia ? "bundlephobia.com" : "local estimation";
    process.stderr.write(`\x1b[90mAnalyzing ${targetNames.length} packages via ${src}…\x1b[0m\n`);
  }

  const thresholdKb = values.threshold ? parseFloat(values.threshold) : null;
  const BATCH = values.bundlephobia ? 3 : 10;
  const results = [];

  // Get versions from lockfile
  let resolvedVersions = {};
  try {
    const lock = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
    for (const [pkgPath2, info] of Object.entries(lock.packages || {})) {
      if (!pkgPath2) continue;
      const name = pkgPath2.startsWith("node_modules/") ? pkgPath2.slice(13) : pkgPath2;
      if (name && !name.includes("/node_modules/") && info.version) {
        resolvedVersions[name] = info.version;
      }
    }
  } catch {}

  for (let i = 0; i < targetNames.length; i += BATCH) {
    const batch = targetNames.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (name) => {
      const version = resolvedVersions[name];

      if (values.bundlephobia) {
        const data = await fetchBundlephobia(name, version);
        if (data?.size !== undefined) {
          return {
            name,
            version: data.version || version || "?",
            size: data.size,
            gzip: data.gzip,
            source: "bundlephobia",
          };
        }
      }

      const est = await estimateSizeFromDist(nmPath, name);
      return {
        name,
        version: version || "?",
        size: est.size,
        gzip: est.gzip,
        source: est.source,
      };
    }));
    results.push(...batchResults);
  }

  // Sort by gzip size descending
  results.sort((a, b) => b.gzip - a.gzip);

  const topN = parseInt(values["top-n"]) || 20;
  const displayResults = results.slice(0, topN);

  const warnings = thresholdKb
    ? results.filter(r => r.gzip > thresholdKb * 1024)
    : [];

  const totalSize = results.reduce((s, r) => s + r.size, 0);
  const totalGzip = results.reduce((s, r) => s + r.gzip, 0);

  if (values.json) {
    printJson({
      ok: warnings.length === 0,
      kind: "better.bundle-check",
      results: displayResults,
      total: results.length,
      total_size_bytes: totalSize,
      total_gzip_bytes: totalGzip,
      warnings,
      threshold_kb: thresholdKb,
    });
    if (warnings.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter bundle-check\x1b[0m — top ${Math.min(topN, results.length)} packages by size\n`);

  const NAME_W = 32;
  const VER_W = 10;
  printText("\x1b[1m" + "Package".padEnd(NAME_W) + "Version".padEnd(VER_W) + "Size".padEnd(12) + "Gzip\x1b[0m");
  printText("\x1b[90m" + "─".repeat(NAME_W + VER_W + 24) + "\x1b[0m");

  for (const r of displayResults) {
    const overThreshold = thresholdKb && r.gzip > thresholdKb * 1024;
    const gzipStr = overThreshold
      ? `\x1b[31m${fmtBytes(r.gzip)}\x1b[0m`
      : fmtBytes(r.gzip);
    const note = r.source === "bundlephobia" ? "" : " \x1b[90m~\x1b[0m";
    printText(
      r.name.slice(0, NAME_W - 1).padEnd(NAME_W) +
      r.version.padEnd(VER_W) +
      fmtBytes(r.size).padEnd(12) +
      gzipStr + note
    );
  }

  printText("\x1b[90m" + "─".repeat(NAME_W + VER_W + 24) + "\x1b[0m");
  printText(`\x1b[90mTotal (${results.length} packages): ${fmtBytes(totalSize)} raw, ${fmtBytes(totalGzip)} estimated gzip\x1b[0m`);

  if (!values.bundlephobia) {
    printText(`\x1b[90m~ = local estimate. Use --bundlephobia for accurate sizes.\x1b[0m`);
  }

  if (warnings.length > 0) {
    printText(`\n\x1b[31m${warnings.length} package(s) exceed ${thresholdKb}KB gzip threshold:\x1b[0m`);
    for (const w of warnings) {
      printText(`  \x1b[31m✖\x1b[0m  ${w.name}@${w.version}  ${fmtBytes(w.gzip)}`);
    }
    process.exitCode = 1;
  }
}
