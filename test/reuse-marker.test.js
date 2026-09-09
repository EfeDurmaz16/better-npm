import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";
import { writeReuseMarker, evaluateReuseMarker } from "../src/lib/reuseMarker.js";

const expected = { key: "key", lockHash: "lock", fingerprint: { engine: "better" } };
const marker = { engine: "better", globalKey: expected.key, lockHash: expected.lockHash, runtimeFingerprint: expected.fingerprint };

test("reuse inventory validates scoped strict store identities without reading package sources", async () => {
  const dir = await makeTempDir("better-inventory-");
  try {
    const actual = path.join(dir, "node_modules/.better/@scope/pkg@1.0.0/node_modules/@scope/pkg");
    await fs.mkdir(path.join(actual, "docs"), { recursive: true });
    await writeJson(path.join(actual, "package.json"), { name: "@scope/pkg", version: "1.0.0" });
    await fs.writeFile(path.join(actual, "docs/package.json"), "invalid source example");
    await fs.mkdir(path.join(dir, "node_modules/@scope"), { recursive: true });
    const link = path.join(dir, "node_modules/@scope/pkg");
    await fs.symlink(path.relative(path.dirname(link), actual), link, "dir");
    await writeReuseMarker(dir, marker);
    assert.equal((await evaluateReuseMarker(dir, expected)).hit, true);
    await writeJson(path.join(actual, "package.json"), { name: "@scope/pkg", version: "2.0.0" });
    assert.equal((await evaluateReuseMarker(dir, expected)).reason, "package_inventory_mismatch");
    await fs.rm(actual, { recursive: true, force: true });
    assert.equal((await evaluateReuseMarker(dir, expected)).hit, false);
  } finally {
    await rmrf(dir);
  }
});
