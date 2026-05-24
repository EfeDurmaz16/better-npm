import { parseArgs } from "node:util";
import https from "node:https";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { runReputationScoreNapi } from "../lib/core.js";

export async function cmdReputation(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better reputation <package> [options]

Score an npm (or other ecosystem) package's reputation.
Checks maintainer health, security posture, activity, and community trust.

Options:
  --ecosystem npm|pypi|cargo|go  Package ecosystem (default: npm)
  --version VERSION              Package version to score (default: latest)
  --offline                      Use static fallback only (no network)
  --json                         Machine-readable JSON output
  -h, --help                     Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      ecosystem: { type: "string", default: "npm" },
      version: { type: "string", default: "latest" },
      offline: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false
  });

  const packageName = positionals[0];
  if (!packageName) {
    const err = { ok: false, kind: "better.reputation", error: "missing_package_name" };
    if (values.json) printJson(err);
    else printText("Error: package name required (e.g. better reputation lodash)");
    process.exitCode = 1;
    return;
  }

  const ecosystem = values.ecosystem ?? "npm";
  const version = values.version ?? "latest";

  // NAPI fast path — uses live signals from registry + OSV
  const result = runReputationScoreNapi(packageName, ecosystem, version);

  if (result !== null && result.ok) {
    const out = {
      ok: true,
      kind: "better.reputation",
      schemaVersion: 1,
      package: result.package,
      version: result.version,
      score: result.score,
      grade: result.grade,
      breakdown: result.breakdown,
      flags: result.flags,
      computed_at: result.computed_at
    };
    if (values.json) {
      printJson(out);
    } else {
      const gradeColor = result.grade === "A" ? "✓" : result.grade === "B" ? "+" : result.grade === "C" ? "~" : "✗";
      const lines = [
        `Reputation: ${packageName}@${result.version}`,
        `Score: ${gradeColor} ${result.score}/100 (${result.grade})`,
        "",
        "Breakdown:",
        `  Maintainer Health : ${result.breakdown.maintainer_health.toFixed(1)}/25`,
        `  Security Posture  : ${result.breakdown.security_posture.toFixed(1)}/25`,
        `  Activity Vitality : ${result.breakdown.activity_vitality.toFixed(1)}/25`,
        `  Community Trust   : ${result.breakdown.community_trust.toFixed(1)}/25`
      ];
      if (result.flags.length > 0) {
        lines.push("", "Flags:");
        for (const f of result.flags) {
          const icon = f.severity === "critical" ? "!!" : f.severity === "high" ? "!" : f.severity === "medium" ? "~" : "-";
          lines.push(`  [${icon}] ${f.message}`);
        }
      }
      printText(lines.join("\n"));
    }
    return;
  }

  // JS fallback: try live npm registry data, else use static heuristics
  const fallback = values.offline
    ? staticFallback(packageName)
    : await scoreFromRegistry(packageName, ecosystem, version);

  const out = {
    ok: true,
    kind: "better.reputation",
    schemaVersion: 1,
    package: packageName,
    version: fallback.version ?? version,
    score: fallback.score,
    grade: fallback.grade,
    breakdown: fallback.breakdown,
    flags: fallback.flags,
    computed_at: new Date().toISOString(),
    note: fallback.note ?? "js_fallback"
  };

  if (values.json) {
    printJson(out);
  } else {
    const lines = [
      `Reputation: ${packageName}@${out.version}`,
      `Score: ${out.score}/100 (${out.grade})${fallback.note === "offline" ? " [offline estimate]" : ""}`,
      "",
      "Breakdown:",
      `  Maintainer Health : ${out.breakdown.maintainer_health.toFixed(1)}/25`,
      `  Security Posture  : ${out.breakdown.security_posture.toFixed(1)}/25`,
      `  Activity Vitality : ${out.breakdown.activity_vitality.toFixed(1)}/25`,
      `  Community Trust   : ${out.breakdown.community_trust.toFixed(1)}/25`
    ];
    if (out.flags.length > 0) {
      lines.push("", "Flags:");
      for (const f of out.flags) {
        const icon = f.severity === "critical" ? "!!" : f.severity === "high" ? "!" : "~";
        lines.push(`  [${icon}] ${f.message}`);
      }
    }
    printText(lines.join("\n"));
  }
}

/** Known deprecated/problematic packages */
const KNOWN_DEPRECATED = new Set(["request", "node-uuid", "tslint", "bower", "grunt-cli", "jade", "stylus", "inferno-compat", "ejs-lint"]);

/** Well-known high-trust packages (bonus score) */
const WELL_KNOWN_TRUSTED = new Set(["react", "vue", "angular", "lodash", "express", "typescript", "webpack", "babel", "eslint", "prettier", "jest", "mocha", "chalk", "axios", "moment", "underscore", "jquery", "next", "nuxt", "vite", "rollup", "esbuild", "vitest", "fastify", "koa", "hapi", "mongoose", "sequelize", "prisma", "drizzle-orm", "zod", "yup", "joi", "dotenv", "cross-env", "rimraf", "glob", "minimist", "yargs", "commander", "inquirer", "ora", "boxen", "chalk", "kleur", "picocolors"]);

function gradeFromScore(score) {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  if (score >= 30) return "D";
  return "F";
}

/** Fetch from npm registry and compute reputation score */
async function scoreFromRegistry(packageName, ecosystem, version) {
  if (ecosystem !== "npm") {
    return staticFallback(packageName);
  }

  try {
    const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
    if (!meta || meta.error) return staticFallback(packageName);

    const flags = [];
    const latest = meta["dist-tags"]?.latest ?? version;
    const latestMeta = meta.versions?.[latest] ?? {};
    const isDeprecated = !!latestMeta.deprecated || KNOWN_DEPRECATED.has(packageName);

    // Activity vitality (0-25): recency of publish, deprecation
    let activity = 0;
    const lastPublished = meta.time?.[latest] ?? meta.time?.modified ?? null;
    if (lastPublished) {
      const daysSince = (Date.now() - new Date(lastPublished).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 30)       activity += 20;
      else if (daysSince < 90)  activity += 17;
      else if (daysSince < 180) activity += 14;
      else if (daysSince < 365) activity += 10;
      else if (daysSince < 730) activity += 6;
      else                      activity += 2;
    }
    if (!isDeprecated) activity += 5;
    else {
      flags.push({ severity: "high", message: `${packageName} is deprecated${latestMeta.deprecated ? ": " + String(latestMeta.deprecated).slice(0, 80) : ""}` });
    }
    activity = Math.min(25, activity);

    // Maintainer health (0-25): maintainer count
    const maintainerCount = (meta.maintainers ?? []).length;
    let maintainerHealth = 0;
    if (maintainerCount >= 5)      maintainerHealth = 25;
    else if (maintainerCount >= 3) maintainerHealth = 20;
    else if (maintainerCount >= 2) maintainerHealth = 15;
    else if (maintainerCount === 1) maintainerHealth = 10;
    if (maintainerCount === 1) flags.push({ severity: "low", message: "Single maintainer (bus factor 1)" });

    // Quality / security posture (0-25): readme, license, homepage, repo, description
    let quality = 0;
    if (latestMeta.description || meta.description) quality += 4;
    if (latestMeta.license || meta.license) quality += 6;
    else flags.push({ severity: "medium", message: "No license declared" });
    if (latestMeta.homepage || meta.homepage) quality += 4;
    if (latestMeta.repository || meta.repository) quality += 5;
    if (meta.readme && meta.readme.length > 200) quality += 6;

    // Community trust (0-25): version count, time in registry, well-known bonus
    let community = 0;
    const versionCount = Object.keys(meta.versions ?? {}).length;
    const firstPublished = meta.time?.created ? (Date.now() - new Date(meta.time.created).getTime()) / (1000 * 60 * 60 * 24 * 365) : 0;
    if (firstPublished >= 3)      community += 10;
    else if (firstPublished >= 1) community += 7;
    else if (firstPublished >= 0.5) community += 4;
    if (versionCount >= 50) community += 8;
    else if (versionCount >= 20) community += 6;
    else if (versionCount >= 5)  community += 4;
    else community += 2;
    if (WELL_KNOWN_TRUSTED.has(packageName)) community = Math.min(25, community + 7);

    const score = Math.min(100, Math.round(activity + maintainerHealth + quality + community));
    const grade = gradeFromScore(score);

    return {
      version: latest,
      score,
      grade,
      breakdown: {
        maintainer_health: maintainerHealth,
        security_posture: quality,
        activity_vitality: activity,
        community_trust: community
      },
      flags,
      note: "npm_registry"
    };
  } catch {
    return staticFallback(packageName);
  }
}

/** Minimal static scoring — no network */
function staticFallback(packageName) {
  const isKnownDeprecated = KNOWN_DEPRECATED.has(packageName);
  const isWellKnown = WELL_KNOWN_TRUSTED.has(packageName);
  const flags = [];

  let score = 50;
  if (isKnownDeprecated) {
    score = 25;
    flags.push({ severity: "high", message: `${packageName} is a deprecated package` });
  } else if (isWellKnown) {
    score = 80;
  }

  const quarter = score / 4;
  return {
    score,
    grade: gradeFromScore(score),
    breakdown: {
      maintainer_health: quarter,
      security_posture: quarter,
      activity_vitality: quarter,
      community_trust: quarter
    },
    flags,
    note: "offline"
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "better-npm/1.0" } }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}
