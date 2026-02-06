import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeFile, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);

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
  await writeJson(path.join(pkgDir, "package.json"), { name: pkgName, version: "1.0.0", main: "index.js", bin: { [pkgName]: "bin.js" } });
  await writeFile(path.join(pkgDir, "index.js"), "module.exports = 42;\n");
  await writeFile(path.join(pkgDir, "bin.js"), "#!/usr/bin/env node\nconsole.log('ok');\n");

  const tarRoot = path.join(dir, "tarroot");
  const packageDir = path.join(tarRoot, "package");
  await fs.mkdir(packageDir, { recursive: true });
  // Copy files under package/
  await fs.copyFile(path.join(pkgDir, "package.json"), path.join(packageDir, "package.json"));
  await fs.copyFile(path.join(pkgDir, "index.js"), path.join(packageDir, "index.js"));
  await fs.copyFile(path.join(pkgDir, "bin.js"), path.join(packageDir, "bin.js"));

  const tgz = path.join(dir, `${pkgName}-1.0.0.tgz`);
  await execFileAsync("tar", ["-czf", tgz, "-C", tarRoot, "package"]);

  const data = await fs.readFile(tgz);
  const digest = crypto.createHash("sha512").update(data).digest("base64");
  const integrity = `sha512-${digest}`;
  return { tgz, integrity };
}

function pickOtherOs(current) {
  const all = ["darwin", "linux", "win32", "freebsd", "openbsd", "sunos", "android", "aix"];
  return all.find((value) => value !== current) ?? "linux";
}

test("better engine (npm lockfile replay): installs from local file: tarball", { skip: !(await hasTar()) }, async () => {
  const dir = await makeTempDir("better-engine-");
  try {
    const pkgName = "foo";
    const { tgz, integrity } = await packFixture(dir, pkgName);

    await writeJson(path.join(dir, "package.json"), { name: "proj", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "proj",
      lockfileVersion: 2,
      packages: {
        "": { name: "proj", version: "1.0.0" },
        "node_modules/foo": {
          version: "1.0.0",
          resolved: `file:${path.basename(tgz)}`,
          integrity
        }
      }
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [
      betterBin,
      "install",
      "--engine",
      "better",
      "--experimental",
      "--scripts",
      "off",
      "--verify",
      "integrity-required",
      "--link-strategy",
      "copy",
      "--json"
    ], { cwd: dir, timeout: 120_000 });

    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.engine, "better");
    assert.ok(report.betterEngine);
    assert.equal(report.betterEngine.lockfile.type, "npm");

    const value = await execFileAsync(process.execPath, ["-e", "console.log(require('foo'))"], { cwd: dir, timeout: 20_000 });
    assert.ok(value.stdout.trim() === "42");

    const binPath = process.platform === "win32"
      ? path.join(dir, "node_modules", ".bin", "foo.cmd")
      : path.join(dir, "node_modules", ".bin", "foo");
    const binExists = await fs.stat(binPath).then(() => true).catch(() => false);
    assert.equal(binExists, true);
  } finally {
    await rmrf(dir);
  }
});

test("better engine (npm lockfile replay): supports workspace link:true entries (root node_modules only)", async () => {
  const dir = await makeTempDir("better-engine-ws-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "root",
      version: "1.0.0",
      workspaces: ["packages/*"]
    });

    const wsDir = path.join(dir, "packages", "foo");
    await fs.mkdir(wsDir, { recursive: true });
    await writeJson(path.join(wsDir, "package.json"), {
      name: "foo",
      version: "1.0.0",
      main: "index.js",
      bin: { foo: "bin.js" }
    });
    await writeFile(path.join(wsDir, "index.js"), "module.exports = 7;\n");
    await writeFile(path.join(wsDir, "bin.js"), "#!/usr/bin/env node\nconsole.log('foo');\n");

    await writeJson(path.join(dir, "package-lock.json"), {
      name: "root",
      lockfileVersion: 3,
      packages: {
        "": { name: "root", version: "1.0.0" },
        "packages/foo": { name: "foo", version: "1.0.0" },
        "node_modules/foo": {
          name: "foo",
          link: true,
          resolved: "packages/foo"
        }
      }
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [
      betterBin,
      "install",
      "--engine",
      "better",
      "--experimental",
      "--scripts",
      "off",
      "--verify",
      "integrity-required",
      "--link-strategy",
      "copy",
      "--json"
    ], { cwd: dir, timeout: 120_000 });

    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.engine, "better");
    assert.ok(report.betterEngine);

    const value = await execFileAsync(process.execPath, ["-e", "console.log(require('foo'))"], { cwd: dir, timeout: 20_000 });
    assert.equal(value.stdout.trim(), "7");

    const binPath = process.platform === "win32"
      ? path.join(dir, "node_modules", ".bin", "foo.cmd")
      : path.join(dir, "node_modules", ".bin", "foo");
    const binExists = await fs.stat(binPath).then(() => true).catch(() => false);
    assert.equal(binExists, true);
  } finally {
    await rmrf(dir);
  }
});

test("better engine (npm lockfile replay): skips optional packages incompatible with current platform", { skip: !(await hasTar()) }, async () => {
  const dir = await makeTempDir("better-engine-platform-");
  try {
    const targetPkg = "opt-target";
    const foreignPkg = "opt-foreign";
    const { tgz: targetTgz, integrity: targetIntegrity } = await packFixture(dir, targetPkg);
    const { tgz: foreignTgz, integrity: foreignIntegrity } = await packFixture(dir, foreignPkg);
    const otherOs = pickOtherOs(process.platform);

    await writeJson(path.join(dir, "package.json"), { name: "proj", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "proj",
      lockfileVersion: 3,
      packages: {
        "": { name: "proj", version: "1.0.0" },
        [`node_modules/${targetPkg}`]: {
          name: targetPkg,
          version: "1.0.0",
          resolved: `file:${path.basename(targetTgz)}`,
          integrity: targetIntegrity,
          optional: true,
          os: [process.platform],
          cpu: [process.arch]
        },
        [`node_modules/${foreignPkg}`]: {
          name: foreignPkg,
          version: "1.0.0",
          resolved: `file:${path.basename(foreignTgz)}`,
          integrity: foreignIntegrity,
          optional: true,
          os: [otherOs]
        }
      }
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [
      betterBin,
      "install",
      "--engine",
      "better",
      "--experimental",
      "--scripts",
      "off",
      "--verify",
      "integrity-required",
      "--link-strategy",
      "copy",
      "--json"
    ], { cwd: dir, timeout: 120_000 });

    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.engine, "better");
    assert.ok(report.betterEngine);
    assert.equal(report.betterEngine.skipped.platform, 1);

    const targetExists = await fs
      .stat(path.join(dir, "node_modules", targetPkg, "package.json"))
      .then(() => true)
      .catch(() => false);
    const foreignExists = await fs
      .stat(path.join(dir, "node_modules", foreignPkg, "package.json"))
      .then(() => true)
      .catch(() => false);
    assert.equal(targetExists, true);
    assert.equal(foreignExists, false);
  } finally {
    await rmrf(dir);
  }
});
