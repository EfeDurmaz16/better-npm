import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better semver` — semantic version analysis and prediction
 *
 * Analyzes package release history to:
 * - Predict when the next major/minor/patch will ship
 * - Identify packages likely to have breaking changes soon
 * - Score release stability (regularity of releases)
 */
export async function cmdSemver(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better semver <package> [options]
  better semver --all [options]

Analyze semantic versioning patterns and predict release cadence.

Options:
  --all          Analyze all direct dependencies
  --predict      Show predicted next release date
  --stability    Show release stability score
  --json         Machine-readable output
  -h, --help     Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      all: { type: "boolean", default: false },
      predict: { type: "boolean", default: true },
      stability: { type: "boolean", default: true },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const pkgPath = path.join(projectRoot, "package.json");
  let pkg = {};
  try { pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")); } catch {}

  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const targets = values.all ? Object.keys(allDeps).slice(0, 15) : [positionals[0]].filter(Boolean);

  if (targets.length === 0) {
    printText("Error: specify a package or use --all");
    process.exitCode = 1;
    return;
  }

  const analyses = await Promise.all(targets.map(analyzeSemver));

  const result = {
    ok: true,
    kind: "better.semver",
    packages: analyses,
  };

  if (values.json) {
    printJson(result);
    return;
  }

  for (const a of analyses) {
    const lines = [`${a.name} — stability: ${a.stabilityScore}/10`];
    lines.push(`  Current: ${a.currentVersion}, Latest: ${a.latestVersion}`);
    lines.push(`  Release cadence: ~${a.avgDaysBetweenReleases} days`);
    if (a.predictedNextRelease) lines.push(`  Next release predicted: ~${a.predictedNextRelease}`);
    if (a.likelyBreaking) lines.push(`  ⚠ Major version change likely in next release`);
    printText(lines.join("\n"));
  }
}

async function analyzeSemver(name) {
  try {
    const resp = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (!resp.ok) return { name, error: "Not found" };
    const data = await resp.json();

    const times = Object.entries(data.time || {})
      .filter(([k]) => k !== "created" && k !== "modified" && /^\d+\.\d+\.\d+$/.test(k))
      .map(([ver, time]) => ({ ver, time: new Date(time).getTime() }))
      .sort((a, b) => a.time - b.time);

    const latestVersion = data["dist-tags"]?.latest || "unknown";
    const currentTime = Date.now();

    // Calculate average days between releases
    let totalDays = 0;
    let majorBumps = 0;
    for (let i = 1; i < times.length; i++) {
      totalDays += (times[i].time - times[i-1].time) / 86400000;
      const prevMajor = parseInt(times[i-1].ver.split(".")[0]);
      const currMajor = parseInt(times[i].ver.split(".")[0]);
      if (currMajor > prevMajor) majorBumps++;
    }
    const avgDaysBetweenReleases = times.length > 1
      ? Math.round(totalDays / (times.length - 1))
      : 365;

    // Stability score: frequent, regular releases = high score
    const lastRelease = times[times.length - 1]?.time || 0;
    const daysSinceLast = (currentTime - lastRelease) / 86400000;
    const overdue = daysSinceLast / avgDaysBetweenReleases;
    const stabilityScore = Math.max(0, Math.min(10, 10 - (overdue - 1) * 2)).toFixed(1);

    // Predict next release
    const predictedNext = new Date(lastRelease + avgDaysBetweenReleases * 86400000);
    const daysUntilNext = Math.round((predictedNext.getTime() - currentTime) / 86400000);

    // Major version change likelihood
    const majorRate = majorBumps / Math.max(times.length, 1);
    const likelyBreaking = majorRate > 0.1 && overdue > 0.8;

    return {
      name,
      currentVersion: latestVersion,
      latestVersion,
      totalReleases: times.length,
      avgDaysBetweenReleases,
      stabilityScore: parseFloat(stabilityScore),
      predictedNextRelease: daysUntilNext > 0 ? `${daysUntilNext} days` : "overdue",
      likelyBreaking,
    };
  } catch {
    return { name, error: "Analysis failed" };
  }
}
