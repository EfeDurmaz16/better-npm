#!/usr/bin/env node
// benchmarks/generate-charts.mjs
// Generate SVG bar charts from benchmark results.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    "input": { type: "string", default: "benchmarks/results.json" },
    "output-dir": { type: "string", default: "docs/site/public/benchmarks" },
  },
  strict: false
});

const COLORS = {
  better: "#3b82f6",
  npm: "#ef4444",
  pnpm: "#f97316",
  yarn: "#22c55e",
  bun: "#a855f7",
};

function svgBar(scenario, data) {
  const tools = Object.keys(data.tools);
  const values = tools.map(t => data.tools[t]?.median_ms || 0);
  const maxVal = Math.max(...values, 1);

  const width = 600;
  const height = 300;
  const barWidth = Math.floor((width - 100) / tools.length) - 10;
  const chartHeight = 200;
  const topPad = 40;
  const leftPad = 60;

  let bars = "";
  tools.forEach((tool, i) => {
    const val = values[i];
    const barH = Math.round((val / maxVal) * chartHeight);
    const x = leftPad + i * (barWidth + 10);
    const y = topPad + chartHeight - barH;
    const color = COLORS[tool] || "#6b7280";

    bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${color}" rx="3"/>`;
    bars += `<text x="${x + barWidth / 2}" y="${y - 5}" text-anchor="middle" font-size="12" fill="#374151">${val}ms</text>`;
    bars += `<text x="${x + barWidth / 2}" y="${topPad + chartHeight + 20}" text-anchor="middle" font-size="12" fill="#6b7280">${tool}</text>`;
  });

  // Y axis labels
  const yLabels = [0, 0.25, 0.5, 0.75, 1].map(f => ({
    val: Math.round(f * maxVal),
    y: topPad + chartHeight - Math.round(f * chartHeight)
  }));

  let yAxis = yLabels.map(({ val, y }) =>
    `<text x="${leftPad - 5}" y="${y + 4}" text-anchor="end" font-size="10" fill="#9ca3af">${val}</text>
     <line x1="${leftPad}" y1="${y}" x2="${width - 20}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`
  ).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="font-family:sans-serif">
  <text x="${width/2}" y="24" text-anchor="middle" font-size="16" font-weight="600" fill="#111827">${scenario} (ms, lower is better)</text>
  ${yAxis}
  ${bars}
</svg>`;
}

function main() {
  let results;
  try {
    results = JSON.parse(readFileSync(opts["input"], "utf8"));
  } catch {
    console.error(`Could not read ${opts["input"]}`);
    process.exit(1);
  }

  mkdirSync(opts["output-dir"], { recursive: true });

  for (const scenario of results.scenarios || []) {
    const svg = svgBar(scenario.name, scenario);
    const outPath = `${opts["output-dir"]}/${scenario.name}.svg`;
    writeFileSync(outPath, svg);
    console.log(`Generated ${outPath}`);
  }

  // Generate index MDX
  const scenarios = (results.scenarios || []).map(s => s.name);
  const mdx = `---
title: Benchmarks
description: Performance comparison — better vs npm vs pnpm vs yarn vs bun
---

# Benchmarks

Measured with ${results.rounds || 3} rounds, median time. Lower is better.
Generated: ${results.generated_at || new Date().toISOString()}

${scenarios.map(s => `## ${s}\n\n![${s} benchmark](/benchmarks/${s}.svg)`).join("\n\n")}
`;
  writeFileSync("docs/site/src/content/docs/benchmarks.mdx", mdx);
  console.log("Generated docs/site/src/content/docs/benchmarks.mdx");
}

main();
