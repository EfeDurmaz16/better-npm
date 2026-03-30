/**
 * better dep-changes — show what changed in a dependency's latest release
 *
 * Fetches the changelog or release notes for a package's latest version
 * and summarizes the changes since your currently installed version.
 *
 * Usage:
 *   better dep-changes lodash
 *   better dep-changes react next
 *   better dep-changes --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fetchJson(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 8000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

function parseSemver(v) {
  const s = String(v).replace(/^[~^>=v]/, "").split(".");
  return [parseInt(s[0]) || 0, parseInt(s[1]) || 0, parseInt(s[2]) || 0];
}

function semverGt(a, b) {
  const [am, ami, ap] = parseSemver(a);
  const [bm, bmi, bp] = parseSemver(b);
  if (am !== bm) return am > bm;
  if (ami !== bmi) return ami > bmi;
  return ap > bp;
}

function extractChangelogSnippet(readme, fromVersion, toVersion) {
  if (!readme) return null;

  // Look for version headers in README/CHANGELOG
  const lines = readme.split("\n");
  let inVersion = false;
  let snippet = [];
  const toVer = toVersion.replace(/^v/, "");

  for (const line of lines) {
    // Match version headers like ## 4.17.21, # v4.17.21, ### 4.17.21, etc.
    const headerMatch = line.match(/^#{1,3}\s+v?(\d+\.\d+[\.\d]*)/);
    if (headerMatch) {
      const ver = headerMatch[1];
      if (ver === toVer) {
        inVersion = true;
        snippet = [];
        continue;
      } else if (inVersion && snippet.length > 0) {
        break; // Hit next version
      }
    }

    if (inVersion && line.trim()) {
      snippet.push(line);
      if (snippet.length >= 20) break; // limit
    }
  }

  return snippet.length > 0 ? snippet.join("\n").trim() : null;
}

export async function cmdDepChanges(argv) {
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
    printText(`Usage: better dep-changes <package> [packages...] [options]

Show what changed in a dependency's latest release.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better dep-changes lodash
  better dep-changes react next eslint
`);
    return;
  }

  if (positionals.length === 0) {
    printText(`Usage: better dep-changes <package> [packages...] [--json]`);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching change info for ${positionals.length} package(s)…\x1b[0m\n`);
  }

  const results = await Promise.all(positionals.map(async (name) => {
    // Get installed version
    let installedVersion = null;
    try {
      const ipkg = JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
      installedVersion = ipkg.version;
    } catch {}

    // Get latest from registry
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    const meta = await fetchJson(`https://registry.npmjs.org/${encoded}/latest`);

    if (!meta) return { name, error: "not found" };

    const latestVersion = meta.version;
    const hasUpdate = installedVersion && semverGt(latestVersion, installedVersion);

    // Get changelog from readme
    const changelogSnippet = extractChangelogSnippet(meta.readme, installedVersion, latestVersion);

    // Get release info from registry full metadata
    const fullMeta = hasUpdate ? await fetchJson(`https://registry.npmjs.org/${encoded}`) : null;
    const versionsSince = fullMeta && installedVersion
      ? Object.keys(fullMeta.versions || {})
          .filter(v => !v.includes("-") && semverGt(v, installedVersion))
          .sort((a, b) => semverGt(a, b) ? 1 : -1)
      : [];

    return {
      name,
      installedVersion,
      latestVersion,
      hasUpdate,
      versionsBehind: versionsSince.length,
      versionsSince: versionsSince.slice(-10),
      changelogSnippet,
      changelog: meta.homepage || meta.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "") || null,
    };
  }));

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.dep-changes",
      results,
    });
    return;
  }

  for (const r of results) {
    printText(`\n\x1b[1m${r.name}\x1b[0m`);

    if (r.error) {
      printText(`  \x1b[31mError: ${r.error}\x1b[0m`);
      continue;
    }

    if (!r.installedVersion) {
      printText(`  \x1b[90mNot installed locally\x1b[0m`);
      printText(`  Latest: \x1b[1m${r.latestVersion}\x1b[0m`);
      continue;
    }

    if (!r.hasUpdate) {
      printText(`  \x1b[32m✔ Up to date\x1b[0m  \x1b[90m${r.installedVersion}\x1b[0m`);
      continue;
    }

    printText(`  \x1b[33m${r.installedVersion}\x1b[0m → \x1b[32m${r.latestVersion}\x1b[0m  \x1b[90m(${r.versionsBehind} version(s) behind)\x1b[0m`);

    if (r.versionsSince.length > 0 && r.versionsSince.length <= 5) {
      printText(`  \x1b[90mVersions: ${r.versionsSince.join(" → ")}\x1b[0m`);
    }

    if (r.changelogSnippet) {
      printText(`\n  \x1b[1mChanges in ${r.latestVersion}:\x1b[0m`);
      const lines = r.changelogSnippet.split("\n").slice(0, 8);
      for (const line of lines) {
        printText(`  \x1b[90m${line}\x1b[0m`);
      }
    }

    if (r.changelog) {
      printText(`  \x1b[90mChangelog: ${r.changelog}\x1b[0m`);
    }
  }

  printText("");
}
