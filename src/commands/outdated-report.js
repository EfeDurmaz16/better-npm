/**
 * better outdated-report — generate a detailed outdated dependencies report
 *
 * Runs npm outdated and enriches the output with changelog snippets,
 * release dates, breaking change warnings, and grouping by update type.
 *
 * Usage:
 *   better outdated-report
 *   better outdated-report --prod-only
 *   better outdated-report --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "better-npm/1.0" }, timeout: 8000 }, (res) => {
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

function parseSemver(v) {
  const m = String(v || "0").replace(/[^0-9.]/g, "").split(".");
  return [parseInt(m[0]) || 0, parseInt(m[1]) || 0, parseInt(m[2]) || 0];
}

function bumpType(current, latest) {
  if (!current || !latest) return "unknown";
  const [cmaj, cmin] = parseSemver(current);
  const [lmaj, lmin] = parseSemver(latest);
  if (lmaj > cmaj) return "major";
  if (lmin > cmin) return "minor";
  return "patch";
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

export async function cmdOutdatedReport(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      "prod-only":{ type: "boolean", default: false },
      "no-enrich":{ type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better outdated-report [options]

Generate a detailed outdated dependencies report.

Options:
  --prod-only    Only report on production dependencies
  --no-enrich    Skip fetching release dates from registry
  --json         Machine-readable output
  -h, --help     Show this help

Shows packages grouped by major/minor/patch update type with
release dates and age of current version.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter outdated-report\x1b[0m\n`);
    process.stderr.write(`\x1b[90mRunning npm outdated…\x1b[0m\n`);
  }

  const outdatedArgs = ["outdated", "--json"];
  if (values["prod-only"]) outdatedArgs.push("--prod");

  const outdatedResult = spawnSync("npm", outdatedArgs, {
    cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });

  let outdatedData = {};
  try { outdatedData = JSON.parse(outdatedResult.stdout) || {}; } catch {}

  const packages = Object.entries(outdatedData).map(([name, info]) => ({
    name,
    current: info.current || "?",
    wanted: info.wanted || "?",
    latest: info.latest || "?",
    type: info.type || "dependencies",
    bump: bumpType(info.current, info.latest),
  }));

  if (packages.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.outdated-report", upToDate: true, packages: [] }); }
    else { printText(`\x1b[32m✔ All dependencies are up to date.\x1b[0m\n`); }
    return;
  }

  // Enrich with release dates
  if (!values["no-enrich"]) {
    if (!values.json) {
      process.stderr.write(`\x1b[90mFetching release dates for ${packages.length} packages…\x1b[0m\n`);
    }
    const BATCH = 8;
    for (let i = 0; i < packages.length; i += BATCH) {
      const batch = packages.slice(i, i + BATCH);
      await Promise.all(batch.map(async (pkg) => {
        try {
          const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`);
          if (res.status === 200) {
            const meta = JSON.parse(res.body);
            const timeMap = meta.time || {};
            pkg.currentDate = timeMap[pkg.current] || null;
            pkg.latestDate = timeMap[pkg.latest] || null;
            pkg.currentAge = daysSince(pkg.currentDate);
            pkg.deprecated = !!meta.versions?.[pkg.latest]?.deprecated;
          }
        } catch {}
      }));
    }
  }

  // Group by bump type
  const groups = {
    major: packages.filter(p => p.bump === "major"),
    minor: packages.filter(p => p.bump === "minor"),
    patch: packages.filter(p => p.bump === "patch"),
    unknown: packages.filter(p => p.bump === "unknown"),
  };

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.outdated-report",
      total: packages.length,
      major: groups.major.length,
      minor: groups.minor.length,
      patch: groups.patch.length,
      packages,
    });
    return;
  }

  function fmtAge(days) {
    if (days === null || days === undefined) return "";
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.round(days / 30)}mo`;
    return `${(days / 365).toFixed(1)}y`;
  }

  const printGroup = (label, pkgs, color) => {
    if (pkgs.length === 0) return;
    printText(`\n${color}${label} updates (${pkgs.length})\x1b[0m`);
    printText(`  \x1b[90m${"Name".padEnd(28)} ${"Current".padStart(10)}  ${"Latest".padStart(10)}  Age\x1b[0m`);
    for (const pkg of pkgs) {
      const age = pkg.currentAge !== undefined ? `\x1b[90m${fmtAge(pkg.currentAge)}\x1b[0m` : "";
      const dep = pkg.deprecated ? " \x1b[31m[deprecated]\x1b[0m" : "";
      printText(`  ${pkg.name.padEnd(28)} ${pkg.current.padStart(10)}  ${color}${pkg.latest.padStart(10)}\x1b[0m  ${age}${dep}`);
    }
  };

  printGroup("MAJOR", groups.major, "\x1b[31m");
  printGroup("MINOR", groups.minor, "\x1b[33m");
  printGroup("PATCH", groups.patch, "\x1b[32m");

  printText(`\n\x1b[90m${"─".repeat(55)}\x1b[0m`);
  printText(`  Total: ${packages.length} outdated  \x1b[31mmajor: ${groups.major.length}\x1b[0m  \x1b[33mminor: ${groups.minor.length}\x1b[0m  \x1b[32mpatch: ${groups.patch.length}\x1b[0m`);
  printText(`\n  \x1b[90mRun: npm update           (patch + minor)`);
  printText(`  Run: npx npm-check-updates  (all including major)\x1b[0m`);
  printText("");
}
