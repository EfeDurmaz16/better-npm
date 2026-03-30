/**
 * better pkg-info — detailed package information
 *
 * Fetches and displays comprehensive information about a package:
 * description, versions, dependencies, size, license, links,
 * weekly downloads, and GitHub stats.
 *
 * Usage:
 *   better pkg-info lodash
 *   better pkg-info express@4
 *   better pkg-info --json lodash
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";

function fetchJson(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 8000,
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

function fmtNum(n) {
  if (n == null) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtBytes(bytes) {
  if (!bytes) return "?";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function timeSince(dateStr) {
  if (!dateStr) return "?";
  const ms = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export async function cmdPkgInfo(argv) {
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

  if (values.help || positionals.length === 0) {
    printText(`Usage: better pkg-info <package[@version]> [options]

Display detailed information about an npm package.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better pkg-info lodash
  better pkg-info express@4
  better pkg-info @types/node
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const pkgArg = positionals[0];
  const atIdx = pkgArg.lastIndexOf("@");
  let pkgName, version;
  if (atIdx > 0) {
    pkgName = pkgArg.slice(0, atIdx);
    version = pkgArg.slice(atIdx + 1);
  } else {
    pkgName = pkgArg;
    version = "latest";
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching ${pkgName}@${version}…\x1b[0m\n`);
  }

  const encoded = encodeURIComponent(pkgName).replace(/%40/g, "@");
  const [pkgData, versionData, downloadsData] = await Promise.all([
    fetchJson(`https://registry.npmjs.org/${encoded}`),
    fetchJson(`https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`),
    fetchJson(`https://api.npmjs.org/downloads/point/last-week/${encoded}`),
  ]);

  if (!pkgData) {
    const msg = `Package "${pkgName}" not found on npm registry`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const resolvedVersion = versionData?.version || pkgData["dist-tags"]?.latest;
  const vInfo = resolvedVersion ? pkgData.versions?.[resolvedVersion] : null;
  const latestVersion = pkgData["dist-tags"]?.latest;
  const allVersions = Object.keys(pkgData.versions || {});
  const publishTime = pkgData.time?.[resolvedVersion];
  const latestPublishTime = pkgData.time?.[latestVersion];
  const weeklyDownloads = downloadsData?.downloads;

  const depCount = Object.keys(vInfo?.dependencies || {}).length;
  const devDepCount = Object.keys(vInfo?.devDependencies || {}).length;
  const peerDepCount = Object.keys(vInfo?.peerDependencies || {}).length;

  const unpacked = vInfo?.dist?.unpackedSize;
  const tarball = vInfo?.dist?.tarball;
  const integrity = vInfo?.dist?.integrity;

  const repo = vInfo?.repository?.url || pkgData.repository?.url || null;
  const homepage = vInfo?.homepage || pkgData.homepage || null;
  const bugs = vInfo?.bugs?.url || pkgData.bugs?.url || null;

  const maintainers = (pkgData.maintainers || []).map(m => m.name);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.pkg-info",
      name: pkgName,
      version: resolvedVersion,
      latestVersion,
      description: vInfo?.description || pkgData.description,
      license: vInfo?.license || pkgData.license,
      author: vInfo?.author?.name || (typeof vInfo?.author === "string" ? vInfo.author : null),
      publishedAt: publishTime,
      latestPublishedAt: latestPublishTime,
      weeklyDownloads,
      totalVersions: allVersions.length,
      dependencies: depCount,
      devDependencies: devDepCount,
      peerDependencies: peerDepCount,
      unpackedSize: unpacked,
      maintainers,
      repository: repo,
      homepage,
      bugs,
      engines: vInfo?.engines,
      keywords: (vInfo?.keywords || pkgData.keywords || []).slice(0, 10),
    });
    return;
  }

  const name = pkgName;
  const desc = vInfo?.description || pkgData.description || "";
  const license = vInfo?.license || pkgData.license || "?";
  const author = vInfo?.author?.name || (typeof vInfo?.author === "string" ? vInfo.author : null);
  const keywords = (vInfo?.keywords || pkgData.keywords || []).slice(0, 8);

  printText(`\n\x1b[1m${name}@${resolvedVersion}\x1b[0m`);
  if (desc) printText(`  ${desc}\n`);

  printText(`  License:     ${license}`);
  if (author) printText(`  Author:      ${author}`);
  printText(`  Published:   ${timeSince(publishTime)}${publishTime ? ` (${publishTime?.slice(0, 10)})` : ""}`);
  if (resolvedVersion !== latestVersion) {
    printText(`  Latest:      ${latestVersion} (${timeSince(latestPublishTime)})`);
  }
  printText(`  Downloads:   ${fmtNum(weeklyDownloads)}/week`);
  printText(`  Versions:    ${allVersions.length} total`);
  printText(`  Size:        ${fmtBytes(unpacked)} (unpacked)`);
  printText(`  Deps:        ${depCount} prod, ${devDepCount} dev, ${peerDepCount} peer`);
  printText(`  Maintainers: ${maintainers.slice(0, 3).join(", ")}${maintainers.length > 3 ? ` +${maintainers.length - 3}` : ""}`);

  if (keywords.length > 0) {
    printText(`  Keywords:    ${keywords.join(", ")}`);
  }

  if (vInfo?.engines) {
    const eng = Object.entries(vInfo.engines).map(([k, v]) => `${k}: ${v}`).join(", ");
    printText(`  Engines:     ${eng}`);
  }

  printText("");
  if (homepage) printText(`  Homepage:  ${homepage}`);
  if (repo) printText(`  Repo:      ${repo.replace(/^git\+/, "").replace(/\.git$/, "")}`);
  if (bugs) printText(`  Issues:    ${bugs}`);

  // List top-level deps
  const deps = Object.entries(vInfo?.dependencies || {});
  if (deps.length > 0) {
    printText(`\n  \x1b[1mDependencies (${deps.length})\x1b[0m`);
    for (const [dep, ver] of deps.slice(0, 10)) {
      printText(`    ${dep.padEnd(28)} ${ver}`);
    }
    if (deps.length > 10) printText(`    \x1b[90m...and ${deps.length - 10} more\x1b[0m`);
  }

  const peers = Object.entries(vInfo?.peerDependencies || {});
  if (peers.length > 0) {
    printText(`\n  \x1b[1mPeer Dependencies (${peers.length})\x1b[0m`);
    for (const [dep, ver] of peers) {
      printText(`    ${dep.padEnd(28)} ${ver}`);
    }
  }

  printText("");
}
