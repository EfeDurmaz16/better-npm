/**
 * better pkg-versions — list all published versions of a package
 *
 * Shows the full version history of an npm package with release
 * dates, tags, and highlights latest/next/beta tags.
 *
 * Usage:
 *   better pkg-versions lodash
 *   better pkg-versions react --limit 20
 *   better pkg-versions express --json
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

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function fmtDate(dateStr) {
  if (!dateStr) return "?";
  return new Date(dateStr).toISOString().split("T")[0];
}

function fmtAge(days) {
  if (days === null) return "";
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

export async function cmdPkgVersions(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      limit:   { type: "string", default: "30" },
      all:     { type: "boolean", default: false },
      stable:  { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pkg-versions <package> [options]

List all published versions of an npm package.

Options:
  --limit <n>    Show N most recent versions (default: 30)
  --all          Show all versions (ignore limit)
  --stable       Show only stable versions (no prerelease)
  --json         Machine-readable output
  -h, --help     Show this help

Examples:
  better pkg-versions lodash
  better pkg-versions react --limit 20
  better pkg-versions typescript --stable
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better pkg-versions <package>\nRun: better pkg-versions --help for more info.");
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];
  const limit = Math.max(1, Math.min(500, parseInt(values.limit) || 30));

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching version history for ${pkgName}…\x1b[0m\n`);
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

  const distTags = meta["dist-tags"] || {};
  const tagByVersion = {};
  for (const [tag, ver] of Object.entries(distTags)) {
    if (!tagByVersion[ver]) tagByVersion[ver] = [];
    tagByVersion[ver].push(tag);
  }

  const timeMap = meta.time || {};
  let versions = Object.keys(meta.versions || {})
    .filter(v => timeMap[v])
    .sort((a, b) => new Date(timeMap[b]) - new Date(timeMap[a]));

  if (values.stable) {
    versions = versions.filter(v => !/[-+]/.test(v.split(".").slice(2).join(".")));
  }

  const total = versions.length;
  if (!values.all) {
    versions = versions.slice(0, limit);
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.pkg-versions",
      package: pkgName,
      total,
      shown: versions.length,
      distTags,
      versions: versions.map(v => ({
        version: v,
        published: timeMap[v],
        tags: tagByVersion[v] || [],
        deprecated: !!meta.versions[v]?.deprecated,
      })),
    });
    return;
  }

  const latest = distTags.latest;
  printText(`\n\x1b[1mbetter pkg-versions\x1b[0m — \x1b[1m${pkgName}\x1b[0m  (${total} total, showing ${versions.length})\n`);

  // Tags summary
  const tagEntries = Object.entries(distTags);
  if (tagEntries.length > 0) {
    printText(`  \x1b[90mDist-tags:\x1b[0m  ${tagEntries.map(([t, v]) => `${t}→${v}`).join("  ")}\n`);
  }

  for (const v of versions) {
    const isLatest = v === latest;
    const tags = tagByVersion[v] || [];
    const published = fmtDate(timeMap[v]);
    const age = fmtAge(daysSince(timeMap[v]));
    const deprecated = meta.versions[v]?.deprecated;

    const tagStr = tags.length > 0 ? `  \x1b[36m[${tags.join(", ")}]\x1b[0m` : "";
    const depStr = deprecated ? `  \x1b[31m[deprecated]\x1b[0m` : "";
    const vColor = isLatest ? "\x1b[1m\x1b[32m" : deprecated ? "\x1b[31m" : "\x1b[0m";

    printText(`  ${vColor}${v.padEnd(18)}\x1b[0m  \x1b[90m${published}  ${age.padStart(10)}\x1b[0m${tagStr}${depStr}`);
  }

  if (total > versions.length) {
    printText(`\n  \x1b[90m… and ${total - versions.length} older versions. Use --all or --limit ${total} to see all.\x1b[0m`);
  }
  printText("");
}
