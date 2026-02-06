import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir, rmrf, writeJson, writeFile } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

async function waitForServeJson(child, timeoutMs = 10_000) {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`serve command timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      try {
        const parsed = JSON.parse(stdout);
        clearTimeout(timer);
        resolve(parsed);
      } catch {
        // Continue until full JSON payload is available.
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `serve command exited before emitting JSON (code=${code}, signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test("analyze command emits rich JSON report", async () => {
  const dir = await makeTempDir("better-analyze-cli-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "analyze-cli-test",
      version: "1.0.0",
      dependencies: { dup: "^1.0.0", solo: "^1.0.0" }
    });
    await writeJson(path.join(dir, "node_modules", "dup", "package.json"), {
      name: "dup",
      version: "1.0.0",
      deprecated: "use another package"
    });
    await writeFile(path.join(dir, "node_modules", "dup", "index.js"), "module.exports = 1;\n");
    await writeJson(path.join(dir, "node_modules", "solo", "package.json"), {
      name: "solo",
      version: "1.2.3"
    });
    await writeFile(path.join(dir, "node_modules", "solo", "index.js"), "module.exports = 2;\n");
    await writeJson(path.join(dir, "node_modules", "app", "package.json"), { name: "app", version: "1.0.0" });
    await writeJson(path.join(dir, "node_modules", "app", "node_modules", "dup", "package.json"), {
      name: "dup",
      version: "2.0.0"
    });
    await writeFile(path.join(dir, "node_modules", "app", "node_modules", "dup", "index.js"), "module.exports = 3;\n");

    const { stdout } = await execFileAsync(
      process.execPath,
      [betterBin, "analyze", "--json", "--no-graph"],
      {
        cwd: dir,
        env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
      }
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "better.analyze.report");
    assert.equal(parsed.schemaVersion, 2);
    assert.ok(parsed.summary.totalPackages >= 4);
    assert.ok(parsed.summary.directDependencies >= 2);
    assert.ok(parsed.duplicatesDetailed.some((item) => item.name === "dup"));
    assert.equal(parsed.deprecated.totalDeprecated, 1);
    assert.ok(Array.isArray(parsed.largestPackages));
  } finally {
    await rmrf(dir);
  }
});

test("analyze command supports human output mode", async () => {
  const dir = await makeTempDir("better-analyze-human-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "analyze-human-test", version: "1.0.0" });
    await writeJson(path.join(dir, "node_modules", "left-pad", "package.json"), {
      name: "left-pad",
      version: "1.3.0"
    });
    await writeFile(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");

    const { stdout } = await execFileAsync(process.execPath, [betterBin, "analyze", "--no-graph"], {
      cwd: dir,
      env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
    });
    assert.match(stdout, /better analyze/);
    assert.match(stdout, /packages:/);
  } finally {
    await rmrf(dir);
  }
});

test("serve command returns JSON with actual bound port", async () => {
  const dir = await makeTempDir("better-serve-json-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "serve-json-test", version: "1.0.0" });
    await writeJson(path.join(dir, "node_modules", "x", "package.json"), { name: "x", version: "1.0.0" });
    await writeFile(path.join(dir, "node_modules", "x", "index.js"), "module.exports = 1;\n");

    const child = spawn(
      process.execPath,
      [betterBin, "serve", "--json", "--no-open", "--port", "0"],
      {
        cwd: dir,
        env: { ...process.env, BETTER_LOG_LEVEL: "silent" },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    const report = await waitForServeJson(child);
    assert.equal(report.kind, "better.serve");
    if (report.ok) {
      assert.ok(Number.isInteger(report.port));
      assert.ok(report.port > 0);
      assert.match(report.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    } else {
      assert.match(String(report.reason ?? ""), /(EPERM|operation not permitted|EACCES)/);
      await new Promise((resolve) => child.once("exit", resolve));
    }
  } finally {
    await rmrf(dir);
  }
});

test("install propagates package-manager exit code", async (t) => {
  if (process.platform === "win32") {
    t.skip("path-based fake npm executable test is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-install-exit-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "install-exit-test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "install-exit-test",
      lockfileVersion: 3,
      packages: { "": { name: "install-exit-test", version: "1.0.0" } }
    });

    const fakeBin = path.join(dir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });
    const fakeNpmPath = path.join(fakeBin, "npm");
    await writeFile(fakeNpmPath, "#!/bin/sh\nexit 42\n");
    await fs.chmod(fakeNpmPath, 0o755);

    await assert.rejects(
      execFileAsync(process.execPath, [betterBin, "install", "--pm", "npm", "--measure", "off"], {
        cwd: dir,
        env: {
          ...process.env,
          BETTER_LOG_LEVEL: "silent",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`
        }
      }),
      (err) => {
        assert.equal(err.code, 42);
        return true;
      }
    );
  } finally {
    await rmrf(dir);
  }
});
