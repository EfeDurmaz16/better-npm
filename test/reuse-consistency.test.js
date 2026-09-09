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
import { deriveGlobalCacheContext } from "../src/lib/globalCache.js";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/better.js", import.meta.url));

for (const cacheMode of ["strict", "relaxed"]) {
  test(`${cacheMode} cache keys preserve install selection and scripts`, async () => {
    const dir = await makeTempDir("better-reuse-key-");
    try {
      await writeJson(path.join(dir, "package-lock.json"), { lockfileVersion: 3, packages: {} });
      const options = { engine: "better", cacheMode };
      const key = async extra => (await deriveGlobalCacheContext(dir, { ...options, ...extra })).key;
      const normal = await key({});
      assert.equal(normal, await key({ nodeLayout: "hoist", production: false }));
      assert.notEqual(normal, await key({ nodeLayout: "strict" }));
      assert.notEqual(normal, await key({ production: true }));
      assert.notEqual(normal, await key({ scriptsMode: "off" }));
    } finally {
      await rmrf(dir);
    }
  });

  for (const nested of [false, true]) {
    test(`${cacheMode} native ${nested ? "nested hoist" : "strict layout"} output survives cache bypass`, async t => {
      const core = await findBetterCore();
      if (!core) { t.skip("Build better-core or set BETTER_CORE_PATH"); return; }
      const dir = await makeTempDir("better-reuse-layout-");
      const server = http.createServer();
      try {
        const tarballs = new Map();
        const entries = {};
        const fooSource = nested ? "module.exports = require('bar') === 2 ? 42 : 0;\n" : "module.exports = 42;\n";
        for (const [name, version, relPath, source] of [
          ["foo", "1.0.0", "node_modules/foo", fooSource],
          ["bar", "1.0.0", "node_modules/bar", "module.exports = 1;\n"],
          ...(nested ? [["bar", "2.0.0", "node_modules/foo/node_modules/bar", "module.exports = 2;\n"]] : [])
        ]) {
          const packageDir = path.join(dir, `${name}-${version}/package`);
          await fs.mkdir(packageDir, { recursive: true });
          await writeJson(path.join(packageDir, "package.json"), {
            name, version, main: "index.js", ...(nested && name === "foo" ? { dependencies: { bar: "2.0.0" } } : {})
          });
          await fs.writeFile(path.join(packageDir, "index.js"), source);
          const tgz = path.join(dir, `${name}-${version}.tgz`);
          await exec("tar", ["-czf", tgz, "-C", path.dirname(packageDir), "package"]);
          const tarball = await fs.readFile(tgz);
          tarballs.set(`/${name}-${version}.tgz`, tarball);
          entries[relPath] = { version, integrity: `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}` };
        }
        server.on("request", (req, res) => res.end(tarballs.get(req.url)));
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        for (const [relPath, entry] of Object.entries(entries)) {
          const name = relPath.split("/").at(-1);
          entry.resolved = `http://127.0.0.1:${server.address().port}/${name}-${entry.version}.tgz`;
        }
        const manifest = { name: "fixture", version: "1.0.0", dependencies: { foo: "1.0.0", bar: "1.0.0" } };
        await writeJson(path.join(dir, "package.json"), manifest);
        await writeJson(path.join(dir, "package-lock.json"), {
          lockfileVersion: 3,
          packages: { "": manifest, ...entries }
        });
        const args = [cli, "install", "--engine", "better", "--experimental", "--json",
          "--scripts", "off", "--cache-scripts", "off", "--measure", "off", "--frozen",
          "--global-cache", "--cache-mode", cacheMode, "--cache-root", path.join(dir, "cache")];
        const run = async flags => JSON.parse((await exec(process.execPath, [...args, ...flags], {
          cwd: dir, env: { ...process.env, BETTER_CORE_PATH: core }, timeout: 120_000
        })).stdout);
        const modulePath = path.join(dir, "node_modules/foo");
        const first = await run([]);
        assert.equal(first.cacheDecision.reason, "native_tree_snapshot_unsupported");
        assert.equal(first.betterEngine.ok, true);
        assert.equal((await fs.lstat(modulePath)).isSymbolicLink(), false);
        assert.equal((await exec(process.execPath, ["-e", "console.log(require('foo'), require('bar'))"], { cwd: dir })).stdout.trim(), "42 1");
        await fs.rm(path.join(dir, "node_modules"), { recursive: true, force: true });
        const hoistRestored = await run([]);
        assert.equal(hoistRestored.cacheDecision.hit, false);
        assert.equal(hoistRestored.betterEngine.ok, true);
        assert.equal((await exec(process.execPath, ["-e", "console.log(require('foo'), require('bar'))"], { cwd: dir })).stdout.trim(), "42 1");
        if (nested) return;
        const strict = await run(["--strict"]);
        assert.equal(strict.reuseDecision.hit, false);
        assert.equal(strict.cacheDecision.hit, false);
        assert.equal(strict.betterEngine.ok, true);
        assert.equal((await fs.lstat(modulePath)).isSymbolicLink(), true);
        assert.match(await fs.readlink(modulePath), /\.better/);
        assert.equal(await fs.readFile(path.join(modulePath, "index.js"), "utf8"), fooSource);
        assert.equal((await exec(process.execPath, ["-e", "console.log(require('foo'))"], { cwd: dir })).stdout.trim(), "42");
        const reused = await run(["--node-layout", "strict"]);
        assert.equal(reused.reuseDecision.hit, true);
        assert.equal((await fs.lstat(modulePath)).isSymbolicLink(), true);
        await fs.rm(path.join(dir, "node_modules"), { recursive: true, force: true });
        const restored = await run(["--strict"]);
        assert.equal(restored.cacheDecision.hit, false);
        assert.equal(restored.cacheDecision.reason, "native_tree_snapshot_unsupported");
        assert.equal(restored.betterEngine.ok, true);
        assert.equal((await fs.lstat(modulePath)).isSymbolicLink(), true);
        assert.equal(await fs.readFile(path.join(modulePath, "index.js"), "utf8"), fooSource);
        assert.equal((await exec(process.execPath, ["-e", "console.log(require('foo'))"], { cwd: dir })).stdout.trim(), "42");
        // A valid reuse marker must never bypass frozen package-manager preflight.
        await writeJson(path.join(dir, "package.json"), { ...manifest, dependencies: { ...manifest.dependencies, foo: "2.0.0" } });
        await assert.rejects(run(["--strict"]), error => {
          assert.match(error.stdout + error.stderr, /Frozen lockfile check failed/);
          return true;
        });
        assert.equal((await fs.lstat(modulePath)).isSymbolicLink(), true);
      } finally {
        await new Promise(resolve => server.close(resolve));
        await rmrf(dir);
      }
    });
  }
}
