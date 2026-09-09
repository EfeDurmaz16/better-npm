// Synthetic helper benchmark, not an end-to-end install benchmark.
// Compare two checkouts with the same Node executable and fixture:
// node scripts/benchmark-preflight.mjs /absolute/path/to/checkout
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const sourceRoot = path.resolve(process.argv[2] ?? ".");
const { buildRuntimeFingerprint } = await import(pathToFileURL(path.join(sourceRoot, "src/lib/globalCache.js")));
const { verifyFrozenLockfile } = await import(pathToFileURL(path.join(sourceRoot, "src/lib/frozenLockfile.js")));
const repetitions = 31;
const packageCount = 2000;

async function measure(run) {
  await run();
  const samplesMs = [];
  for (let i = 0; i < repetitions; i++) {
    const start = performance.now();
    await run();
    samplesMs.push(performance.now() - start);
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], samplesMs };
}

const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "better-preflight-benchmark-"));
try {
  const dependencies = Object.fromEntries(Array.from({ length: packageCount }, (_, i) => [`pkg-${i}`, "1.0.0"]));
  const nested = Object.fromEntries(Object.keys(dependencies).map(name => [
    `node_modules/outer/node_modules/${name}`, { version: "1.0.0" }
  ]));
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ dependencies }));
  const lockPath = path.join(projectRoot, "package-lock.json");
  const runFrozen = async () => {
    const result = await verifyFrozenLockfile(projectRoot);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
  };
  const fingerprint = await measure(() => buildRuntimeFingerprint());
  await fs.writeFile(lockPath, JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies }, ...nested } }));
  const frozenNestedFallback = await measure(runFrozen);
  const direct = Object.fromEntries(Object.keys(dependencies).map(name => [
    `node_modules/${name}`, { version: "1.0.0" }
  ]));
  await fs.writeFile(lockPath, JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies }, ...direct } }));
  const frozenDirect = await measure(runFrozen);
  console.log(JSON.stringify({
    kind: "better.benchmark.preflight", sourceRoot, node: process.version,
    platform: process.platform, arch: process.arch, repetitions, packageCount,
    description: "Synthetic helper timings; warm filesystem cache; excludes process startup, download and installation.",
    fingerprint, frozenNestedFallback, frozenDirect
  }, null, 2));
} finally {
  await fs.rm(projectRoot, { recursive: true, force: true });
}
