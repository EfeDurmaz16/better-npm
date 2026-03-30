/**
 * better impact — show impact of adding a new dependency
 *
 * Before adding a package, see its full impact: install size,
 * transitive dep count, license, TypeScript support, and
 * maintenance health score.
 *
 * Usage:
 *   better impact lodash
 *   better impact react@18 vue@3
 *   better impact express --json
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
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function daysSince(d) {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

function healthGrade(days, versions) {
  let score = 20;
  if (days !== null && days < 180) score += 50;
  else if (days !== null && days < 365) score += 30;
  else if (days !== null && days < 730) score += 10;
  if (versions >= 10) score += 30;
  else if (versions >= 5) score += 20;
  else if (versions >= 2) score += 10;
  if (score >= 90) return { grade: "A", color: "\x1b[32m" };
  if (score >= 70) return { grade: "B", color: "\x1b[32m" };
  if (score >= 50) return { grade: "C", color: "\x1b[33m" };
  return { grade: "D", color: "\x1b[31m" };
}

async function analyzePackage(pkgSpec) {
  let pkgName, version;
  if (pkgSpec.startsWith("@")) {
    const idx = pkgSpec.indexOf("@", 1);
    if (idx > 0) { pkgName = pkgSpec.slice(0, idx); version = pkgSpec.slice(idx + 1); }
    else { pkgName = pkgSpec; version = null; }
  } else if (pkgSpec.includes("@")) {
    const idx = pkgSpec.lastIndexOf("@");
    pkgName = pkgSpec.slice(0, idx); version = pkgSpec.slice(idx + 1);
  } else {
    pkgName = pkgSpec; version = null;
  }

  let meta;
  try {
    const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    meta = JSON.parse(res.body);
  } catch (err) {
    return { name: pkgName, error: err.message };
  }

  const resolvedVersion = version || meta["dist-tags"]?.latest;
  const vMeta = meta.versions?.[resolvedVersion] || {};
  const dist = vMeta.dist || {};
  const time = meta.time || {};
  const deps = Object.keys(vMeta.dependencies || {});
  const peerDeps = Object.keys(vMeta.peerDependencies || {});
  const hasTypes = !!(vMeta.types || vMeta.typings);
  const license = vMeta.license || "?";
  const deprecated = !!vMeta.deprecated;
  const nodeEngine = vMeta.engines?.node || null;
  const maintainers = (meta.maintainers || []).length;
  const versionCount = Object.keys(meta.versions || {}).length;
  const age = daysSince(time.modified);
  const { grade, color } = healthGrade(age, versionCount);

  let weeklyDownloads = null;
  try {
    const dlRes = await httpsGet(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkgName)}`);
    if (dlRes.status === 200) weeklyDownloads = JSON.parse(dlRes.body).downloads || null;
  } catch {}

  return { name: pkgName, version: resolvedVersion, unpackedSize: dist.unpackedSize || null,
    directDeps: deps.length, peerDeps: peerDeps.length, peerDepsNames: peerDeps,
    hasTypes, license, deprecated, nodeEngine, maintainers, versionCount, ageInDays: age,
    weeklyDownloads, grade, gradeColor: color };
}

export async function cmdImpact(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better impact <package[@version]> [package2...] [options]

Show the impact of adding a dependency before installing it.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Shows:
  * Unpacked install size
  * Direct dependency count
  * Peer dependency requirements
  * TypeScript support
  * License
  * Weekly downloads (popularity)
  * Maintenance health grade

Examples:
  better impact lodash
  better impact react@18
  better impact express axios chalk
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better impact <package[@version]>\nRun: better impact --help for more info.");
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter impact\x1b[0m\n`);
    process.stderr.write(`\x1b[90mFetching package metadata...\x1b[0m\n`);
  }

  const results = await Promise.all(positionals.map(analyzePackage));

  if (values.json) {
    printJson({ ok: true, kind: "better.impact", results });
    return;
  }

  for (const r of results) {
    if (r.error) {
      printText(`  \x1b[31mx\x1b[0m  \x1b[1m${r.name}\x1b[0m  error: ${r.error}\n`);
      continue;
    }
    const dep = r.deprecated ? "  \x1b[31m[DEPRECATED]\x1b[0m" : "";
    printText(`  \x1b[1m${r.name}@${r.version}\x1b[0m${dep}  ${r.gradeColor}Grade: ${r.grade}\x1b[0m`);
    printText(`\x1b[90m${"-".repeat(50)}\x1b[0m`);
    printText(`  Size:         ${fmtBytes(r.unpackedSize)}`);
    printText(`  Direct deps:  ${r.directDeps}`);
    if (r.peerDeps > 0) printText(`  Peer deps:    ${r.peerDeps}  \x1b[33m(${r.peerDepsNames.slice(0, 3).join(", ")})\x1b[0m`);
    printText(`  TypeScript:   ${r.hasTypes ? "\x1b[32mv bundled\x1b[0m" : "\x1b[90mnot included\x1b[0m"}`);
    printText(`  License:      ${r.license}`);
    if (r.nodeEngine) printText(`  Node.js:      ${r.nodeEngine}`);
    const dlStr = r.weeklyDownloads
      ? (r.weeklyDownloads > 1e6 ? `${(r.weeklyDownloads/1e6).toFixed(1)}M/wk`
         : r.weeklyDownloads > 1e3 ? `${(r.weeklyDownloads/1e3).toFixed(0)}K/wk`
         : `${r.weeklyDownloads}/wk`) : "?";
    printText(`  Downloads:    ${dlStr}`);
    printText(`  Maintainers:  ${r.maintainers}`);
    if (r.ageInDays !== null) {
      const ageStr = r.ageInDays < 30 ? `${r.ageInDays}d` : r.ageInDays < 365 ? `${Math.round(r.ageInDays/30)}mo` : `${(r.ageInDays/365).toFixed(1)}y`;
      printText(`  Last update:  ${ageStr} ago`);
    }
    printText("");
  }
}
