import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectNodeModulesSnapshot, countInstalledPackages } from "../src/lib/nodeModules.js";
import { scanTree } from "../src/lib/fsScan.js";

test("combined fallback retains distinct identities and fresh per-phase sizes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "better-observe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nm = path.join(root, "node_modules");
  for (const [relative, name, version] of [
    ["a", "a", "1"], ["@s/b", "@s/b", "1"],
    ["a/node_modules/a", "a", "1"], ["a/node_modules/b", "b", "2"]
  ]) {
    const dir = path.join(nm, relative);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  }
  await fs.mkdir(path.join(nm, "bad"));
  await fs.writeFile(path.join(nm, "bad/package.json"), "{broken");
  await fs.symlink(path.join(nm, "a"), path.join(nm, "alias"));
  await fs.symlink(nm, path.join(nm, "a/node_modules/loop"));
  const options = { coreMode: "off", duFallback: "off" };
  const before = await collectNodeModulesSnapshot(root, options);
  const size = await scanTree(nm);
  assert.equal(before.packageCount, 3);
  assert.equal(await countInstalledPackages(nm), 3);
  assert.equal(before.logicalBytes, size.logicalBytes);
  assert.equal(before.physicalBytes, size.physicalBytes);
  assert.equal(before.fileCount, size.fileCount);
  await fs.writeFile(path.join(nm, "a/extra"), Buffer.alloc(1024));
  const after = await collectNodeModulesSnapshot(root, options);
  assert.equal(after.logicalBytes - before.logicalBytes, 1024);
  assert.equal(after.fileCount - before.fileCount, 1);
});

test("missing tree reports an empty complete observation", async () => {
  const snapshot = await collectNodeModulesSnapshot(`/private/tmp/better-missing-${process.pid}-${Date.now()}`);
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.packageCount, 0);
  assert.equal(snapshot.logicalBytes, 0);
});
