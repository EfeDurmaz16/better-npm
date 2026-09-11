import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

for (const addon of [true, false]) {
  test(`postinstall stages ${addon ? "core and resident addon" : "legacy core-only release"}`, async t => {
    if (process.platform === "win32") return t.skip("current release installer targets Unix");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "better-release-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = path.join(root, "package with spaces");
    const scripts = path.join(project, "scripts");
    const payload = path.join(root, "payload");
    const tools = path.join(root, "tools");
    await Promise.all([scripts, payload, tools].map(dir => fs.mkdir(dir, { recursive: true })));
    await fs.writeFile(path.join(project, "package.json"), '{"type":"module"}');
    await fs.copyFile(new URL("../scripts/postinstall.js", import.meta.url), path.join(scripts, "postinstall.js"));
    await fs.writeFile(path.join(payload, "better-core"), "fixture binary");
    if (addon) await fs.writeFile(path.join(payload, "better-core.node"), "fixture addon");
    const archive = path.join(root, "release.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", payload, "better-core", ...(addon ? ["better-core.node"] : [])]);
    const curl = path.join(tools, "curl");
    await fs.writeFile(curl, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.copyFileSync(process.env.BETTER_TEST_ARCHIVE, args[args.indexOf('--output') + 1]);\n`, { mode: 0o755 });
    execFileSync(process.execPath, [path.join(scripts, "postinstall.js")], {
      env: { ...process.env, PATH: tools + path.delimiter + process.env.PATH, BETTER_TEST_ARCHIVE: archive },
      stdio: "pipe"
    });
    const bin = path.join(project, "bin");
    assert.equal(await fs.readFile(path.join(bin, "better-core"), "utf8"), "fixture binary");
    assert.equal((await fs.stat(path.join(bin, "better-core"))).mode & 0o777, 0o755);
    if (addon) assert.equal(await fs.readFile(path.join(bin, "better-core.node"), "utf8"), "fixture addon");
    assert.deepEqual((await fs.readdir(bin)).sort(), addon ? ["better-core", "better-core.node"] : ["better-core"]);
  });
}
