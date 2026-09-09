import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/better.js", import.meta.url));

for (const command of ["warm", "materialize", "verify"]) {
  test(`native cache ${command} rejects incomplete installed-tree snapshots`, async () => {
    const dir = await makeTempDir("better-global-cache-unsupported-");
    try {
      await writeJson(path.join(dir, "package.json"), { name: "fixture", version: "1.0.0" });
      await writeJson(path.join(dir, "package-lock.json"), { lockfileVersion: 3, packages: {} });
      await fs.mkdir(path.join(dir, "node_modules"));
      const sentinel = path.join(dir, "node_modules", "preserve.txt");
      await fs.writeFile(sentinel, "existing tree");
      await assert.rejects(exec(process.execPath, [cli, "cache", command, "--engine", "better",
        "--project-root", dir, "--cache-root", path.join(dir, "cache"), "--json"], { cwd: dir }), error => {
        const result = JSON.parse(error.stdout);
        assert.equal(result.ok, false);
        assert.equal(result.reason, "native_tree_snapshot_unsupported");
        return true;
      });
      assert.equal(await fs.readFile(sentinel, "utf8"), "existing tree");
    } finally {
      await rmrf(dir);
    }
  });
}
