import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installedInventory } from "../src/commands/benchmark.js";
import { makeTempDir, rmrf, writeJson, writeFile } from "./helpers.js";

const exec = promisify(execFile);
const bin = path.resolve("bin/better.js");
async function fixture(t, body) {
  const dir = await makeTempDir("benchmark-fairness-");
  t.after(() => rmrf(dir));
  await writeJson(path.join(dir, "package.json"), { name: "fixture", version: "1.0.0", dependencies: { fake: "1.0.0" } });
  await writeJson(path.join(dir, "package-lock.json"), { lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } });
  const fakeBin = path.join(dir, "bin");
  await fs.mkdir(fakeBin);
  await writeFile(path.join(fakeBin, "npm"), `#!${process.execPath}\n${body}\n`);
  await fs.chmod(path.join(fakeBin, "npm"), 0o755);
  return { dir, env: { ...process.env, BETTER_LOG_LEVEL: "silent", PATH: `${fakeBin}:${process.env.PATH ?? ""}` } };
}
const install = `
const fs = require('fs');
if (process.env.npm_config_ignore_scripts !== 'true') process.exit(8);
fs.appendFileSync('calls.jsonl', JSON.stringify({cache:process.env.npm_config_cache,args:process.argv.slice(2)})+'\\n');
fs.mkdirSync('node_modules/fake', {recursive:true});
fs.writeFileSync('node_modules/fake/package.json', JSON.stringify({name:'fake',version:'1.0.0'}));
`;
function run(dir, env, extra = []) {
  return exec(process.execPath, [bin, "benchmark", "--project-root", dir, "--pm", "npm", "--engine", "pm", "--cold-rounds", "1", "--warm-rounds", "0", "--json", ...extra], { cwd: dir, env });
}

test("benchmark isolates caches, disables scripts and restores lock inputs", { skip: process.platform === "win32" }, async t => {
  const { dir, env } = await fixture(t, install + `fs.writeFileSync('package-lock.json', '{"changed":true}');`);
  const original = await fs.readFile(path.join(dir, "package-lock.json"), "utf8");
  const cache = path.join(dir, "benchmark-cache");
  const first = JSON.parse((await run(dir, env, ["--cache-root", cache])).stdout);
  const second = JSON.parse((await run(dir, env, ["--cache-root", cache])).stdout);
  assert.notEqual(first.config.cacheRootBase, second.config.cacheRootBase);
  assert.equal(first.config.scripts, "off");
  assert.equal(first.variants.raw.cold[0].outputVerified, true);
  assert.equal(first.variants.betterMinimal.cold[0].outputVerified, true);
  assert.equal(await fs.readFile(path.join(dir, "package-lock.json"), "utf8"), original);
  const calls = (await fs.readFile(path.join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(calls.length >= 4);
  assert.ok(calls.every(call => call.cache.startsWith(cache + path.sep)));
  assert.ok(calls[0].args.includes("--ignore-scripts"));
});

test("zero-exit install without required output cannot become a speed sample", { skip: process.platform === "win32" }, async t => {
  const { dir, env } = await fixture(t, "process.exit(0);");
  await assert.rejects(run(dir, env), error => {
    assert.match(error.stderr, /raw cold round 1 failed/);
    assert.equal(JSON.parse(error.stdout).ok, false);
    assert.equal(JSON.parse(error.stdout).comparison, undefined);
    return true;
  });
});

test("nonzero install cannot become a speed sample", { skip: process.platform === "win32" }, async t => {
  const { dir, env } = await fixture(t, "process.exit(7);");
  await assert.rejects(run(dir, env), error => {
    assert.match(error.stderr, /exit=7/);
    assert.equal(JSON.parse(error.stdout).ok, false);
    assert.equal(JSON.parse(error.stdout).comparison, undefined);
    return true;
  });
});

test("installed inventory checks required transitive lock entries and versions", { skip: process.platform === "win32" }, async t => {
  const { dir } = await fixture(t, install);
  await writeJson(path.join(dir, "node_modules/fake/package.json"), { name: "fake", version: "1.0.0" });
  await writeJson(path.join(dir, "package-lock.json"), { packages: { "node_modules/transitive": { version: "2.0.0" } } });
  await assert.rejects(installedInventory(dir), /ENOENT/);
  await writeJson(path.join(dir, "node_modules/transitive/package.json"), { name: "transitive", version: "1.0.0" });
  await assert.rejects(installedInventory(dir), /version differs/);
  await writeJson(path.join(dir, "node_modules/transitive/package.json"), { name: "transitive", version: "2.0.0" });
  assert.deepEqual(await installedInventory(dir), ["fake@1.0.0", "transitive@2.0.0"]);
});

test("inventory mismatch prevents comparison even when both installs exit zero", { skip: process.platform === "win32" }, async t => {
  const { dir, env } = await fixture(t, install + `
if (process.env.npm_config_cache.includes('betterMinimal')) {
  fs.mkdirSync('node_modules/extra', {recursive:true});
  fs.writeFileSync('node_modules/extra/package.json', '{"name":"extra","version":"1.0.0"}');
}`);
  await assert.rejects(run(dir, env), error => {
    assert.match(error.stderr, /inventory differs/);
    assert.equal(JSON.parse(error.stdout).comparison, undefined);
    return true;
  });
});

test("standalone runner records invalid output as failure with null metrics", { skip: process.platform === "win32" }, async t => {
  const { dir, env } = await fixture(t, `
const fs = require('fs');
if (!process.argv.includes('--ignore-scripts')) process.exit(8);
if (process.argv.includes('--package-lock-only')) fs.writeFileSync('package-lock.json', '{"lockfileVersion":3,"packages":{}}');
`);
  const output = path.join(dir, "result.json");
  await assert.rejects(exec(process.execPath, [path.resolve("benchmarks/runner.mjs"), "--tools", "npm", "--rounds", "1", "--output", output], { cwd: dir, env }));
  const report = JSON.parse(await fs.readFile(output, "utf8"));
  const npm = report.scenarios[0].tools.npm;
  assert.equal(npm.success, false);
  assert.equal(npm.verifiedSamples, 0);
  assert.equal(npm.median_ms, null);
  assert.equal(npm.failures.length, 1);
});

test("frozen reuse_noop rejects before installing or changing inputs/cache", { skip: process.platform === "win32" }, async t => {
  const { dir, env } = await fixture(t, install);
  const lockPath = path.join(dir, "package-lock.json");
  const pkgPath = path.join(dir, "package.json");
  const originalLock = await fs.readFile(lockPath, "utf8");
  const originalPkg = await fs.readFile(pkgPath, "utf8");
  const marker = path.join(dir, "node_modules", "retained-marker");
  await writeFile(marker, "keep");
  const cacheRoot = path.join(dir, "untouched-cache");
  await assert.rejects(run(dir, env, ["--scenario", "reuse_noop", "--frozen", "--warm-rounds", "1", "--cache-root", cacheRoot]), error => {
    assert.match(error.stderr, /--frozen cannot be combined with --scenario reuse_noop/);
    assert.equal(JSON.parse(error.stdout).comparison, undefined);
    return true;
  });
  assert.equal(await fs.readFile(marker, "utf8"), "keep");
  assert.equal(await fs.readFile(lockPath, "utf8"), originalLock);
  assert.equal(await fs.readFile(pkgPath, "utf8"), originalPkg);
  await assert.rejects(fs.access(cacheRoot), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(dir, "calls.jsonl")), { code: "ENOENT" });
});
