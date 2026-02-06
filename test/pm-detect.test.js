import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTempDir, rmrf, writeJson, writeFile } from "./helpers.js";
import { detectPackageManager } from "../src/pm/detect.js";

test("detects packageManager field", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "x", version: "1.0.0", packageManager: "pnpm@9.0.0" });
    const detected = await detectPackageManager(dir);
    assert.equal(detected.pm, "pnpm");
    assert.equal(detected.reason, "package.json#packageManager");
  } finally {
    await rmrf(dir);
  }
});

test("falls back to lockfile detection", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "x", version: "1.0.0" });
    await writeFile(path.join(dir, "yarn.lock"), "# yarn lock");
    const detected = await detectPackageManager(dir);
    assert.equal(detected.pm, "yarn");
  } finally {
    await rmrf(dir);
  }
});

