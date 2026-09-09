import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tryLoadNapiAddon } from "../src/lib/core.js";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const exec = promisify(execFile);
const addon = tryLoadNapiAddon();

test("NAPI fetch loads lockfile project registry config and withholds HTTP credentials", {
  skip: addon === null ? "Build better-napi to exercise registry configuration" : false
}, async () => {
  const dir = await makeTempDir("napi-registry-");
  const requests = [];
  let tarball;
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.end(tarball);
  });
  try {
    const project = path.join(dir, "project");
    const home = path.join(dir, "empty-home");
    const source = path.join(dir, "source");
    await Promise.all([project, home, path.join(source, "package")].map(p => fs.mkdir(p, { recursive: true })));
    await writeJson(path.join(source, "package/package.json"), { name: "@private/fixture", version: "1.0.0" });
    const archive = path.join(dir, "fixture.tgz");
    await exec("tar", ["-czf", archive, "-C", source, "package"]);
    tarball = await fs.readFile(archive);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await fs.writeFile(path.join(project, ".npmrc"),
      `@private:registry=http://127.0.0.1:${port}/private/\n//127.0.0.1:${port}/:_authToken=fake-test-token\n`);
    await writeJson(path.join(project, "package-lock.json"), {
      lockfileVersion: 3,
      packages: { "node_modules/@private/fixture": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/@private/fixture/-/fixture-1.0.0.tgz",
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`
      } }
    });
    // A separate process keeps synchronous NAPI fetch from blocking the local
    // server, and prevents user npmrc/environment settings affecting the fixture.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")));
    env.HOME = home;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `
      const { tryLoadNapiAddon } = await import(${JSON.stringify(new URL("../src/lib/core.js", import.meta.url).href)});
      const result = tryLoadNapiAddon().fetchAndExtract(process.argv[1], process.argv[2]);
      console.log(JSON.stringify(result));
    `, path.join(project, "package-lock.json"), path.join(dir, "cache")], {
      cwd: dir, env, timeout: 30_000
    });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.packagesFetched, 1);
    assert.deepEqual(requests, [{
      path: "/private/@private/fixture/-/fixture-1.0.0.tgz", authorization: undefined
    }]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rmrf(dir);
  }
});
