/**
 * better dep-score — score individual packages for quality and safety
 *
 * Computes a quality score (0–100) for npm packages based on:
 * maintenance activity, download popularity, TypeScript support,
 * license, README completeness, and repository presence.
 *
 * Usage:
 *   better dep-score lodash
 *   better dep-score express axios chalk
 *   better dep-score --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import fs from "node:fs/promises";
import path from "node:path";

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
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function gradeFromScore(score) {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

function scoreColor(score) {
  if (score >= 80) return "\x1b[32m";
  if (score >= 60) return "\x1b[33m";
  return "\x1b[31m";
}

async function scorePackage(pkgName) {
  let meta;
  try {
    const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`);
    if (res.status !== 200) return { name: pkgName, error: `HTTP ${res.status}` };
    meta = JSON.parse(res.body);
  } catch (err) {
    return { name: pkgName, error: err.message };
  }

  const latest = meta["dist-tags"]?.latest;
  const latestMeta = meta.versions?.[latest] || {};
  const time = meta.time || {};

  const breakdown = {};
  let total = 0;

  // Maintenance (30 pts)
  const daysSinceModified = daysSince(time.modified);
  const versionCount = Object.keys(meta.versions || {}).length;
  let maintenance = 0;
  if (daysSinceModified < 180) maintenance += 15;
  else if (daysSinceModified < 365) maintenance += 10;
  else if (daysSinceModified < 730) maintenance += 5;
  if (versionCount >= 10) maintenance += 10;
  else if (versionCount >= 5) maintenance += 7;
  else if (versionCount >= 2) maintenance += 4;
  if (!meta.time?.unpublished) maintenance += 5;
  breakdown.maintenance = { score: maintenance, max: 30, label: `${Math.round(daysSinceModified)}d ago, ${versionCount} versions` };
  total += maintenance;

  // TypeScript (15 pts)
  let ts = 0;
  if (latestMeta.types || latestMeta.typings) ts = 15;
  else if (latestMeta.devDependencies?.["typescript"] || latestMeta.dependencies?.["@types/node"]) ts = 10;
  breakdown.typescript = { score: ts, max: 15, label: ts === 15 ? "bundled types" : ts === 10 ? "typescript tooling" : "none" };
  total += ts;

  // License (15 pts)
  const license = latestMeta.license || meta.license;
  let licScore = 0;
  if (license && license !== "UNLICENSED" && !license.includes("SEE LICENSE")) licScore = 15;
  else if (license) licScore = 5;
  breakdown.license = { score: licScore, max: 15, label: license || "none" };
  total += licScore;

  // Repository (10 pts)
  const repo = latestMeta.repository || meta.repository;
  let repoScore = 0;
  if (repo?.url?.includes("github.com")) repoScore = 10;
  else if (repo) repoScore = 7;
  breakdown.repository = { score: repoScore, max: 10, label: repo ? (repo.url || "present") : "none" };
  total += repoScore;

  // README (10 pts)
  const readme = meta.readme || "";
  let readmeScore = 0;
  if (readme.length > 2000) readmeScore = 10;
  else if (readme.length > 500) readmeScore = 7;
  else if (readme.length > 100) readmeScore = 4;
  breakdown.readme = { score: readmeScore, max: 10, label: `${readme.length} chars` };
  total += readmeScore;

  // Not deprecated (10 pts)
  const isDeprecated = !!latestMeta.deprecated;
  const deprecationScore = isDeprecated ? 0 : 10;
  breakdown.deprecated = { score: deprecationScore, max: 10, label: isDeprecated ? `deprecated: ${latestMeta.deprecated}` : "not deprecated" };
  total += deprecationScore;

  // Description (5 pts)
  const hasDesc = !!(latestMeta.description || meta.description);
  breakdown.description = { score: hasDesc ? 5 : 0, max: 5, label: hasDesc ? "present" : "missing" };
  total += hasDesc ? 5 : 0;

  // Not private / publishable (5 pts)
  breakdown.publishable = { score: 5, max: 5, label: "public package" };
  total += 5;

  return {
    name: pkgName,
    version: latest,
    score: Math.min(100, total),
    grade: gradeFromScore(Math.min(100, total)),
    breakdown,
    deprecated: isDeprecated,
    lastModified: time.modified,
  };
}

export async function cmdDepScore(argv) {
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
    printText(`Usage: better dep-score <package> [package2...] [options]

Score npm packages for quality, maintenance, and safety (0–100).

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Score categories:
  maintenance (30pts)  Recent activity, version count, not unpublished
  typescript  (15pts)  Bundled types or @types package
  license     (15pts)  Present and recognized license
  repository  (10pts)  GitHub or other source repository
  readme      (10pts)  README completeness
  deprecated  (10pts)  Not deprecated
  description  (5pts)  Package description present
  publishable  (5pts)  Public package

Examples:
  better dep-score lodash
  better dep-score express axios chalk
`);
    return;
  }

  let packages = positionals;

  // If no packages given, use project dependencies
  if (packages.length === 0) {
    const cwd = process.cwd();
    const resolvedRoot = await resolveInstallProjectRoot(cwd);
    try {
      const pkgJson = JSON.parse(await fs.readFile(path.join(resolvedRoot.root, "package.json"), "utf8"));
      packages = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies }).slice(0, 20);
    } catch {}
  }

  if (packages.length === 0) {
    printText("Usage: better dep-score <package> [package2...]\nRun: better dep-score --help for more info.");
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter dep-score\x1b[0m — scoring ${packages.length} package(s)\n`);
  }

  const results = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < packages.length; i += CONCURRENCY) {
    const batch = packages.slice(i, i + CONCURRENCY);
    if (!values.json) {
      process.stderr.write(`\x1b[90mFetching ${batch.join(", ")}…\x1b[0m\n`);
    }
    const batchResults = await Promise.all(batch.map(scorePackage));
    results.push(...batchResults);
  }

  if (values.json) {
    printJson({ ok: true, kind: "better.dep-score", results });
    return;
  }

  results.sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || (b.score || 0) - (a.score || 0));

  printText(`\x1b[90m${"─".repeat(60)}\x1b[0m`);
  printText(`  ${"Package".padEnd(30)} ${"Score".padStart(5)}  Grade  Version`);
  printText(`\x1b[90m${"─".repeat(60)}\x1b[0m`);

  for (const r of results) {
    if (r.error) {
      printText(`  ${r.name.padEnd(30)} \x1b[31merror\x1b[0m: ${r.error}`);
      continue;
    }
    const col = scoreColor(r.score);
    const dep = r.deprecated ? " \x1b[31m[deprecated]\x1b[0m" : "";
    printText(`  ${r.name.padEnd(30)} ${col}${String(r.score).padStart(5)}\x1b[0m  ${col}${r.grade.padEnd(5)}\x1b[0m  ${r.version || "?"}${dep}`);
  }

  printText(`\x1b[90m${"─".repeat(60)}\x1b[0m`);
  const valid = results.filter(r => !r.error);
  if (valid.length > 0) {
    const avg = Math.round(valid.reduce((s, r) => s + r.score, 0) / valid.length);
    const col = scoreColor(avg);
    printText(`  ${"Average".padEnd(30)} ${col}${String(avg).padStart(5)}\x1b[0m  ${col}${gradeFromScore(avg)}\x1b[0m`);
  }
  printText("");
}
