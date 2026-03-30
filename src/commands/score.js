/**
 * better score — overall project health score
 *
 * Computes a comprehensive health score (0-100) for the project
 * based on multiple dimensions: security, maintenance, performance,
 * code quality, and best practices.
 *
 * Usage:
 *   better score
 *   better score --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const CHECKS = [
  // Security (30 points)
  { id: "has-lockfile", category: "security", points: 8, label: "Lockfile present",
    check: async (root) => {
      try { await fs.access(path.join(root, "package-lock.json")); return true; } catch { return false; }
    }
  },
  { id: "env-gitignored", category: "security", points: 7, label: ".env in .gitignore",
    check: async (root) => {
      try {
        const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
        return gi.includes(".env");
      } catch { return false; }
    }
  },
  { id: "no-install-scripts", category: "security", points: 5, label: "No risky install scripts",
    check: async (root) => {
      const RISKY = new Set(["node-gyp-build", "prebuild-install", "node-pre-gyp"]);
      try {
        const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
        for (const [p, info] of Object.entries(lock.packages || {})) {
          if (!p) continue;
          const name = p.startsWith("node_modules/") ? p.slice(13) : p;
          if (RISKY.has(name) && info.scripts) return false;
        }
        return true;
      } catch { return true; }
    }
  },
  { id: "integrity-hashes", category: "security", points: 5, label: "All packages have integrity hashes",
    check: async (root) => {
      try {
        const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
        let missing = 0;
        for (const [p, info] of Object.entries(lock.packages || {})) {
          if (!p || p === "") continue;
          const name = p.startsWith("node_modules/") ? p.slice(13) : p;
          if (name && !info.integrity && info.resolved?.startsWith("https://")) missing++;
        }
        return missing === 0;
      } catch { return true; }
    }
  },
  { id: "no-deprecated", category: "security", points: 5, label: "No deprecated deps in lockfile",
    check: async (root) => {
      try {
        const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
        for (const info of Object.values(lock.packages || {})) {
          if (info.deprecated) return false;
        }
        return true;
      } catch { return true; }
    }
  },

  // Maintenance (25 points)
  { id: "has-description", category: "maintenance", points: 5, label: "Package has description",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      return Boolean(pkg.description);
    }
  },
  { id: "has-license", category: "maintenance", points: 5, label: "License declared",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      return Boolean(pkg.license);
    }
  },
  { id: "has-engines", category: "maintenance", points: 5, label: "engines.node declared",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      return Boolean(pkg.engines?.node);
    }
  },
  { id: "has-gitignore", category: "maintenance", points: 5, label: ".gitignore present",
    check: async (root) => {
      try { await fs.access(path.join(root, ".gitignore")); return true; } catch { return false; }
    }
  },
  { id: "has-tests", category: "maintenance", points: 5, label: "Test script configured",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      const test = pkg.scripts?.test;
      return Boolean(test && !test.startsWith("echo"));
    }
  },

  // Performance (20 points)
  { id: "no-moment", category: "performance", points: 5, label: "No moment.js (use date-fns)",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      return !pkg.dependencies?.moment && !pkg.devDependencies?.moment;
    }
  },
  { id: "no-multiple-http", category: "performance", points: 5, label: "Single HTTP client",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      const HTTP = ["axios", "node-fetch", "got", "superagent", "request"];
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return HTTP.filter(h => deps[h]).length <= 1;
    }
  },
  { id: "no-builtin-polyfills", category: "performance", points: 5, label: "No Node.js built-in polyfills",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      const BUILTINS = ["path", "fs", "util", "events", "stream", "assert", "os"];
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return BUILTINS.every(b => !deps[b]);
    }
  },
  { id: "no-legacy-test", category: "performance", points: 5, label: "Modern test framework",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      const LEGACY = ["jasmine", "mocha", "tape"];
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return LEGACY.every(t => !deps[t]);
    }
  },

  // Best Practices (25 points)
  { id: "has-ci", category: "best-practices", points: 8, label: "CI/CD configuration",
    check: async (root) => {
      const ciPaths = [
        ".github/workflows",
        ".circleci/config.yml",
        ".travis.yml",
        "Jenkinsfile",
        ".gitlab-ci.yml",
      ];
      for (const p of ciPaths) {
        try { await fs.access(path.join(root, p)); return true; } catch {}
      }
      return false;
    }
  },
  { id: "has-readme", category: "best-practices", points: 7, label: "README.md present",
    check: async (root) => {
      try { await fs.access(path.join(root, "README.md")); return true; } catch { return false; }
    }
  },
  { id: "formatted-pkgjson", category: "best-practices", points: 5, label: "package.json is sorted",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      const deps = Object.keys(pkg.dependencies || {});
      const sorted = [...deps].sort();
      return JSON.stringify(deps) === JSON.stringify(sorted);
    }
  },
  { id: "no-private-configs", category: "best-practices", points: 5, label: "No secrets in package.json",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      const pkgStr = JSON.stringify(pkg).toLowerCase();
      const SENSITIVE = ["password", "secret", "apikey", "api_key", "token", "private_key"];
      return !SENSITIVE.some(s => pkgStr.includes(s));
    }
  },
];

function getGrade(score) {
  if (score >= 90) return { grade: "A", color: "\x1b[32m" };
  if (score >= 75) return { grade: "B", color: "\x1b[32m" };
  if (score >= 60) return { grade: "C", color: "\x1b[33m" };
  if (score >= 40) return { grade: "D", color: "\x1b[33m" };
  return { grade: "F", color: "\x1b[31m" };
}

export async function cmdScore(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better score [options]

Compute an overall project health score (0-100).

Dimensions:
  Security (30 pts): lockfile, .env security, integrity hashes
  Maintenance (25 pts): description, license, engines, tests
  Performance (20 pts): no moment.js, single HTTP client
  Best Practices (25 pts): CI, README, sorted deps

Options:
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

  // Run all checks
  const results = [];
  let totalScore = 0;
  let maxScore = 0;

  for (const check of CHECKS) {
    maxScore += check.points;
    let passed = false;
    try {
      passed = await check.check(projectRoot);
    } catch {}
    if (passed) totalScore += check.points;
    results.push({ ...check, passed, check: undefined });
  }

  const percentage = Math.round((totalScore / maxScore) * 100);
  const { grade, color } = getGrade(percentage);

  // Group by category
  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { passed: 0, total: 0, max: 0, checks: [] };
    byCategory[r.category].total++;
    byCategory[r.category].max += r.points;
    if (r.passed) byCategory[r.category].passed++;
    byCategory[r.category].checks.push(r);
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.score",
      project: pkgJson.name || path.basename(projectRoot),
      score: totalScore,
      max_score: maxScore,
      percentage,
      grade,
      categories: Object.fromEntries(
        Object.entries(byCategory).map(([cat, data]) => [cat, {
          score: data.checks.filter(c => c.passed).reduce((s, c) => s + c.points, 0),
          max: data.max,
          checks: data.checks.map(c => ({ id: c.id, label: c.label, passed: c.passed, points: c.points })),
        }])
      ),
    });
    return;
  }

  const name = pkgJson.name || path.basename(projectRoot);
  printText(`\n\x1b[1mbetter score — ${name}\x1b[0m\n`);
  printText(`Overall: ${color}\x1b[1m${percentage}/100 (${grade})\x1b[0m\n`);

  const CAT_ORDER = ["security", "maintenance", "performance", "best-practices"];
  for (const cat of CAT_ORDER) {
    const data = byCategory[cat];
    if (!data) continue;
    const catScore = data.checks.filter(c => c.passed).reduce((s, c) => s + c.points, 0);
    const catMax = data.max;
    const catPct = Math.round((catScore / catMax) * 100);
    const catColor = catPct >= 75 ? "\x1b[32m" : catPct >= 50 ? "\x1b[33m" : "\x1b[31m";

    printText(`\x1b[1m${cat.charAt(0).toUpperCase() + cat.slice(1).replace("-", " ")}\x1b[0m  ${catColor}${catScore}/${catMax}\x1b[0m`);
    for (const c of data.checks) {
      const icon = c.passed ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
      printText(`  ${icon}  ${c.label.padEnd(40)} \x1b[90m+${c.points}\x1b[0m`);
    }
    printText("");
  }
}
