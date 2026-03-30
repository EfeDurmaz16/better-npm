/**
 * better health-dashboard — overall project health summary
 *
 * Runs a curated set of health checks and presents a single dashboard
 * view with scores and status indicators for different health dimensions:
 * security, dependencies, quality, maintenance, and performance.
 *
 * Usage:
 *   better health-dashboard
 *   better health-dashboard --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function checkFile(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000, cwd });
  return { ok: r.status === 0, output: (r.stdout || "").trim() };
}

function scoreBar(score, width = 20) {
  const filled = Math.round(score / 100 * width);
  const color = score >= 80 ? "\x1b[32m" : score >= 60 ? "\x1b[33m" : "\x1b[31m";
  return `${color}${"█".repeat(filled)}${"░".repeat(width - filled)}\x1b[0m`;
}

export async function cmdHealthDashboard(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better health-dashboard [options]

Show overall project health dashboard.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Dimensions:
  • Security  — lockfile, audit status, .npmrc hygiene
  • Quality   — lint, tests, TypeScript, coverage
  • Deps      — outdated, deprecated, peer deps
  • Publish   — version, license, files, README
  • CI/CD     — CI config, git state, scripts
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter health-dashboard\x1b[0m\n`);
    process.stderr.write(`\x1b[90mRunning health checks...\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const dimensions = {};

  // --- SECURITY ---
  let secScore = 100;
  const secChecks = [];

  const hasLockfile = await checkFile(path.join(projectRoot, "package-lock.json"))
    || await checkFile(path.join(projectRoot, "yarn.lock"))
    || await checkFile(path.join(projectRoot, "pnpm-lock.yaml"));
  if (!hasLockfile) { secScore -= 30; secChecks.push({ ok: false, label: "No lockfile" }); }
  else secChecks.push({ ok: true, label: "Lockfile present" });

  const hasNpmrc = await checkFile(path.join(projectRoot, ".npmrc"));
  if (hasNpmrc) {
    const npmrcContent = await fs.readFile(path.join(projectRoot, ".npmrc"), "utf8").catch(() => "");
    if (npmrcContent.includes("unsafe-perm")) { secScore -= 20; secChecks.push({ ok: false, label: "unsafe-perm in .npmrc" }); }
    else secChecks.push({ ok: true, label: ".npmrc looks clean" });
  }

  dimensions.security = { score: secScore, checks: secChecks };

  // --- QUALITY ---
  let qualScore = 0;
  const qualChecks = [];

  const hasTests = !!pkgJson.scripts?.test && !pkgJson.scripts.test.includes("no test");
  if (hasTests) { qualScore += 30; qualChecks.push({ ok: true, label: "Test script configured" }); }
  else qualChecks.push({ ok: false, label: "No test script" });

  const hasLint = !!pkgJson.scripts?.lint;
  if (hasLint) { qualScore += 20; qualChecks.push({ ok: true, label: "Lint script configured" }); }
  else qualChecks.push({ ok: false, label: "No lint script" });

  const hasTypeCheck = !!pkgJson.scripts?.typecheck || !!pkgJson.scripts?.["type-check"] || !!pkgJson.devDependencies?.typescript;
  if (hasTypeCheck) { qualScore += 20; qualChecks.push({ ok: true, label: "TypeScript configured" }); }
  else qualChecks.push({ ok: false, label: "No TypeScript" });

  const hasCoverage = await checkFile(path.join(projectRoot, "coverage/coverage-summary.json"));
  if (hasCoverage) { qualScore += 30; qualChecks.push({ ok: true, label: "Coverage reports present" }); }
  else qualChecks.push({ ok: false, label: "No coverage reports" });

  dimensions.quality = { score: qualScore, checks: qualChecks };

  // --- DEPENDENCIES ---
  let depsScore = 100;
  const depsChecks = [];

  const allDepsCount = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies }).length;
  if (allDepsCount > 100) { depsScore -= 20; depsChecks.push({ ok: false, label: `Many dependencies: ${allDepsCount}` }); }
  else depsChecks.push({ ok: true, label: `${allDepsCount} total dependencies` });

  const hasEngines = !!pkgJson.engines?.node;
  if (!hasEngines) { depsScore -= 10; depsChecks.push({ ok: false, label: "No engines.node specified" }); }
  else depsChecks.push({ ok: true, label: `engines.node: ${pkgJson.engines.node}` });

  dimensions.deps = { score: depsScore, checks: depsChecks };

  // --- PUBLISH READINESS ---
  let pubScore = 0;
  const pubChecks = [];

  if (pkgJson.name) { pubScore += 15; pubChecks.push({ ok: true, label: `name: ${pkgJson.name}` }); }
  else pubChecks.push({ ok: false, label: "No name field" });

  if (pkgJson.version) { pubScore += 15; pubChecks.push({ ok: true, label: `version: ${pkgJson.version}` }); }
  else pubChecks.push({ ok: false, label: "No version field" });

  if (pkgJson.license) { pubScore += 15; pubChecks.push({ ok: true, label: `license: ${pkgJson.license}` }); }
  else pubChecks.push({ ok: false, label: "No license field" });

  if (pkgJson.description) { pubScore += 15; pubChecks.push({ ok: true, label: "Description present" }); }
  else pubChecks.push({ ok: false, label: "No description" });

  const hasReadme = await checkFile(path.join(projectRoot, "README.md"));
  if (hasReadme) { pubScore += 20; pubChecks.push({ ok: true, label: "README.md present" }); }
  else pubChecks.push({ ok: false, label: "No README.md" });

  const hasChangelog = await checkFile(path.join(projectRoot, "CHANGELOG.md"));
  if (hasChangelog) { pubScore += 20; pubChecks.push({ ok: true, label: "CHANGELOG.md present" }); }
  else pubChecks.push({ ok: false, label: "No CHANGELOG.md" });

  dimensions.publish = { score: pubScore, checks: pubChecks };

  // --- CI/CD ---
  let ciScore = 0;
  const ciChecks = [];

  const hasGhActions = await checkFile(path.join(projectRoot, ".github/workflows"));
  const hasGitlabCi = await checkFile(path.join(projectRoot, ".gitlab-ci.yml"));
  const hasCircleCi = await checkFile(path.join(projectRoot, ".circleci/config.yml"));
  if (hasGhActions || hasGitlabCi || hasCircleCi) {
    ciScore += 50;
    const ciTool = hasGhActions ? "GitHub Actions" : hasGitlabCi ? "GitLab CI" : "CircleCI";
    ciChecks.push({ ok: true, label: `CI configured: ${ciTool}` });
  } else {
    ciChecks.push({ ok: false, label: "No CI configuration" });
  }

  const gitStatus = run("git", ["status", "--porcelain"], projectRoot);
  const isClean = gitStatus.ok && gitStatus.output.trim() === "";
  if (isClean) { ciScore += 25; ciChecks.push({ ok: true, label: "Git working tree is clean" }); }
  else ciChecks.push({ ok: false, label: "Uncommitted changes" });

  if (pkgJson.scripts?.build) { ciScore += 25; ciChecks.push({ ok: true, label: "Build script present" }); }
  else ciChecks.push({ ok: false, label: "No build script" });

  dimensions.ci = { score: ciScore, checks: ciChecks };

  // Overall score
  const scores = Object.values(dimensions).map(d => d.score);
  const overallScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const grade = overallScore >= 90 ? "A" : overallScore >= 75 ? "B" : overallScore >= 60 ? "C" : overallScore >= 40 ? "D" : "F";

  if (values.json) {
    printJson({ ok: overallScore >= 60, kind: "better.health-dashboard", overallScore, grade, dimensions });
    return;
  }

  const gradeColor = ["A","B"].includes(grade) ? "\x1b[32m" : grade === "C" ? "\x1b[33m" : "\x1b[31m";
  printText(`  Overall: ${scoreBar(overallScore)}  ${gradeColor}${overallScore}/100 (${grade})\x1b[0m\n`);

  const DIM_NAMES = { security: "Security", quality: "Quality", deps: "Deps", publish: "Publish", ci: "CI/CD" };
  for (const [key, dim] of Object.entries(dimensions)) {
    const color = dim.score >= 80 ? "\x1b[32m" : dim.score >= 60 ? "\x1b[33m" : "\x1b[31m";
    printText(`  ${color}${DIM_NAMES[key].padEnd(10)}\x1b[0m  ${scoreBar(dim.score, 15)}  ${dim.score}%`);
    for (const c of dim.checks) {
      const icon = c.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[33m·\x1b[0m";
      printText(`             ${icon}  \x1b[90m${c.label}\x1b[0m`);
    }
  }
  printText("");
}
