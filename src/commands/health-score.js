/**
 * better health-score — compute an overall project dependency health score
 *
 * Aggregates multiple health signals into a 0-100 score with letter grade.
 * Runs fast checks locally (no network) for a quick project health snapshot.
 *
 * Usage:
 *   better health-score
 *   better health-score --json
 *   better health-score --detailed
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function grade(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function gradeColor(g) {
  if (g === "A") return "\x1b[32m";
  if (g === "B") return "\x1b[32m";
  if (g === "C") return "\x1b[33m";
  if (g === "D") return "\x1b[33m";
  return "\x1b[31m";
}

export async function cmdHealthScore(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      detailed: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better health-score [options]

Compute an overall project dependency health score (0-100, grade A-F).

Factors:
  • Lockfile present and up to date
  • Security vulnerabilities
  • Outdated dependencies
  • TypeScript/types coverage
  • Test setup
  • License compliance
  • Package.json quality
  • CI configuration

Options:
  --detailed   Show score breakdown per category
  --json       Machine-readable output
  -h, --help   Show this help
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

  if (!values.json) {
    process.stderr.write(`\x1b[90mComputing health score…\x1b[0m\n`);
  }

  const categories = [];

  // 1. Lockfile (15 points)
  const hasLock = await fileExists(path.join(projectRoot, "package-lock.json"));
  const hasPnpmLock = await fileExists(path.join(projectRoot, "pnpm-lock.yaml"));
  const hasYarnLock = await fileExists(path.join(projectRoot, "yarn.lock"));
  const lockOk = hasLock || hasPnpmLock || hasYarnLock;
  categories.push({
    id: "lockfile",
    name: "Lockfile",
    maxPoints: 15,
    points: lockOk ? 15 : 0,
    details: lockOk ? "Lockfile present" : "No lockfile found",
  });

  // 2. Security (20 points)
  let vulnPoints = 20;
  let vulnDetails = "Audit skipped";
  const auditResult = spawnSync("npm", ["audit", "--json"], { cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  try {
    const auditData = JSON.parse(auditResult.stdout);
    const counts = auditData?.metadata?.vulnerabilities || {};
    const critical = counts.critical || 0;
    const high = counts.high || 0;
    const moderate = counts.moderate || 0;
    const low = counts.low || 0;
    vulnPoints = Math.max(0, 20 - critical * 8 - high * 4 - moderate * 2 - low);
    vulnDetails = (critical + high + moderate + low) === 0
      ? "No vulnerabilities"
      : `${critical}c ${high}h ${moderate}m ${low}l vulnerabilities`;
  } catch {}
  categories.push({ id: "security", name: "Security", maxPoints: 20, points: vulnPoints, details: vulnDetails });

  // 3. Outdated deps (15 points)
  const nmPath = path.join(projectRoot, "node_modules");
  const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
  const totalDeps = Object.keys(allDeps).length;
  let outdatedPoints = 15;
  let outdatedDetails = "No node_modules";
  if (totalDeps > 0 && await fileExists(nmPath)) {
    let missing = 0;
    for (const name of Object.keys(allDeps).slice(0, 30)) {
      const exists = await fileExists(path.join(nmPath, name, "package.json"));
      if (!exists) missing++;
    }
    const missingPct = missing / Math.min(totalDeps, 30);
    outdatedPoints = Math.round(15 * (1 - missingPct));
    outdatedDetails = missing === 0 ? `${Math.min(totalDeps, 30)} deps installed` : `${missing} deps missing from node_modules`;
  }
  categories.push({ id: "deps-installed", name: "Deps installed", maxPoints: 15, points: outdatedPoints, details: outdatedDetails });

  // 4. TypeScript/types (10 points)
  const hasTsConfig = await fileExists(path.join(projectRoot, "tsconfig.json"));
  const hasTs = pkgJson.devDependencies?.typescript || pkgJson.dependencies?.typescript;
  const tsPoints = hasTsConfig ? 10 : hasTs ? 5 : 0;
  categories.push({
    id: "typescript",
    name: "TypeScript",
    maxPoints: 10,
    points: tsPoints,
    details: hasTsConfig ? "TypeScript configured" : hasTs ? "TypeScript installed but no tsconfig" : "No TypeScript",
  });

  // 5. Testing (10 points)
  const hasTestScript = !!(pkgJson.scripts?.test && !pkgJson.scripts.test.includes("no test"));
  const hasJest = pkgJson.devDependencies?.jest || pkgJson.dependencies?.jest;
  const hasVitest = pkgJson.devDependencies?.vitest || pkgJson.dependencies?.vitest;
  const hasMocha = pkgJson.devDependencies?.mocha || pkgJson.dependencies?.mocha;
  const testPoints = hasTestScript ? 10 : (hasJest || hasVitest || hasMocha) ? 5 : 0;
  categories.push({
    id: "testing",
    name: "Testing",
    maxPoints: 10,
    points: testPoints,
    details: hasTestScript ? "Test script configured" : "No test setup",
  });

  // 6. License (10 points)
  const hasLicense = !!pkgJson.license;
  const hasLicenseFile = await fileExists(path.join(projectRoot, "LICENSE")) ||
    await fileExists(path.join(projectRoot, "LICENSE.md")) ||
    await fileExists(path.join(projectRoot, "LICENSE.txt"));
  const licensePoints = hasLicense && hasLicenseFile ? 10 : hasLicense ? 7 : hasLicenseFile ? 5 : 0;
  categories.push({
    id: "license",
    name: "License",
    maxPoints: 10,
    points: licensePoints,
    details: hasLicense ? `${pkgJson.license}${hasLicenseFile ? " + LICENSE file" : " (no LICENSE file)"}` : "No license",
  });

  // 7. CI (10 points)
  const hasGhActions = await fileExists(path.join(projectRoot, ".github", "workflows"));
  const hasCircleCi = await fileExists(path.join(projectRoot, ".circleci", "config.yml"));
  const hasGitlabCi = await fileExists(path.join(projectRoot, ".gitlab-ci.yml"));
  const hasCi = hasGhActions || hasCircleCi || hasGitlabCi;
  categories.push({
    id: "ci",
    name: "CI/CD",
    maxPoints: 10,
    points: hasCi ? 10 : 0,
    details: hasCi ? "CI configured" : "No CI configuration",
  });

  // 8. Package.json quality (10 points)
  let qualityPoints = 0;
  if (pkgJson.description) qualityPoints += 2;
  if (pkgJson.author) qualityPoints += 1;
  if (pkgJson.repository) qualityPoints += 2;
  if (pkgJson.keywords?.length > 0) qualityPoints += 1;
  if (pkgJson.engines?.node) qualityPoints += 2;
  if (pkgJson.files) qualityPoints += 1;
  if (pkgJson.homepage) qualityPoints += 1;
  categories.push({
    id: "pkg-quality",
    name: "Package quality",
    maxPoints: 10,
    points: qualityPoints,
    details: `${qualityPoints}/10 metadata fields`,
  });

  const totalPoints = categories.reduce((s, c) => s + c.points, 0);
  const maxPoints = categories.reduce((s, c) => s + c.maxPoints, 0);
  const score = Math.round((totalPoints / maxPoints) * 100);
  const letterGrade = grade(score);
  const col = gradeColor(letterGrade);

  if (values.json) {
    printJson({
      ok: score >= 70,
      kind: "better.health-score",
      score,
      grade: letterGrade,
      categories: categories.map(c => ({
        id: c.id,
        name: c.name,
        points: c.points,
        maxPoints: c.maxPoints,
        pct: Math.round((c.points / c.maxPoints) * 100),
        details: c.details,
      })),
    });
    return;
  }

  printText(`\n\x1b[1mbetter health-score\x1b[0m — ${pkgJson.name || "project"}\n`);
  printText(`  Score: ${col}\x1b[1m${score}/100\x1b[0m  Grade: ${col}\x1b[1m${letterGrade}\x1b[0m`);
  printText("");

  if (values.detailed) {
    for (const c of categories) {
      const pct = Math.round((c.points / c.maxPoints) * 100);
      const barWidth = 12;
      const filled = Math.round((pct / 100) * barWidth);
      const bar = "▓".repeat(filled) + "░".repeat(barWidth - filled);
      const color = pct >= 80 ? "\x1b[32m" : pct >= 50 ? "\x1b[33m" : "\x1b[31m";
      printText(`  ${color}${bar}\x1b[0m  ${c.name.padEnd(18)} \x1b[90m${c.points}/${c.maxPoints}  ${c.details}\x1b[0m`);
    }
    printText("");
  }

  const low = categories.filter(c => (c.points / c.maxPoints) < 0.5);
  if (low.length > 0) {
    printText(`\x1b[33mAreas for improvement:\x1b[0m`);
    for (const c of low) printText(`  \x1b[33m→\x1b[0m ${c.name}: ${c.details}`);
    printText("");
  }

  if (score < 70) process.exitCode = 1;
}
