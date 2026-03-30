/**
 * better install-time — benchmark npm install time
 *
 * Runs a fresh install benchmark to measure how long npm install
 * takes with and without cache. Reports timing and suggestions.
 *
 * Usage:
 *   better install-time
 *   better install-time --runs 3
 *   better install-time --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtMs(ms) {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function runInstall(projectRoot, fresh) {
  const nmPath = path.join(projectRoot, "node_modules");

  if (fresh) {
    // Remove node_modules
    await fs.rm(nmPath, { recursive: true, force: true });
  }

  const start = Date.now();
  const result = spawnSync("npm", ["install", "--prefer-offline"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
  const elapsed = Date.now() - start;

  return { elapsed, success: result.status === 0, stdout: result.stdout };
}

export async function cmdInstallTime(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      runs:     { type: "string", default: "1" },
      "no-fresh": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better install-time [options]

Benchmark npm install time for your project.

Options:
  --runs <n>      Number of cached runs to average (default: 1)
  --no-fresh      Skip the fresh install (node_modules deletion) benchmark
  --json          Machine-readable output
  -h, --help      Show this help

WARNING: --fresh mode will delete and reinstall node_modules.

Examples:
  better install-time
  better install-time --runs 3
  better install-time --no-fresh
`);
    return;
  }

  const numRuns = Math.max(1, Math.min(5, parseInt(values.runs) || 1));
  const doFresh = !values["no-fresh"];

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const pkgJsonPath = path.join(projectRoot, "package.json");
  if (!await fileExists(pkgJsonPath)) {
    const msg = "Cannot find package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
  const depCount = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies }).length;

  if (!values.json) {
    printText(`\n\x1b[1mbetter install-time\x1b[0m — ${depCount} declared dependencies\n`);
  }

  const results = { fresh: null, cached: [] };

  // Fresh install (delete node_modules)
  if (doFresh) {
    const hasNm = await fileExists(path.join(projectRoot, "node_modules"));
    if (!values.json) {
      process.stderr.write(`\x1b[90mRunning fresh install (this will delete node_modules)…\x1b[0m\n`);
    }
    const freshResult = await runInstall(projectRoot, true);
    results.fresh = freshResult.elapsed;

    if (!freshResult.success) {
      if (!values.json) printText(`\x1b[31m✖ npm install failed\x1b[0m`);
    }
  }

  // Cached installs
  for (let i = 0; i < numRuns; i++) {
    if (!values.json) {
      process.stderr.write(`\x1b[90mRunning cached install ${i + 1}/${numRuns}…\x1b[0m\n`);
    }
    const r = await runInstall(projectRoot, false);
    results.cached.push(r.elapsed);
  }

  const avgCached = results.cached.length
    ? Math.round(results.cached.reduce((a, b) => a + b, 0) / results.cached.length)
    : null;

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.install-time",
      freshInstallMs: results.fresh,
      cachedInstallMs: avgCached,
      cachedRuns: results.cached,
      depCount,
    });
    return;
  }

  if (results.fresh !== null) {
    printText(`  \x1b[1mFresh install:\x1b[0m ${fmtMs(results.fresh)}`);
  }

  if (avgCached !== null) {
    printText(`  \x1b[1mCached install (avg):\x1b[0m ${fmtMs(avgCached)}${numRuns > 1 ? ` (${numRuns} runs)` : ""}`);
  }

  if (results.fresh !== null && avgCached !== null) {
    const savings = results.fresh - avgCached;
    if (savings > 0) {
      printText(`  \x1b[90mCache saves: ${fmtMs(savings)} (${Math.round(savings / results.fresh * 100)}%)\x1b[0m`);
    }
  }

  printText("");

  // Suggestions
  const fresh = results.fresh;
  if (fresh) {
    if (fresh > 120000) {
      printText(`\x1b[33m⚠ Fresh install is very slow (>${fmtMs(fresh)}).\x1b[0m`);
      printText(`\x1b[90m  Consider: npm ci in CI, pnpm, or reducing dependency count\x1b[0m`);
    } else if (fresh > 60000) {
      printText(`\x1b[33m⚠ Fresh install is slow (${fmtMs(fresh)}). Consider caching in CI.\x1b[0m`);
    } else {
      printText(`\x1b[32m✔ Install time looks reasonable.\x1b[0m`);
    }
  }

  printText("");
}
