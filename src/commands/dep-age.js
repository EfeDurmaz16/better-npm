/**
 * better dep-age — show the age of installed dependencies
 *
 * Fetches publication dates from npm registry and reports
 * how old each installed dependency version is. Flags
 * stale packages that haven't been updated in a long time.
 *
 * Usage:
 *   better dep-age
 *   better dep-age --threshold 365  (warn if > 1 year old)
 *   better dep-age --top 20
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fetchPublishTime(name, version) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    https.get(`https://registry.npmjs.org/${encoded}`, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 6000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(data.time?.[version] || null);
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

function ageInDays(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function fmtAge(days) {
  if (days === null) return "unknown";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  return months > 0 ? `${years}y ${months}mo` : `${years}y`;
}

export async function cmdDepAge(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:      { type: "boolean", default: runtime.json === true },
      help:      { type: "boolean", short: "h", default: false },
      threshold: { type: "string" },
      top:       { type: "string" },
      dev:       { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better dep-age [options]

Show the age of installed dependency versions.

Options:
  --threshold <days>  Warn if dependency is older than N days (default: 730)
  --top <N>           Show only the N oldest packages (default: all)
  --dev               Include devDependencies
  --json              Machine-readable output
  -h, --help          Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const thresholdDays = parseInt(values.threshold) || 730; // 2 years

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const prodDeps = Object.keys(pkgJson.dependencies || {});
  const devDeps = values.dev ? Object.keys(pkgJson.devDependencies || {}) : [];
  const allDeps = [...prodDeps, ...devDeps];

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching age data for ${allDeps.length} packages…\x1b[0m\n`);
  }

  // Get installed versions from node_modules
  const nmPath = path.join(projectRoot, "node_modules");
  const results = [];

  const BATCH = 8;
  for (let i = 0; i < allDeps.length; i += BATCH) {
    const batch = allDeps.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (name) => {
      let installedVersion = null;
      try {
        const depPkg = JSON.parse(
          await fs.readFile(path.join(nmPath, name, "package.json"), "utf8")
        );
        installedVersion = depPkg.version;
      } catch {}

      const publishTime = installedVersion
        ? await fetchPublishTime(name, installedVersion)
        : null;

      const days = ageInDays(publishTime);
      return {
        name,
        version: installedVersion,
        publishedAt: publishTime,
        ageDays: days,
        ageStr: fmtAge(days),
        stale: days !== null && days > thresholdDays,
        isDev: devDeps.includes(name),
      };
    }));
    results.push(...batchResults);
  }

  // Sort by age descending (oldest first)
  results.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));

  const stale = results.filter(r => r.stale);
  const topN = values.top ? parseInt(values.top) : null;
  const display = topN ? results.slice(0, topN) : results;

  if (values.json) {
    printJson({
      ok: stale.length === 0,
      kind: "better.dep-age",
      checked: results.length,
      stale: stale.length,
      thresholdDays,
      packages: results,
    });
    return;
  }

  printText(`\n\x1b[1mbetter dep-age\x1b[0m — ${allDeps.length} packages\n`);

  for (const r of display) {
    const ageColor = !r.ageDays ? "\x1b[90m"
      : r.stale ? "\x1b[31m"
      : r.ageDays > thresholdDays * 0.75 ? "\x1b[33m"
      : "\x1b[32m";
    const devTag = r.isDev ? " \x1b[90m(dev)\x1b[0m" : "";
    const ver = r.version ? `@${r.version}` : "";
    printText(`  ${ageColor}${r.ageStr.padStart(7)}\x1b[0m  ${r.name}${ver}${devTag}`);
  }

  printText("");
  if (stale.length > 0) {
    printText(`\x1b[33m⚠ ${stale.length} package(s) older than ${thresholdDays} days:\x1b[0m`);
    printText(`\x1b[90mRun: better outdated — to see available updates\x1b[0m`);
  } else {
    printText(`\x1b[32m✔ All dependencies are up to date.\x1b[0m`);
  }
}
