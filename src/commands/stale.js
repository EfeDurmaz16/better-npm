/**
 * better stale — find potentially abandoned packages
 *
 * Checks installed packages for signs of abandonment:
 * no release in a long time, deprecated, or unpublished.
 *
 * Usage:
 *   better stale
 *   better stale --days 365
 *   better stale --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const DEFAULT_DAYS = 365;

function fetchPackageMeta(name) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    https.get(`https://registry.npmjs.org/${encoded}`, {
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

function daysSince(isoDate) {
  if (!isoDate) return null;
  const ms = Date.now() - new Date(isoDate).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function fmtDays(days) {
  if (days === null) return "unknown";
  if (days >= 365) return `${Math.floor(days / 365)}y ${Math.floor((days % 365) / 30)}m ago`;
  if (days >= 30)  return `${Math.floor(days / 30)}m ${days % 30}d ago`;
  return `${days}d ago`;
}

export async function cmdStale(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      days:   { type: "string", default: String(DEFAULT_DAYS) },
      dev:    { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better stale [packages...] [options]

Find potentially abandoned or unmaintained packages.

Options:
  --days <n>   Days without a release to consider stale (default: ${DEFAULT_DAYS})
  --dev        Include devDependencies
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better stale
  better stale --days 180
  better stale --dev
`);
    return;
  }

  const threshold = parseInt(values.days) || DEFAULT_DAYS;

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const allDeps = values.dev
    ? { ...pkgJson.dependencies, ...pkgJson.devDependencies }
    : { ...pkgJson.dependencies };

  const targets = positionals.length > 0 ? positionals : Object.keys(allDeps);

  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking ${targets.length} package(s) for staleness (threshold: ${threshold} days)…\x1b[0m\n`);
  }

  const BATCH = 6;
  const results = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (name) => {
      const meta = await fetchPackageMeta(name);
      if (!meta) return null;

      const latestVersion = meta["dist-tags"]?.latest;
      if (!latestVersion) return null;

      const latestPublishDate = meta.time?.[latestVersion];
      const deprecated = meta.versions?.[latestVersion]?.deprecated || null;
      const unpublished = meta.time?.unpublished ? true : false;
      const age = daysSince(latestPublishDate);

      const isStale = age !== null && age >= threshold;
      const isDeprecated = !!deprecated;
      const isUnpublished = unpublished;

      if (!isStale && !isDeprecated && !isUnpublished) return null;

      return {
        name,
        latestVersion,
        latestPublishDate: latestPublishDate || null,
        daysSinceUpdate: age,
        stale: isStale,
        deprecated: isDeprecated,
        deprecatedMessage: typeof deprecated === "string" ? deprecated : null,
        unpublished: isUnpublished,
        severity: isDeprecated || isUnpublished ? "error" : (age >= threshold * 2 ? "error" : "warning"),
      };
    }));

    results.push(...batchResults.filter(Boolean));
  }

  results.sort((a, b) => {
    // Sort by severity then by age
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return (b.daysSinceUpdate || 0) - (a.daysSinceUpdate || 0);
  });

  if (values.json) {
    printJson({
      ok: results.length === 0,
      kind: "better.stale",
      threshold,
      totalChecked: targets.length,
      staleCount: results.length,
      packages: results,
    });
    return;
  }

  printText(`\n\x1b[1mbetter stale\x1b[0m — ${targets.length} packages checked (threshold: ${threshold} days)\n`);

  if (results.length === 0) {
    printText(`\x1b[32m✔ No stale or deprecated packages found.\x1b[0m`);
    return;
  }

  const errors = results.filter(r => r.severity === "error");
  const warnings = results.filter(r => r.severity === "warning");

  if (errors.length > 0) {
    printText(`\x1b[31m${errors.length} critical issue(s):\x1b[0m\n`);
    for (const r of errors) {
      printText(`  \x1b[31m✖\x1b[0m  \x1b[1m${r.name}\x1b[0m@${r.latestVersion}`);
      if (r.unpublished) {
        printText(`       \x1b[31mUnpublished from registry\x1b[0m`);
      } else if (r.deprecated) {
        printText(`       \x1b[31mDeprecated\x1b[0m${r.deprecatedMessage ? `: ${r.deprecatedMessage}` : ""}`);
      } else {
        printText(`       \x1b[31mNo release in ${fmtDays(r.daysSinceUpdate)}\x1b[0m`);
      }
    }
    printText("");
  }

  if (warnings.length > 0) {
    printText(`\x1b[33m${warnings.length} stale package(s):\x1b[0m\n`);
    for (const r of warnings) {
      printText(`  \x1b[33m⚠\x1b[0m  \x1b[1m${r.name}\x1b[0m@${r.latestVersion}  \x1b[90mlast updated ${fmtDays(r.daysSinceUpdate)}\x1b[0m`);
    }
    printText("");
  }

  printText(`\x1b[90mConsider replacing abandoned packages or looking for maintained forks.\x1b[0m`);
}
