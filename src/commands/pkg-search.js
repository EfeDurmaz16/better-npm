/**
 * better pkg-search — search npm registry with rich output
 *
 * Searches the npm registry for packages matching a query,
 * showing downloads, descriptions, and quality scores in a
 * formatted table.
 *
 * Usage:
 *   better pkg-search "http client"
 *   better pkg-search react --limit 5
 *   better pkg-search --json "date library"
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
  if (!n && n !== 0) return "?";
  if (n >= 1e9) return `${(n/1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n/1e3).toFixed(0)}K`;
  return String(n);
}

function scoreBar(score, width = 10) {
  const filled = Math.round(score * width);
  const color = score >= 0.7 ? "\x1b[32m" : score >= 0.4 ? "\x1b[33m" : "\x1b[31m";
  return `${color}${"█".repeat(filled)}${"░".repeat(width - filled)}\x1b[0m`;
}

export async function cmdPkgSearch(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      limit:  { type: "string", default: "10" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pkg-search <query> [options]

Search npm registry for packages.

Options:
  --limit <n>    Number of results (default: 10)
  --json         Machine-readable output
  -h, --help     Show this help

Examples:
  better pkg-search "http client"
  better pkg-search react --limit 5
  better pkg-search "date library"
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better pkg-search <query>\nRun: better pkg-search --help for more info.");
    process.exitCode = 1;
    return;
  }

  const query = positionals.join(" ");
  const limit = parseInt(values.limit, 10) || 10;

  if (!values.json) {
    printText(`\n\x1b[1mbetter pkg-search\x1b[0m — "${query}"\n`);
    process.stderr.write(`\x1b[90mSearching npm registry...\x1b[0m\n`);
  }

  let results = [];
  try {
    const res = await httpsGet(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      results = data.objects || [];
    }
  } catch {}

  if (results.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.pkg-search", query, results: [] }); return; }
    printText(`  \x1b[90mNo results found for "${query}".\x1b[0m\n`);
    return;
  }

  const formatted = results.map(r => ({
    name: r.package.name,
    version: r.package.version,
    description: r.package.description || "",
    keywords: (r.package.keywords || []).slice(0, 3),
    score: r.score?.final || 0,
    quality: r.score?.detail?.quality || 0,
    popularity: r.score?.detail?.popularity || 0,
    maintenance: r.score?.detail?.maintenance || 0,
    downloads: null, // not in search API
  }));

  if (values.json) {
    printJson({ ok: true, kind: "better.pkg-search", query, total: results.length, results: formatted });
    return;
  }

  for (const r of formatted) {
    const scoreStr = scoreBar(r.score);
    const desc = r.description.length > 55 ? r.description.slice(0, 55) + "..." : r.description.padEnd(55);
    printText(`  \x1b[1m${r.name}\x1b[0m@${r.version}`);
    printText(`  \x1b[90m${desc}\x1b[0m`);
    printText(`  Score: ${scoreStr}  \x1b[90mQ:${Math.round(r.quality*100)}% P:${Math.round(r.popularity*100)}% M:${Math.round(r.maintenance*100)}%\x1b[0m`);
    if (r.keywords.length > 0) printText(`  \x1b[90mKeywords: ${r.keywords.join(", ")}\x1b[0m`);
    printText("");
  }
}
