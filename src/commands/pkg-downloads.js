/**
 * better pkg-downloads — show npm package download statistics
 *
 * Fetches download counts for npm packages from the npm downloads
 * API. Shows daily, weekly, monthly, and yearly totals.
 *
 * Usage:
 *   better pkg-downloads lodash
 *   better pkg-downloads react vue angular
 *   better pkg-downloads express --json
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

function fmtNum(n) {
  if (!n) return "?";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function bar(value, max, width = 20) {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const filled = Math.round(frac * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function fetchDownloads(pkgName, period) {
  const encoded = encodeURIComponent(pkgName);
  const res = await httpsGet(`https://api.npmjs.org/downloads/point/${period}/${encoded}`);
  if (res.status !== 200) return null;
  const data = JSON.parse(res.body);
  return data.downloads || 0;
}

async function getPackageDownloads(pkgName) {
  try {
    const [lastDay, lastWeek, lastMonth, lastYear] = await Promise.all([
      fetchDownloads(pkgName, "last-day"),
      fetchDownloads(pkgName, "last-week"),
      fetchDownloads(pkgName, "last-month"),
      fetchDownloads(pkgName, "last-year"),
    ]);
    return { name: pkgName, lastDay, lastWeek, lastMonth, lastYear };
  } catch (err) {
    return { name: pkgName, error: err.message };
  }
}

export async function cmdPkgDownloads(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      period:  { type: "string", default: "last-month" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pkg-downloads <package> [package2...] [options]

Show npm package download statistics.

Options:
  --period <p>   Period for main chart: last-day|last-week|last-month|last-year (default: last-month)
  --json         Machine-readable output
  -h, --help     Show this help

Examples:
  better pkg-downloads lodash
  better pkg-downloads react vue angular
  better pkg-downloads express --period last-week
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better pkg-downloads <package> [package2...]\nRun: better pkg-downloads --help for more info.");
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter pkg-downloads\x1b[0m\n`);
    process.stderr.write(`\x1b[90mFetching download stats for ${positionals.join(", ")}…\x1b[0m\n`);
  }

  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < positionals.length; i += CONCURRENCY) {
    const batch = positionals.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(getPackageDownloads));
    results.push(...batchResults);
  }

  if (values.json) {
    printJson({ ok: true, kind: "better.pkg-downloads", results });
    return;
  }

  const maxMonthly = Math.max(...results.filter(r => !r.error).map(r => r.lastMonth || 0));

  printText(`\x1b[90m${"─".repeat(70)}\x1b[0m`);
  printText(`  ${"Package".padEnd(28)} ${"Day".padStart(8)}  ${"Week".padStart(10)}  ${"Month".padStart(12)}  ${"Year".padStart(12)}`);
  printText(`\x1b[90m${"─".repeat(70)}\x1b[0m`);

  for (const r of results) {
    if (r.error) {
      printText(`  ${r.name.padEnd(28)} \x1b[31merror: ${r.error}\x1b[0m`);
      continue;
    }
    const b = bar(r.lastMonth || 0, maxMonthly, 10);
    printText(`  ${r.name.padEnd(28)} ${fmtNum(r.lastDay).padStart(8)}  ${fmtNum(r.lastWeek).padStart(10)}  ${fmtNum(r.lastMonth).padStart(12)}  ${fmtNum(r.lastYear).padStart(12)}`);
    printText(`  \x1b[90m${" ".repeat(28)} ${b}\x1b[0m`);
  }

  printText(`\x1b[90m${"─".repeat(70)}\x1b[0m`);
  printText("");
}
