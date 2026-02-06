import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeFile, writeJson } from "./helpers.js";
import { extractTgz } from "../src/engine/better/tar.js";

const execFileAsync = promisify(execFile);

async function hasTar() {
  try {
    await execFileAsync("tar", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

test("extractTgz self-heals stale marker when package dir is missing", { skip: !(await hasTar()) }, async () => {
  const dir = await makeTempDir("better-tar-extract-");
  try {
    const tarRoot = path.join(dir, "tarroot");
    const packageDir = path.join(tarRoot, "package");
    await fs.mkdir(packageDir, { recursive: true });
    await writeJson(path.join(packageDir, "package.json"), { name: "fixture", version: "1.0.0", main: "index.js" });
    await writeFile(path.join(packageDir, "index.js"), "module.exports = 1;\n");

    const tgz = path.join(dir, "fixture-1.0.0.tgz");
    await execFileAsync("tar", ["-czf", tgz, "-C", tarRoot, "package"]);

    const unpackDir = path.join(dir, "unpacked");
    const first = await extractTgz(tgz, unpackDir);
    assert.equal(first.ok, true);
    assert.equal(first.reused, false);

    await fs.rm(path.join(unpackDir, "package"), { recursive: true, force: true });
    const second = await extractTgz(tgz, unpackDir);
    assert.equal(second.ok, true);
    assert.equal(second.reused, false);

    const third = await extractTgz(tgz, unpackDir);
    assert.equal(third.ok, true);
    assert.equal(third.reused, true);
  } finally {
    await rmrf(dir);
  }
});

test("extractTgz supports tarballs without package/ prefix", { skip: !(await hasTar()) }, async () => {
  const dir = await makeTempDir("better-tar-extract-flat-");
  try {
    const tarRoot = path.join(dir, "tarroot");
    const projectRoot = path.join(tarRoot, "fixture-1.0.0");
    await fs.mkdir(projectRoot, { recursive: true });
    await writeJson(path.join(projectRoot, "package.json"), { name: "fixture-flat", version: "1.0.0", main: "index.js" });
    await writeFile(path.join(projectRoot, "index.js"), "module.exports = 2;\n");

    const tgz = path.join(dir, "fixture-flat-1.0.0.tgz");
    await execFileAsync("tar", ["-czf", tgz, "-C", tarRoot, "fixture-1.0.0"]);

    const unpackDir = path.join(dir, "unpacked");
    const extracted = await extractTgz(tgz, unpackDir);
    assert.equal(extracted.ok, true);
    assert.equal(extracted.reused, false);
    assert.ok(typeof extracted.packageDir === "string");
    assert.ok(extracted.packageDir.endsWith(path.join("unpacked", "fixture-1.0.0")));
  } finally {
    await rmrf(dir);
  }
});
