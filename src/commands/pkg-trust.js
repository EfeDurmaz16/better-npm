/**
 * better pkg-trust — assess trustworthiness of npm packages
 *
 * Evaluates package trust signals: maintainer count, publish history,
 * download trends, GitHub stars, typosquat detection, and more.
 *
 * Usage:
 *   better pkg-trust lodash
 *   better pkg-trust express --json
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
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}yr ago`;
}

// Detect potential typosquatting against well-known packages
const POPULAR_PACKAGES = ["lodash", "express", "react", "axios", "moment", "chalk", "commander", "jest", "webpack", "eslint", "typescript", "vue", "angular", "next", "nuxt"];

function detectTyposquat(name) {
  for (const popular of POPULAR_PACKAGES) {
    if (name === popular) continue;
    // Levenshtein distance approximation
    if (Math.abs(name.length - popular.length) <= 2) {
      let diff = 0;
      const shorter = name.length < popular.length ? name : popular;
      const longer = name.length >= popular.length ? name : popular;
      for (let i = 0; i < shorter.length; i++) {
        if (shorter[i] !== longer[i]) diff++;
      }
      diff += longer.length - shorter.length;
      if (diff <= 2 && diff > 0) return popular;
    }
    // Common typo patterns: extra/missing dash, similar start
    if (name.replace(/-/g, "") === popular.replace(/-/g, "") && name !== popular) return popular;
    if (name.startsWith(popular) && name.length - popular.length <= 3) return popular;
  }
  return null;
}

export async function cmdPkgTrust(argv) {
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
    printText(`Usage: better pkg-trust <package> [options]

Assess trustworthiness of an npm package.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Trust signals:
  • Maintainer count and history
  • Package age and publish frequency
  • Weekly downloads
  • Repository and documentation links
  • Typosquat detection against popular packages
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better pkg-trust <package>\nRun: better pkg-trust --help for more info.");
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];

  if (!values.json) {
    printText(`\n\x1b[1mbetter pkg-trust\x1b[0m — ${pkgName}\n`);
    process.stderr.write(`\x1b[90mFetching package trust signals...\x1b[0m\n`);
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

  const versions = Object.keys(meta.versions || {});
  const latestVersion = meta["dist-tags"]?.latest;
  const latestMeta = meta.versions?.[latestVersion] || {};
  const created = meta.time?.created;
  const modified = meta.time?.modified;
  const maintainers = (meta.maintainers || []).map(m => typeof m === "string" ? m : m.name);

  // Publish frequency
  const publishDates = Object.values(meta.time || {})
    .filter(v => typeof v === "string" && v.includes("T"))
    .map(v => new Date(v).getTime())
    .sort((a, b) => a - b);

  let avgDaysBetweenPublish = null;
  if (publishDates.length > 1) {
    const totalMs = publishDates[publishDates.length - 1] - publishDates[0];
    avgDaysBetweenPublish = Math.round((totalMs / (publishDates.length - 1)) / 86400000);
  }

  // Typosquat check
  const typosquatTarget = detectTyposquat(pkgName);

  // Trust scoring
  let score = 0;
  const signals = [];

  if (weeklyDownloads && weeklyDownloads > 100000) { score += 25; signals.push({ ok: true, label: `High downloads: ${fmtNum(weeklyDownloads)}/week` }); }
  else if (weeklyDownloads && weeklyDownloads > 1000) { score += 15; signals.push({ ok: true, label: `Moderate downloads: ${fmtNum(weeklyDownloads)}/week` }); }
  else { signals.push({ ok: false, label: `Low downloads: ${fmtNum(weeklyDownloads)}/week` }); }

  if (versions.length > 10) { score += 20; signals.push({ ok: true, label: `${versions.length} versions published (active)` }); }
  else { signals.push({ ok: false, label: `Only ${versions.length} version(s) published` }); }

  const ageMs = created ? Date.now() - new Date(created).getTime() : 0;
  const ageDays = Math.floor(ageMs / 86400000);
  if (ageDays > 365) { score += 20; signals.push({ ok: true, label: `Package age: ${Math.floor(ageDays/365)}yr (established)` }); }
  else if (ageDays > 30) { score += 10; signals.push({ ok: null, label: `Package age: ${Math.floor(ageDays/30)}mo` }); }
  else { signals.push({ ok: false, label: `Package age: ${ageDays}d (very new)` }); }

  if (maintainers.length >= 2) { score += 15; signals.push({ ok: true, label: `${maintainers.length} maintainers (lower bus factor)` }); }
  else { signals.push({ ok: null, label: `${maintainers.length} maintainer${maintainers.length !== 1 ? "s" : ""} (single point of failure)` }); }

  if (latestMeta.repository) { score += 10; signals.push({ ok: true, label: `Repository linked` }); }
  else { signals.push({ ok: false, label: `No repository linked` }); }

  if (latestMeta.license) { score += 10; signals.push({ ok: true, label: `License: ${latestMeta.license}` }); }
  else { signals.push({ ok: false, label: `No license field` }); }

  if (typosquatTarget) {
    score -= 30;
    signals.push({ ok: false, label: `Possible typosquat of "${typosquatTarget}"` });
  }

  score = Math.max(0, Math.min(100, score));
  const grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "F";

  if (values.json) {
    printJson({
      ok: score >= 40,
      kind: "better.pkg-trust",
      package: pkgName,
      version: latestVersion,
      score,
      grade,
      weeklyDownloads,
      versions: versions.length,
      maintainers,
      created,
      modified,
      avgDaysBetweenPublish,
      typosquatTarget,
      signals,
    });
    if (score < 40) process.exitCode = 1;
    return;
  }

  const gradeColor = grade === "A" ? "\x1b[32m" : grade === "B" ? "\x1b[32m" : grade === "C" ? "\x1b[33m" : "\x1b[31m";
  printText(`  ${pkgName}@${latestVersion}  |  Trust score: ${gradeColor}${score}/100 (${grade})\x1b[0m\n`);

  for (const s of signals) {
    const icon = s.ok === true ? "\x1b[32m✔\x1b[0m" : s.ok === false ? "\x1b[31m✘\x1b[0m" : "\x1b[33m·\x1b[0m";
    printText(`  ${icon}  ${s.label}`);
  }
  printText("");
}
