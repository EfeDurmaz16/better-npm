/**
 * better pkg-compare-versions — compare multiple package versions
 *
 * Shows a side-by-side comparison of key metrics across versions
 * of an npm package: size, deps count, license, node requirements.
 *
 * Usage:
 *   better pkg-compare-versions lodash 4.17.21 4.17.20 3.10.1
 *   better pkg-compare-versions react --last 3
 *   better pkg-compare-versions express --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "better-npm/1.0" }, timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location));
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function fmtBytes(n) {
  if (!n) return "?";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

export async function cmdPkgCompareVersions(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      last:  { type: "string", default: "3" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pkg-compare-versions <package> [v1] [v2] [v3...] [options]

Compare metrics across multiple versions of an npm package.

Options:
  --last <n>    Compare last N stable versions (default: 3)
  --json        Machine-readable output
  -h, --help    Show this help

Compares:
  • Packed/unpacked size
  • Dependency count
  • Peer dependency count
  • Node.js engine requirement
  • License
  • TypeScript support

Examples:
  better pkg-compare-versions lodash 4.17.21 4.17.20 3.10.1
  better pkg-compare-versions react --last 3
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better pkg-compare-versions <package> [version...]\nRun: better pkg-compare-versions --help for more info.");
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];
  const explicitVersions = positionals.slice(1);
  const lastN = Math.max(2, Math.min(10, parseInt(values.last) || 3));

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching metadata for ${pkgName}…\x1b[0m\n`);
  }

  let meta;
  try {
    const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    meta = JSON.parse(res.body);
  } catch (err) {
    const msg = `Failed to fetch ${pkgName}: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  // Select versions to compare
  let versions;
  if (explicitVersions.length > 0) {
    versions = explicitVersions;
  } else {
    const timeMap = meta.time || {};
    versions = Object.keys(meta.versions || {})
      .filter(v => timeMap[v] && !/[-+]/.test(v.split(".").slice(2).join(".")))
      .sort((a, b) => new Date(timeMap[b]) - new Date(timeMap[a]))
      .slice(0, lastN);
  }

  // Fetch details for each version
  const results = await Promise.all(versions.map(async (ver) => {
    const vMeta = meta.versions?.[ver];
    if (!vMeta) return { version: ver, error: "not found" };

    const deps = Object.keys(vMeta.dependencies || {}).length;
    const devDeps = Object.keys(vMeta.devDependencies || {}).length;
    const peerDeps = Object.keys(vMeta.peerDependencies || {}).length;
    const hasTypes = !!(vMeta.types || vMeta.typings);
    const license = vMeta.license || "?";
    const node = vMeta.engines?.node || "?";
    const dist = vMeta.dist || {};
    const deprecated = vMeta.deprecated || null;

    return {
      version: ver,
      publishDate: meta.time?.[ver] ? new Date(meta.time[ver]).toISOString().split("T")[0] : "?",
      size: dist.unpackedSize || null,
      tarballSize: dist.fileCount || null,
      deps,
      devDeps,
      peerDeps,
      hasTypes,
      license,
      node,
      deprecated,
    };
  }));

  if (values.json) {
    printJson({ ok: true, kind: "better.pkg-compare-versions", package: pkgName, versions: results });
    return;
  }

  printText(`\n\x1b[1mbetter pkg-compare-versions\x1b[0m — \x1b[1m${pkgName}\x1b[0m\n`);

  const cols = results.filter(r => !r.error);
  if (cols.length === 0) {
    printText(`\x1b[31mNo valid versions found.\x1b[0m`);
    return;
  }

  const vw = 12;
  const header = "Metric".padEnd(22) + cols.map(r => r.version.padStart(vw)).join("");
  printText(`\x1b[90m${header}\x1b[0m`);
  printText(`\x1b[90m${"─".repeat(22 + cols.length * vw)}\x1b[0m`);

  const rows = [
    { label: "Published", key: r => r.publishDate },
    { label: "Unpacked size", key: r => fmtBytes(r.size) },
    { label: "Prod deps", key: r => String(r.deps) },
    { label: "Peer deps", key: r => String(r.peerDeps) },
    { label: "TypeScript", key: r => r.hasTypes ? "✔" : "✗" },
    { label: "License", key: r => r.license },
    { label: "Node.js", key: r => r.node },
    { label: "Deprecated", key: r => r.deprecated ? "YES" : "no" },
  ];

  for (const row of rows) {
    const vals = cols.map(r => row.key(r));
    const line = row.label.padEnd(22) + vals.map(v => {
      const colored = v === "YES" ? `\x1b[31m${v}\x1b[0m` : v === "✔" ? `\x1b[32m${v}\x1b[0m` : v;
      return colored.padStart(vw + (colored.length - v.length));
    }).join("");
    printText(line);
  }
  printText("");
}
