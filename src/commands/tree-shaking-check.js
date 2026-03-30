/**
 * better tree-shaking-check — check packages for tree-shaking compatibility
 *
 * Analyzes installed packages to determine if they support tree-shaking
 * (i.e., ship ESM modules with proper sideEffects field), helping
 * bundlers produce smaller builds.
 *
 * Usage:
 *   better tree-shaking-check
 *   better tree-shaking-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function assessTreeShaking(pkg) {
  const issues = [];
  let score = 0;

  // Check for ESM module field
  const hasModule = !!pkg.module;
  const hasExports = !!pkg.exports;
  const pkgType = pkg.type;

  if (hasModule) { score += 30; }
  if (hasExports) { score += 30; }
  if (pkgType === "module") { score += 20; }

  // Check sideEffects field
  if (pkg.sideEffects === false) {
    score += 20;
  } else if (Array.isArray(pkg.sideEffects)) {
    score += 10; // partial — listed files have side effects
  } else if (pkg.sideEffects === undefined) {
    issues.push("no sideEffects field (bundler assumes all files have side effects)");
  }

  if (!hasModule && !hasExports && pkgType !== "module") {
    issues.push("CJS only — no ESM entry point");
  }

  const rating = score >= 80 ? "excellent" : score >= 50 ? "good" : score >= 20 ? "partial" : "poor";
  return { score, rating, hasModule, hasExports, pkgType, sideEffects: pkg.sideEffects, issues };
}

export async function cmdTreeShakingCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:        { type: "boolean", default: runtime.json === true },
      help:        { type: "boolean", short: "h", default: false },
      "prod-only": { type: "boolean", default: false },
      top:         { type: "string", default: "20" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better tree-shaking-check [options]

Check packages for tree-shaking compatibility.

Options:
  --prod-only    Only check production dependencies
  --top <n>      Show top N packages by impact (default: 20)
  --json         Machine-readable output
  -h, --help     Show this help

Checks for:
  • ESM module field or exports map
  • sideEffects field (false = fully tree-shakeable)
  • package type field
`);
    return;
  }

  const topN = parseInt(values.top, 10) || 20;

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter tree-shaking-check\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const depsToCheck = values["prod-only"]
    ? Object.keys(pkgJson.dependencies || {})
    : Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });

  const results = [];
  const BATCH = 20;
  for (let i = 0; i < depsToCheck.length; i += BATCH) {
    const batch = depsToCheck.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dep) => {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(nmPath, dep, "package.json"), "utf8"));
        const assessment = assessTreeShaking(pkg);
        results.push({ name: dep, version: pkg.version, ...assessment });
      } catch {}
    }));
  }

  results.sort((a, b) => a.score - b.score); // Worst first

  const excellent = results.filter(r => r.rating === "excellent").length;
  const good = results.filter(r => r.rating === "good").length;
  const partial = results.filter(r => r.rating === "partial").length;
  const poor = results.filter(r => r.rating === "poor").length;

  if (values.json) {
    printJson({
      ok: poor === 0,
      kind: "better.tree-shaking-check",
      total: results.length,
      excellent, good, partial, poor,
      packages: results.slice(0, topN),
    });
    return;
  }

  printText(`  Checked: ${results.length}  |  Excellent: ${excellent}  |  Good: ${good}  |  Partial: ${partial}  |  Poor: ${poor}\n`);

  const RATING_COLOR = { excellent: "\x1b[32m", good: "\x1b[32m", partial: "\x1b[33m", poor: "\x1b[31m" };

  const toShow = results.slice(0, topN);
  for (const r of toShow) {
    const color = RATING_COLOR[r.rating] || "\x1b[90m";
    const features = [
      r.hasModule ? "module" : null,
      r.hasExports ? "exports" : null,
      r.pkgType === "module" ? "esm" : null,
      r.sideEffects === false ? "no-side-effects" : null,
    ].filter(Boolean);
    const featStr = features.length > 0 ? `  \x1b[90m[${features.join(", ")}]\x1b[0m` : "";
    printText(`  ${color}${r.rating.padEnd(10)}\x1b[0m  \x1b[1m${r.name}\x1b[0m@${r.version}${featStr}`);
  }

  if (results.length > topN) printText(`  \x1b[90m... and ${results.length - topN} more\x1b[0m`);
  printText("");
}
