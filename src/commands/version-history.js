/**
 * better version-history — show version history of a package
 *
 * Fetches all published versions from npm registry with
 * publication dates, annotates with semver bump type, and
 * shows release frequency statistics.
 *
 * Usage:
 *   better version-history lodash
 *   better version-history lodash --last 10
 *   better version-history express --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";

function fetchVersions(name) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    https.get(`https://registry.npmjs.org/${encoded}`, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 8000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve({
            versions: data.versions ? Object.keys(data.versions) : [],
            time: data.time || {},
            distTags: data["dist-tags"] || {},
            description: data.description || "",
          });
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

function parseSemver(v) {
  const m = String(v).replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] };
}

function bumpType(prev, curr) {
  if (!prev) return "initial";
  const p = parseSemver(prev);
  const c = parseSemver(curr);
  if (!p || !c) return "?";
  if (c.pre && !p.pre) return "pre";
  if (p.pre && !c.pre) return "release";
  if (c.major > p.major) return "major";
  if (c.minor > p.minor) return "minor";
  if (c.patch > p.patch) return "patch";
  return "re-publish";
}

function timeSince(dateStr) {
  if (!dateStr) return "";
  const ms = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export async function cmdVersionHistory(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      last:  { type: "string" },
      major: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printText(`Usage: better version-history <package> [options]

Show published version history for an npm package.

Options:
  --last <N>   Show only last N versions (default: 20)
  --major      Show only major version releases
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better version-history lodash
  better version-history lodash --last 5
  better version-history react --major
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];
  const lastN = parseInt(values.last) || 20;

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching version history for ${pkgName}…\x1b[0m\n`);
  }

  const data = await fetchVersions(pkgName);
  if (!data) {
    const msg = `Cannot fetch versions for "${pkgName}"`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const { versions, time, distTags } = data;

  // Build version entries with dates and bump types
  const entries = versions.map((ver, i) => ({
    version: ver,
    publishedAt: time[ver] || null,
    bump: bumpType(versions[i - 1] || null, ver),
    isLatest: distTags.latest === ver,
    isNext: distTags.next === ver,
    isPrerelease: Boolean(parseSemver(ver)?.pre),
  }));

  // Sort by publication date desc
  entries.sort((a, b) => {
    if (!a.publishedAt) return 1;
    if (!b.publishedAt) return -1;
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });

  // Filter major only
  const filtered = values.major
    ? entries.filter(e => e.bump === "major" || e.bump === "initial")
    : entries;

  const display = filtered.slice(0, lastN);

  // Stats
  const totalVersions = versions.length;
  const majorCount = entries.filter(e => e.bump === "major").length;
  const minorCount = entries.filter(e => e.bump === "minor").length;
  const patchCount = entries.filter(e => e.bump === "patch").length;

  // Release frequency
  const datedEntries = entries.filter(e => e.publishedAt).slice(0, 30);
  let avgDaysBetween = null;
  if (datedEntries.length > 1) {
    const spans = [];
    for (let i = 0; i < datedEntries.length - 1; i++) {
      const ms = new Date(datedEntries[i].publishedAt) - new Date(datedEntries[i + 1].publishedAt);
      spans.push(ms / 86400000);
    }
    avgDaysBetween = Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.version-history",
      package: pkgName,
      totalVersions,
      latestVersion: distTags.latest,
      stats: { major: majorCount, minor: minorCount, patch: patchCount },
      avgDaysBetweenReleases: avgDaysBetween,
      versions: display,
    });
    return;
  }

  printText(`\n\x1b[1mbetter version-history — ${pkgName}\x1b[0m\n`);
  printText(`  Total versions: ${totalVersions}  (${majorCount} major, ${minorCount} minor, ${patchCount} patch)`);
  if (avgDaysBetween !== null) {
    printText(`  Avg release interval: ~${avgDaysBetween} day(s)`);
  }
  printText(`  Latest: ${distTags.latest}`);
  printText("");

  const BUMP_COLOR = {
    major:     "\x1b[31m",
    minor:     "\x1b[33m",
    patch:     "\x1b[32m",
    pre:       "\x1b[36m",
    release:   "\x1b[34m",
    initial:   "\x1b[35m",
    "re-publish": "\x1b[90m",
    "?":       "\x1b[90m",
  };

  for (const e of display) {
    const bColor = BUMP_COLOR[e.bump] || "\x1b[0m";
    const bumpLabel = e.bump.padEnd(10);
    const date = e.publishedAt ? e.publishedAt.slice(0, 10) : "          ";
    const ago = e.publishedAt ? `\x1b[90m${timeSince(e.publishedAt).padStart(9)}\x1b[0m` : "";
    const tag = e.isLatest ? " \x1b[32m← latest\x1b[0m" : e.isNext ? " \x1b[33m← next\x1b[0m" : "";
    printText(`  ${bColor}${bumpLabel}\x1b[0m  ${e.version.padEnd(16)}  ${date}  ${ago}${tag}`);
  }

  if (filtered.length > lastN) {
    printText(`\n  \x1b[90m...and ${filtered.length - lastN} more. Use --last to see more.\x1b[0m`);
  }
}
