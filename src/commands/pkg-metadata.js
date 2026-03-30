/**
 * better pkg-metadata — show detailed package metadata from registry
 *
 * Displays comprehensive metadata for an npm package: maintainers,
 * keywords, repository, homepage, funding, dist-tags, publish history,
 * and more.
 *
 * Usage:
 *   better pkg-metadata lodash
 *   better pkg-metadata @scope/pkg
 *   better pkg-metadata lodash --json
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

function fmtAge(dateStr) {
  if (!dateStr) return "?";
  const ms = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}yr ago`;
}

export async function cmdPkgMetadata(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pkg-metadata <package> [options]

Show detailed package metadata from the npm registry.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Shows:
  • Current version, tags, and publish history
  • Maintainers and repository info
  • Keywords, license, and funding
  • Weekly downloads
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better pkg-metadata <package>\nRun: better pkg-metadata --help for more info.");
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];

  if (!values.json) {
    printText(`\n\x1b[1mbetter pkg-metadata\x1b[0m — ${pkgName}\n`);
    process.stderr.write(`\x1b[90mFetching metadata...\x1b[0m\n`);
  }

  let meta = null;
  let weeklyDownloads = null;
  try {
    const [metaRes, dlRes] = await Promise.all([
      httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`),
      httpsGet(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkgName)}`),
    ]);
    if (metaRes.status === 200) meta = JSON.parse(metaRes.body);
    if (dlRes.status === 200) weeklyDownloads = JSON.parse(dlRes.body).downloads || null;
  } catch {}

  if (!meta) {
    const msg = `Package not found: ${pkgName}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const latestVersion = meta["dist-tags"]?.latest;
  const latestMeta = meta.versions?.[latestVersion] || {};
  const versions = Object.keys(meta.versions || {});
  const created = meta.time?.created;
  const modified = meta.time?.modified;
  const maintainers = (meta.maintainers || []).map(m => (typeof m === "string" ? m : m.name || m.email));

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.pkg-metadata",
      name: pkgName,
      latestVersion,
      distTags: meta["dist-tags"],
      versions: versions.length,
      created,
      modified,
      maintainers,
      keywords: latestMeta.keywords || [],
      license: latestMeta.license,
      description: latestMeta.description,
      repository: latestMeta.repository,
      homepage: latestMeta.homepage,
      funding: latestMeta.funding,
      weeklyDownloads,
    });
    return;
  }

  // Header
  printText(`  \x1b[1m${pkgName}\x1b[0m@${latestVersion}  \x1b[90m${latestMeta.description || ""}\x1b[0m`);
  printText("");

  // Key info
  if (latestMeta.license) printText(`  License:       ${latestMeta.license}`);
  if (latestMeta.homepage) printText(`  Homepage:      \x1b[36m${latestMeta.homepage}\x1b[0m`);
  const repo = latestMeta.repository?.url || latestMeta.repository;
  if (repo) printText(`  Repository:    \x1b[36m${String(repo).replace(/^git\+/, "").replace(/\.git$/, "")}\x1b[0m`);
  if (weeklyDownloads !== null) printText(`  Downloads:     \x1b[32m${fmtNum(weeklyDownloads)}/week\x1b[0m`);
  printText(`  Published:     ${created ? fmtAge(created) : "?"} (${versions.length} versions)`);
  printText(`  Last updated:  ${fmtAge(modified)}`);

  // Dist-tags
  const tags = meta["dist-tags"] || {};
  const tagStr = Object.entries(tags).map(([t, v]) => `${t}:${v}`).join("  ");
  if (tagStr) printText(`  Tags:          \x1b[90m${tagStr}\x1b[0m`);

  // Maintainers
  if (maintainers.length > 0) {
    printText(`  Maintainers:   ${maintainers.slice(0, 5).join(", ")}${maintainers.length > 5 ? ` +${maintainers.length - 5}` : ""}`);
  }

  // Keywords
  const keywords = latestMeta.keywords || [];
  if (keywords.length > 0) {
    printText(`  Keywords:      \x1b[90m${keywords.slice(0, 10).join(", ")}\x1b[0m`);
  }

  printText("");
}
