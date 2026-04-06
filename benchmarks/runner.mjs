#!/usr/bin/env node
// benchmarks/runner.mjs
// Run cross-tool benchmark scenarios and write results.json

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    "output": { type: "string", default: "benchmarks/results.json" },
    "rounds": { type: "string", default: "3" },
    "tools": { type: "string", default: "better,npm,pnpm" },
  },
  strict: false
});

const ROUNDS = parseInt(opts["rounds"]) || 3;
const TOOLS = opts["tools"].split(",");
const DRY_RUN = opts["dry-run"];

const FIXTURE_PKG = {
  name: "bench-test",
  version: "1.0.0",
  dependencies: {
    "lodash": "^4.17.21",
    "axios": "^1.6.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
  }
};

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function timeCmd(cmd, args, cwd) {
  const start = performance.now();
  const result = spawnSync(cmd, args, { cwd, stdio: "pipe", timeout: 120_000 });
  const elapsed = performance.now() - start;
  return { elapsed, success: result.status === 0, stderr: result.stderr?.toString() };
}

async function runScenario(name, toolFn) {
  if (DRY_RUN) {
    console.log(`  [dry-run] ${name}`);
    return { name, tools: {} };
  }

  const results = { name, tools: {} };
  for (const tool of TOOLS) {
    const times = [];
    let success = true;
    for (let r = 0; r < ROUNDS; r++) {
      const dir = mkdtempSync(join(tmpdir(), `bench-${tool}-${r}-`));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify(FIXTURE_PKG, null, 2));
        const { elapsed, success: ok } = toolFn(tool, dir);
        times.push(elapsed);
        if (!ok) success = false;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    results.tools[tool] = {
      median_ms: Math.round(median(times)),
      min_ms: Math.round(Math.min(...times)),
      max_ms: Math.round(Math.max(...times)),
      success
    };
    console.log(`    ${tool}: ${results.tools[tool].median_ms}ms`);
  }
  return results;
}

function installFn(tool, dir) {
  const cmds = {
    better: ["better", ["install", "--frozen"]],
    npm: ["npm", ["ci"]],
    pnpm: ["pnpm", ["install", "--frozen-lockfile"]],
    yarn: ["yarn", ["install", "--frozen-lockfile"]],
    bun: ["bun", ["install"]],
  };
  // Generate lockfile first
  if (tool === "npm") {
    spawnSync("npm", ["install", "--package-lock-only"], { cwd: dir, stdio: "pipe" });
  }
  const [cmd, args] = cmds[tool] || cmds.npm;
  return timeCmd(cmd, args, dir);
}

async function main() {
  console.log(`Running benchmarks: ${TOOLS.join(", ")} (${ROUNDS} rounds each)`);

  if (DRY_RUN) {
    console.log("Scenarios to run:");
    const scenarios = ["cold-install", "warm-install", "audit"];
    for (const s of scenarios) console.log(`  - ${s}`);
    return;
  }

  const allResults = [];

  console.log("\n[cold-install] Installing from scratch...");
  const coldInstall = await runScenario("cold-install", installFn);
  allResults.push(coldInstall);

  const report = {
    generated_at: new Date().toISOString(),
    rounds: ROUNDS,
    tools: TOOLS,
    scenarios: allResults,
  };

  writeFileSync(opts["output"], JSON.stringify(report, null, 2));
  console.log(`\nResults written to ${opts["output"]}`);

  // Summary
  const coldInstallResult = allResults[0];
  if (coldInstallResult) {
    const sorted = Object.entries(coldInstallResult.tools)
      .sort(([, a], [, b]) => a.median_ms - b.median_ms);
    console.log("\nCold install summary (fastest first):");
    for (const [tool, data] of sorted) {
      console.log(`  ${tool}: ${data.median_ms}ms`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
