/**
 * better changelog-view — view a package's changelog from npm registry
 *
 * Fetches and displays the changelog or release notes for an npm package
 * from the registry metadata or linked repository.
 *
 * Usage:
 *   better changelog-view lodash
 *   better changelog-view lodash --versions 5
 *   better changelog-view lodash --json
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

function extractGitHubOwnerRepo(repoUrl) {
  if (!repoUrl) return null;
  const m = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1].replace(/\.git$/, "") : null;
}

function parseVersionHeaders(text, limit) {
  const lines = text.split("\n");
  const sections = [];
  let current = null;
  for (const line of lines) {
    // Match version header lines: ## [1.2.3], ## v1.2.3, # 1.2.3 (date), === 1.2.3 ===
    const hm = line.match(/^#{1,3}\s*\[?v?(\d+\.\d+[\d.]*)[\])]?(.*)?$/) ||
               line.match(/^=+\s*v?(\d+\.\d+[\d.]*)\s*=+/);
    if (hm) {
      if (current && current.lines.length > 0) sections.push(current);
      if (sections.length >= limit) break;
      current = { version: hm[1], meta: (hm[2] || "").trim(), lines: [] };
    } else if (current) {
      if (line.trim()) current.lines.push(line);
      else if (current.lines.length > 0) current.lines.push("");
    }
  }
  if (current && current.lines.length > 0 && sections.length < limit) sections.push(current);
  return sections;
}

export async function cmdChangelogView(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      versions: { type: "string", default: "3" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better changelog-view <package> [options]

View changelog entries for an npm package.

Options:
  --versions <n>   Number of recent versions to show (default: 3)
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better changelog-view lodash
  better changelog-view express --versions 5
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better changelog-view <package>\nRun: better changelog-view --help for more info.");
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];
  const limit = Math.max(1, Math.min(20, parseInt(values.versions) || 3));

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching package info for ${pkgName}…\x1b[0m\n`);
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

  const latest = meta["dist-tags"]?.latest;
  const repoUrl = meta.repository?.url || meta.versions?.[latest]?.repository?.url;
  const ownerRepo = extractGitHubOwnerRepo(repoUrl);

  // Build version list sorted by publish time
  const versionTimes = Object.entries(meta.time || {})
    .filter(([k]) => k !== "created" && k !== "modified" && meta.versions?.[k])
    .sort((a, b) => new Date(b[1]) - new Date(a[1]))
    .slice(0, limit);

  // Try to fetch CHANGELOG from GitHub
  let changelogText = null;
  if (ownerRepo) {
    if (!values.json) {
      process.stderr.write(`\x1b[90mFetching changelog from GitHub (${ownerRepo})…\x1b[0m\n`);
    }
    for (const name of ["CHANGELOG.md", "CHANGELOG", "HISTORY.md", "RELEASES.md", "CHANGES.md"]) {
      try {
        const raw = `https://raw.githubusercontent.com/${ownerRepo}/HEAD/${name}`;
        const res = await httpsGet(raw);
        if (res.status === 200 && res.body.length > 100) {
          changelogText = res.body;
          break;
        }
      } catch {}
    }
  }

  if (values.json) {
    let sections = [];
    if (changelogText) {
      sections = parseVersionHeaders(changelogText, limit);
    }
    printJson({
      ok: true,
      kind: "better.changelog-view",
      package: pkgName,
      latest,
      repository: repoUrl || null,
      recentVersions: versionTimes.map(([v, t]) => ({ version: v, published: t })),
      changelog: sections.length > 0 ? sections : null,
      source: changelogText ? "github" : "registry",
    });
    return;
  }

  printText(`\n\x1b[1mbetter changelog-view\x1b[0m — \x1b[1m${pkgName}\x1b[0m\n`);
  printText(`  Latest: ${latest || "—"}  Repository: ${repoUrl ? repoUrl.replace(/^git\+/, "").replace(/\.git$/, "") : "—"}\n`);

  if (changelogText) {
    const sections = parseVersionHeaders(changelogText, limit);
    if (sections.length > 0) {
      for (const s of sections) {
        printText(`\x1b[1m## ${s.version}\x1b[0m${s.meta ? `  \x1b[90m${s.meta}\x1b[0m` : ""}`);
        const body = s.lines.join("\n").trim();
        const truncated = body.length > 800 ? body.slice(0, 800) + "\n\x1b[90m… (truncated)\x1b[0m" : body;
        printText(truncated || "\x1b[90m(no details)\x1b[0m");
        printText("");
      }
    } else {
      printText(`\x1b[90mCould not parse version sections from changelog.\x1b[0m`);
    }
  } else {
    // Fallback: show recent versions from registry time map
    printText(`\x1b[90mNo changelog found. Recent versions:\x1b[0m\n`);
    for (const [v, t] of versionTimes) {
      const d = new Date(t).toISOString().split("T")[0];
      printText(`  \x1b[1mv${v}\x1b[0m  \x1b[90m${d}\x1b[0m`);
    }
    if (ownerRepo) {
      printText(`\n\x1b[90mCheck: https://github.com/${ownerRepo}/releases\x1b[0m`);
    }
  }
  printText("");
}
