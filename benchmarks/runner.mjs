#!/usr/bin/env node
// Same npm lockfile, scripts disabled, isolated cold caches, verified inventory.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { installedInventory } from "../src/commands/benchmark.js";

const { values: opts } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    output: { type: "string", default: "benchmarks/results.json" },
    rounds: { type: "string", default: "3" },
    tools: { type: "string", default: "npm,better" },
  },
  strict: true
});
const rounds = Number(opts.rounds);
const tools = opts.tools.split(",");
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a positive integer");
if (tools.some(tool => !["npm", "better"].includes(tool))) {
  throw new Error("Verified cross-tool runner supports npm,better (shared npm lockfile) only");
}
const pkg = {
  name: "bench-test", version: "1.0.0",
  dependencies: { lodash: "4.17.21", axios: "1.6.0", react: "18.2.0", "react-dom": "18.2.0" }
};
const betterBin = fileURLToPath(new URL("../bin/better.js", import.meta.url));
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
async function main() {
  if (opts["dry-run"]) {
    console.log(`cold-install: ${tools.join(", ")}; scripts off; shared lockfile; isolated caches; verified output`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "better-benchmark-"));
  const result = { name: "cold-install", tools: {} };
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    const setup = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: root, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, npm_config_cache: join(root, "setup-cache"), npm_config_ignore_scripts: "true" }
    });
    if (setup.status !== 0) throw new Error(`Lockfile setup failed: ${setup.stderr || setup.error}`);
    const lock = readFileSync(join(root, "package-lock.json"));
    let expected;
    for (const tool of tools) {
      const times = [];
      const failures = [];
      for (let round = 0; round < rounds; round++) {
        const dir = mkdtempSync(join(root, `${tool}-`));
        writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
        writeFileSync(join(dir, "package-lock.json"), lock);
        const cache = join(dir, "cache");
        const args = tool === "npm"
          ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]
          : [betterBin, "install", "--engine", "better", "--experimental", "--frozen", "--scripts", "off", "--cache-scripts", "off", "--cache-root", cache];
        const start = performance.now();
        const install = spawnSync(tool === "npm" ? "npm" : process.execPath, args, {
          cwd: dir, encoding: "utf8", timeout: 120_000,
          env: { ...process.env, npm_config_cache: join(cache, "npm"), npm_config_ignore_scripts: "true" }
        });
        const elapsed = performance.now() - start;
        try {
          if (install.status !== 0) throw new Error(install.stderr || String(install.error || `exit ${install.status}`));
          const inventory = JSON.stringify(await installedInventory(dir));
          if (expected !== undefined && expected !== inventory) throw new Error("Installed inventory differs across tools/rounds");
          expected = inventory;
          times.push(elapsed);
        } catch (error) { failures.push({ round: round + 1, error: error.message }); }
      }
      const success = failures.length === 0;
      result.tools[tool] = {
        success, verifiedSamples: times.length, failures,
        median_ms: success ? Math.round(median(times)) : null,
        min_ms: success ? Math.round(Math.min(...times)) : null,
        max_ms: success ? Math.round(Math.max(...times)) : null
      };
    }
    writeFileSync(resolve(opts.output), JSON.stringify({
      generated_at: new Date().toISOString(), rounds, tools,
      conditions: { scripts: "off", cache: "isolated-cold", lockfile: "shared-npm", verification: "installed-package-inventory" },
      scenarios: [result]
    }, null, 2));
    if (Object.values(result.tools).some(value => !value.success)) process.exitCode = 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
