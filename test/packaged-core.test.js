import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const executable = process.platform === "win32" ? "better-core.exe" : "better-core";

test("packed npm artifact discovers its bundled core and installs in a clean project", async (t) => {
  const core = process.env.BETTER_PACKAGING_CORE_PATH || path.join(root, "crates/target/debug", executable);
  try {
    await fs.access(core);
  } catch (error) {
    if (process.env.BETTER_PACKAGING_CORE_PATH) throw error;
    t.skip("Build better-core or set BETTER_PACKAGING_CORE_PATH to run the native packaging smoke test");
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "better-packaged-core-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const staging = path.join(tmp, "staging");
  const consumer = path.join(tmp, "consumer");
  const project = path.join(tmp, "project");
  await Promise.all([staging, consumer, project].map((dir) => fs.mkdir(dir)));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  for (const entry of ["package.json", ...manifest.files]) {
    await fs.cp(path.join(root, entry), path.join(staging, entry), { recursive: true });
  }
  // Reproduce the layout created by postinstall, using a local native artifact.
  await fs.copyFile(core, path.join(staging, "bin", executable));
  await fs.chmod(path.join(staging, "bin", executable), 0o755);
  const env = { ...process.env, npm_config_cache: path.join(tmp, "npm-cache") };
  delete env.BETTER_CORE_PATH;
  const options = { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };
  const packed = await exec("npm", ["pack", "--json", "--ignore-scripts", "--offline"], { ...options, cwd: staging });
  const [artifact] = JSON.parse(packed.stdout);
  assert.ok(artifact.files.some((file) => file.path === `bin/${executable}`));
  assert.ok(!artifact.files.some((file) => file.path.startsWith("crates/")));
  await fs.writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  await exec("npm", ["install", path.join(staging, artifact.filename), "--offline", "--no-audit", "--no-fund", "--ignore-scripts=false"], {
    ...options, cwd: consumer
  });
  const installed = path.join(consumer, "node_modules", "better");
  const moduleUrl = pathToFileURL(path.join(installed, "src/lib/core.js")).href;
  const probe = await exec(process.execPath, ["--input-type=module", "-e",
    `import { findBetterCore } from ${JSON.stringify(moduleUrl)}; console.log(await findBetterCore());`
  ], { ...options, cwd: project });
  assert.equal(probe.stdout.trim(), await fs.realpath(path.join(installed, "bin", executable)));
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ name: "empty-project", version: "1.0.0" }));
  await fs.writeFile(path.join(project, "package-lock.json"), JSON.stringify({
    name: "empty-project", version: "1.0.0", lockfileVersion: 3,
    packages: { "": { name: "empty-project", version: "1.0.0" } }
  }));
  const installedResult = await exec(process.execPath, [path.join(installed, "bin/better.js"),
    "install", "--engine", "better", "--experimental", "--offline", "--scripts", "off", "--json",
    "--cache-root", path.join(tmp, "better-cache"), "--project-root", project
  ], { ...options, cwd: project });
  const report = JSON.parse(installedResult.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.kind, "better.install.report");
  assert.equal(report.engine, "better");
  assert.ok((await fs.stat(path.join(project, "node_modules"))).isDirectory());
});
