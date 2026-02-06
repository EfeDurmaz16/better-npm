import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeFile, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

async function hasTar() {
  try {
    await execFileAsync("tar", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function packFixture(dir, pkgName) {
  const pkgDir = path.join(dir, "pkg");
  await fs.mkdir(pkgDir, { recursive: true });
  await writeJson(path.join(pkgDir, "package.json"), {
    name: pkgName,
    version: "1.0.0",
    main: "index.js"
  });
  await writeFile(path.join(pkgDir, "index.js"), "module.exports = 42;\n");

  const tarRoot = path.join(dir, "tarroot");
  const packageDir = path.join(tarRoot, "package");
  await fs.mkdir(packageDir, { recursive: true });
  await fs.copyFile(path.join(pkgDir, "package.json"), path.join(packageDir, "package.json"));
  await fs.copyFile(path.join(pkgDir, "index.js"), path.join(packageDir, "index.js"));

  const tgz = path.join(dir, `${pkgName}-1.0.0.tgz`);
  await execFileAsync("tar", ["-czf", tgz, "-C", tarRoot, "package"]);

  const data = await fs.readFile(tgz);
  const digest = crypto.createHash("sha512").update(data).digest("base64");
  const integrity = `sha512-${digest}`;
  return { tgz, integrity };
}

test("global cache: stores on first run and hits on second run (better engine)", { skip: !(await hasTar()) }, async () => {
  const dir = await makeTempDir("better-global-cache-");
  try {
    const { tgz, integrity } = await packFixture(dir, "foo");
    await writeJson(path.join(dir, "package.json"), { name: "proj", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "proj",
      lockfileVersion: 3,
      packages: {
        "": { name: "proj", version: "1.0.0" },
        "node_modules/foo": {
          version: "1.0.0",
          resolved: `file:${path.basename(tgz)}`,
          integrity
        }
      }
    });

    const first = await execFileAsync(
      process.execPath,
      [
        betterBin,
        "install",
        "--engine",
        "better",
        "--experimental",
        "--scripts",
        "off",
        "--cache-scripts",
        "off",
        "--global-cache",
        "--json"
      ],
      { cwd: dir, timeout: 120_000 }
    );
    const firstReport = JSON.parse(first.stdout);
    assert.equal(firstReport.ok, true);
    assert.equal(firstReport.cacheDecision.enabled, true);
    assert.equal(firstReport.cacheDecision.hit, false);
    assert.ok(firstReport.cacheDecision.key);

    await fs.rm(path.join(dir, "node_modules"), { recursive: true, force: true });

    const second = await execFileAsync(
      process.execPath,
      [
        betterBin,
        "install",
        "--engine",
        "better",
        "--experimental",
        "--scripts",
        "off",
        "--cache-scripts",
        "off",
        "--global-cache",
        "--cache-read-only",
        "--json"
      ],
      { cwd: dir, timeout: 120_000 }
    );
    const secondReport = JSON.parse(second.stdout);
    assert.equal(secondReport.ok, true);
    assert.equal(secondReport.cacheDecision.enabled, true);
    assert.equal(secondReport.cacheDecision.hit, true);
    assert.equal(secondReport.cacheDecision.reason, "global_cache_hit");

    const value = await execFileAsync(process.execPath, ["-e", "console.log(require('foo'))"], {
      cwd: dir,
      timeout: 20_000
    });
    assert.equal(value.stdout.trim(), "42");
  } finally {
    await rmrf(dir);
  }
});

test("cache warm/materialize/verify commands use global cache entry", { skip: !(await hasTar()) }, async () => {
  const dir = await makeTempDir("better-global-cache-cmds-");
  try {
    const { tgz, integrity } = await packFixture(dir, "bar");
    await writeJson(path.join(dir, "package.json"), { name: "proj", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "proj",
      lockfileVersion: 3,
      packages: {
        "": { name: "proj", version: "1.0.0" },
        "node_modules/bar": {
          version: "1.0.0",
          resolved: `file:${path.basename(tgz)}`,
          integrity
        }
      }
    });

    await execFileAsync(
      process.execPath,
      [
        betterBin,
        "install",
        "--engine",
        "better",
        "--experimental",
        "--scripts",
        "off",
        "--cache-scripts",
        "off",
        "--global-cache",
        "--json"
      ],
      { cwd: dir, timeout: 120_000 }
    );

    const verify = await execFileAsync(
      process.execPath,
      [
        betterBin,
        "cache",
        "verify",
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "better",
        "--cache-scripts",
        "off",
        "--json"
      ],
      { cwd: dir, timeout: 60_000 }
    );
    const verifyOut = JSON.parse(verify.stdout);
    assert.equal(verifyOut.ok, true);
    assert.equal(verifyOut.kind, "better.cache.verify");

    await fs.rm(path.join(dir, "node_modules"), { recursive: true, force: true });

    const materialize = await execFileAsync(
      process.execPath,
      [
        betterBin,
        "cache",
        "materialize",
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "better",
        "--cache-scripts",
        "off",
        "--json"
      ],
      { cwd: dir, timeout: 120_000 }
    );
    const matOut = JSON.parse(materialize.stdout);
    assert.equal(matOut.ok, true);
    assert.equal(matOut.kind, "better.cache.materialize");

    const barValue = await execFileAsync(process.execPath, ["-e", "console.log(require('bar'))"], {
      cwd: dir,
      timeout: 20_000
    });
    assert.equal(barValue.stdout.trim(), "42");

    const warm = await execFileAsync(
      process.execPath,
      [
        betterBin,
        "cache",
        "warm",
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "better",
        "--cache-scripts",
        "off",
        "--json"
      ],
      { cwd: dir, timeout: 120_000 }
    );
    const warmOut = JSON.parse(warm.stdout);
    assert.equal(warmOut.ok, true);
    assert.equal(warmOut.kind, "better.cache.warm");
  } finally {
    await rmrf(dir);
  }
});
