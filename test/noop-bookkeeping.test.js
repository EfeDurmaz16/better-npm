import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findBetterCore } from "../src/lib/core.js";
import { reuseMarkerPath } from "../src/lib/reuseMarker.js";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/better.js", import.meta.url));

async function treeDigest(root) {
  const out = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(root, full)] = crypto.createHash("sha256").update(await fs.readFile(full)).digest("hex");
    }
  }
  await walk(root);
  return out;
}

test("reuse hit publishes nothing to the shared cache root", async t => {
  const core = await findBetterCore();
  if (!core) { t.skip("Build better-core or set BETTER_CORE_PATH"); return; }
  const dir = await makeTempDir("better-noop-bookkeeping-");
  const server = http.createServer();
  try {
    const packageDir = path.join(dir, "foo-1.0.0/package");
    await fs.mkdir(packageDir, { recursive: true });
    await writeJson(path.join(packageDir, "package.json"), { name: "foo", version: "1.0.0", main: "index.js" });
    await fs.writeFile(path.join(packageDir, "index.js"), "module.exports = 42;\n");
    const tgz = path.join(dir, "foo-1.0.0.tgz");
    await exec("tar", ["-czf", tgz, "-C", path.dirname(packageDir), "package"]);
    const tarball = await fs.readFile(tgz);
    server.on("request", (req, res) => res.end(req.url === "/foo-1.0.0.tgz" ? tarball : ""));
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const project = path.join(dir, "project");
    const manifest = { name: "fixture", version: "1.0.0", dependencies: { foo: "1.0.0" } };
    await writeJson(path.join(project, "package.json"), manifest);
    await writeJson(path.join(project, "package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "": manifest,
        "node_modules/foo": {
          version: "1.0.0",
          resolved: `http://127.0.0.1:${server.address().port}/foo-1.0.0.tgz`,
          integrity: `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`
        }
      }
    });
    const cacheRoot = path.join(dir, "cache");
    const install = async () => JSON.parse((await exec(process.execPath, [cli, "install", "--engine", "better",
      "--experimental", "--json", "--scripts", "off", "--cache-scripts", "off", "--cache-root", cacheRoot,
      "--project-root", project, "--hoist"], {
      cwd: project, env: { ...process.env, BETTER_CORE_PATH: core }, timeout: 120_000
    })).stdout);

    const first = await install();
    assert.notEqual(first.execution.mode, "noop_reuse");
    // Control: a real install does publish bookkeeping, so the digest below can see writes.
    assert.ok((await fs.readdir(path.join(cacheRoot, "runs"))).length > 0);
    await fs.access(path.join(cacheRoot, "state.json"));

    const cacheBefore = await treeDigest(cacheRoot);
    const markerBefore = await fs.readFile(reuseMarkerPath(project));
    const second = await install();
    assert.equal(second.execution.mode, "noop_reuse");
    assert.deepEqual(await treeDigest(cacheRoot), cacheBefore);
    assert.deepEqual(await fs.readFile(reuseMarkerPath(project)), markerBefore);
    assert.deepEqual(second.reuseMarker, { ok: true, path: reuseMarkerPath(project), reused: true });
    const receipt = JSON.parse(await fs.readFile(path.join(project, ".better-receipt.json"), "utf8"));
    assert.equal(receipt.reuseMarkerHit, true);
    assert.equal(receipt.runId, second.runId);
    assert.equal(await fs.readFile(path.join(project, "node_modules/foo/index.js"), "utf8"), "module.exports = 42;\n");
  } finally {
    server.close();
    await rmrf(dir);
  }
});
