/**
 * better contributors-check — verify contributors/authors in installed packages
 *
 * Checks packages for unusual maintainer changes, new publishers,
 * and packages with very few maintainers (bus factor risk).
 *
 * Usage:
 *   better contributors-check
 *   better contributors-check lodash react
 *   better contributors-check --min-maintainers 2
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

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

export async function cmdContributorsCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:              { type: "boolean", default: runtime.json === true },
      help:              { type: "boolean", short: "h", default: false },
      "min-maintainers": { type: "string", default: "2" },
      "new-publisher":   { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better contributors-check [packages...] [options]

Check packages for bus factor risk and unusual publisher changes.

Options:
  --min-maintainers <n>  Warn if fewer than n maintainers (default: 2)
  --new-publisher        Focus on packages where latest publisher differs from historic
  --json                 Machine-readable output
  -h, --help             Show this help

Examples:
  better contributors-check
  better contributors-check lodash express
  better contributors-check --min-maintainers 3
`);
    return;
  }

  const minMaintainers = parseInt(values["min-maintainers"]) || 2;
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

  const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
  const targets = positionals.length > 0 ? positionals : Object.keys(allDeps);

  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking maintainers for ${targets.length} package(s)…\x1b[0m\n`);
  }

  const BATCH = 5;
  const results = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (name) => {
      const meta = await fetchPackageMeta(name);
      if (!meta) return null;

      const maintainers = meta.maintainers || [];
      const latestVersion = meta["dist-tags"]?.latest;
      const latestMeta = latestVersion ? meta.versions?.[latestVersion] : null;
      const publisher = latestMeta?._npmUser?.name || null;

      // Check if publisher is a current maintainer
      const maintainerNames = maintainers.map(m => m.name);
      const publisherIsMaintainer = !publisher || maintainerNames.includes(publisher);

      const issues = [];
      if (maintainers.length < minMaintainers) {
        issues.push({
          type: "low-maintainer-count",
          message: `Only ${maintainers.length} maintainer(s) — bus factor risk`,
          severity: maintainers.length === 1 ? "warning" : "info",
        });
      }

      if (publisher && !publisherIsMaintainer) {
        issues.push({
          type: "new-publisher",
          message: `Latest publisher "${publisher}" is not in maintainers list`,
          severity: "warning",
        });
      }

      if (issues.length === 0) return null;

      return {
        name,
        version: latestVersion,
        maintainerCount: maintainers.length,
        maintainers: maintainerNames,
        publisher,
        issues,
        severity: issues.some(i => i.severity === "warning") ? "warning" : "info",
      };
    }));

    results.push(...batchResults.filter(Boolean));
  }

  results.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "warning" ? -1 : 1;
    return a.maintainerCount - b.maintainerCount;
  });

  if (values.json) {
    printJson({
      ok: results.every(r => r.severity !== "error"),
      kind: "better.contributors-check",
      totalChecked: targets.length,
      flagged: results.length,
      packages: results,
    });
    return;
  }

  printText(`\n\x1b[1mbetter contributors-check\x1b[0m — ${targets.length} packages checked\n`);

  if (results.length === 0) {
    printText(`\x1b[32m✔ No maintainer concerns found.\x1b[0m\n`);
    return;
  }

  for (const r of results) {
    const icon = r.severity === "warning" ? "\x1b[33m⚠\x1b[0m" : "\x1b[90m·\x1b[0m";
    printText(`  ${icon}  \x1b[1m${r.name}\x1b[0m@${r.version}  \x1b[90m${r.maintainerCount} maintainer(s)\x1b[0m`);

    for (const issue of r.issues) {
      const col = issue.severity === "warning" ? "\x1b[33m" : "\x1b[90m";
      printText(`       ${col}→ ${issue.message}\x1b[0m`);
    }

    if (r.maintainers.length <= 3) {
      printText(`       \x1b[90mMaintainers: ${r.maintainers.join(", ")}\x1b[0m`);
    }
  }

  printText("");
}
