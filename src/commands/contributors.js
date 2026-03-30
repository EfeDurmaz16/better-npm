/**
 * better contributors — analyze dependency contributors and bus factor
 *
 * Shows maintainer info for installed packages using npm registry data.
 * Identifies single-maintainer packages (high bus factor risk).
 *
 * Usage:
 *   better contributors               # check direct deps
 *   better contributors --all         # include transitive
 *   better contributors --threshold 2 # flag pkgs with ≤2 maintainers
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function fetchMaintainers(name) {
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
    https.get(url, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const maintainers = (data.maintainers || []).map(m =>
            typeof m === "string" ? m : (m.name || m.email || "?")
          );
          const downloads = null; // would need another API call
          resolve({
            name,
            version: data.version,
            maintainers,
            maintainerCount: maintainers.length,
            deprecated: data.deprecated || null,
            publishedAt: data.time?.modified || null,
          });
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

export async function cmdContributors(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      all: { type: "boolean", default: false },
      threshold: { type: "string", default: "1" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better contributors [options]

Analyze package maintainers and bus factor risk.

Options:
  --all              Include transitive dependencies
  --threshold N      Flag packages with ≤N maintainers (default: 1)
  --json             Machine-readable output
  -h, --help         Show this help

Examples:
  better contributors
  better contributors --threshold 2
  better contributors --all --json
`);
    return;
  }

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

  let packageNames;
  if (values.all) {
    try {
      const lock = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
      packageNames = Object.keys(lock.packages || {})
        .filter(p => p && p !== "" && p.startsWith("node_modules/") && !p.includes("/node_modules/", 13))
        .map(p => p.slice(13))
        .filter(Boolean);
    } catch {
      packageNames = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });
    }
  } else {
    packageNames = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });
  }

  if (packageNames.length === 0) {
    const msg = "No dependencies found.";
    if (values.json) { printJson({ ok: true, kind: "better.contributors", packages: [], message: msg }); }
    else { printText(msg); }
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching maintainer info for ${packageNames.length} packages…\x1b[0m\n`);
  }

  const threshold = parseInt(values.threshold) || 1;
  const BATCH = 5;
  const results = [];

  for (let i = 0; i < packageNames.length; i += BATCH) {
    const batch = packageNames.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(fetchMaintainers));
    results.push(...batchResults.filter(Boolean));
  }

  const highRisk = results.filter(r => r.maintainerCount <= threshold);
  const allOk = highRisk.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.contributors",
      threshold,
      packages: results,
      high_risk: highRisk,
      total: results.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter contributors\x1b[0m — ${results.length} packages\n`);

  if (highRisk.length === 0) {
    printText(`\x1b[32m✔ No high bus-factor risk (all packages have >${threshold} maintainer(s)).\x1b[0m`);
  } else {
    printText(`\x1b[31m${highRisk.length} package(s) with ≤${threshold} maintainer(s):\x1b[0m\n`);
    for (const pkg of highRisk.sort((a, b) => a.maintainerCount - b.maintainerCount)) {
      const maintStr = pkg.maintainers.slice(0, 3).join(", ");
      printText(`  \x1b[31m✖\x1b[0m  ${pkg.name.padEnd(36)} \x1b[90m${pkg.maintainerCount} maintainer(s): ${maintStr}\x1b[0m`);
    }
    process.exitCode = 1;
  }

  // Show multi-maintainer summary
  const multiMaintainer = results.filter(r => r.maintainerCount > 3);
  if (multiMaintainer.length > 0) {
    printText(`\n\x1b[90m${multiMaintainer.length} packages have >3 maintainers (healthy).\x1b[0m`);
  }
}
