import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { join } from "node:path";
import fs from "node:fs/promises";
import https from "node:https";

/**
 * `better changelog <package> [from] [to]`
 *
 * Fetch and display changelog/release notes for a package.
 */
export async function cmdChangelog(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    printText(`Usage: better changelog <package> [from@version] [to@version]

Fetch changelog and release notes for a package.

Examples:
  better changelog lodash
  better changelog react 17.0.0 18.0.0
  better changelog next --json

Options:
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const useJson = values.json;
  const packageName = positionals[0];
  if (!packageName) {
    if (useJson) { printJson({ ok: false, error: "Package name required" }); } else { printText("Error: package name required"); }
    process.exitCode = 1;
    return;
  }

  // Fetch npm registry metadata
  try {
    const meta = await fetchNpmMeta(packageName);
    const versions = Object.entries(meta.time || {})
      .filter(([v]) => v !== "created" && v !== "modified" && v !== "unpublished")
      .map(([version, date]) => ({ version, date }))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10);

    const repository = meta.repository?.url || "";
    const githubMatch = repository.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    const githubRepo = githubMatch ? githubMatch[1] : null;

    const result = {
      ok: true,
      kind: "better.changelog",
      package: packageName,
      latest: meta["dist-tags"]?.latest || "unknown",
      recent_versions: versions,
      repository: repository,
      github_releases_url: githubRepo ? `https://github.com/${githubRepo}/releases` : null,
      changelog_url: meta.bugs?.url ? null : (githubRepo ? `https://github.com/${githubRepo}/blob/main/CHANGELOG.md` : null),
    };

    if (useJson) {
      printJson(result);
    } else {
      printText(`\n${packageName} — recent releases\n`);
      printText(`Latest: ${result.latest}`);
      if (result.github_releases_url) {
        printText(`Releases: ${result.github_releases_url}`);
      }
      printText("\nRecent versions:");
      for (const v of versions) {
        printText(`  ${v.version.padEnd(12)} ${v.date.slice(0, 10)}`);
      }
    }
  } catch (err) {
    if (useJson) { printJson({ ok: false, error: err.message }); } else { printText(`Error: ${err.message}`); }
    process.exitCode = 1;
  }
}

function fetchNpmMeta(name) {
  return new Promise((resolve, reject) => {
    const encoded = name.startsWith("@") ? name.replace("/", "%2F") : name;
    const url = `https://registry.npmjs.org/${encoded}`;
    https.get(url, { timeout: 10000 }, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject).on("timeout", () => reject(new Error("Request timed out")));
  });
}
