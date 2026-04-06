#!/usr/bin/env node
// scripts/benchmark-compare.mjs
// Compare two benchmark JSON results (base vs PR) and emit a markdown report.
// Exit 1 if a performance regression is detected.
//
// Usage:
//   node scripts/benchmark-compare.mjs <base.json> <pr.json>

import fs from "node:fs";

const REGRESSION_THRESHOLD = 1.10; // 10 % slower → regression
const IMPROVEMENT_THRESHOLD = 0.90; // 10 % faster → notable improvement

const [, , basePath, prPath] = process.argv;

if (!basePath || !prPath) {
  process.stderr.write("Usage: benchmark-compare.mjs <base.json> <pr.json>\n");
  process.exit(2);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    process.stderr.write(`Error reading ${filePath}: ${err.message}\n`);
    process.exit(2);
  }
}

const base = readJson(basePath);
const pr = readJson(prPath);

// Support both flat objects and the BenchmarkReport structure from better-core
function getMs(report, metric) {
  // Flat: { resolve: { median_ms, mean_ms }, ... }
  if (report[metric]?.median_ms != null) return Number(report[metric].median_ms);
  if (report[metric]?.mean_ms != null) return Number(report[metric].mean_ms);
  if (report[metric]?.median != null) return Number(report[metric].median);
  if (report[metric]?.mean != null) return Number(report[metric].mean);
  // BenchmarkReport wraps results per-pm: pick "better" first, then first entry
  if (Array.isArray(report.results)) {
    const entry =
      report.results.find((r) => r.pm === "better") ?? report.results[0];
    if (entry) return getMs(entry, metric);
  }
  return null;
}

const METRICS = ["resolve", "fetch", "materialize", "total"];

let hasRegression = false;
const rows = [];

for (const metric of METRICS) {
  const baseMs = getMs(base, metric);
  const prMs = getMs(pr, metric);

  if (baseMs == null || prMs == null || baseMs === 0) {
    rows.push(`| ${metric} | n/a | n/a | n/a | ⚪ |`);
    continue;
  }

  const ratio = prMs / baseMs;
  const deltaPct = ((ratio - 1) * 100).toFixed(1);
  const sign = ratio > 1 ? "+" : "";

  let icon;
  if (ratio > REGRESSION_THRESHOLD) {
    icon = "🔴";
    hasRegression = true;
  } else if (ratio < IMPROVEMENT_THRESHOLD) {
    icon = "🟢";
  } else {
    icon = "⚪";
  }

  rows.push(
    `| \`${metric}\` | ${baseMs.toFixed(0)} ms | ${prMs.toFixed(0)} ms | ${sign}${deltaPct}% | ${icon} |`
  );
}

const summary = hasRegression
  ? "**⚠️ Performance regression detected!** Please investigate before merging."
  : "✅ No performance regressions detected.";

const output = `## 📊 Benchmark Results

| Metric | Base | PR | Δ | Status |
|--------|------|----|---|--------|
${rows.join("\n")}

${summary}

> Regression threshold: +${((REGRESSION_THRESHOLD - 1) * 100).toFixed(0)}% slower than base.
`;

process.stdout.write(output);
process.exit(hasRegression ? 1 : 0);
