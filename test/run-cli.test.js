import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir, rmrf, writeJson, writeFile } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test("run uses cwd package.json as project root when present", async () => {
  const root = await makeTempDir("better-run-root-");
  try {
    await writeJson(path.join(root, "package.json"), {
      name: "repo-root",
      version: "1.0.0",
      scripts: { dev: "node ./root-dev.js" }
    });
    await writeJson(path.join(root, "package-lock.json"), {
      name: "repo-root",
      lockfileVersion: 3,
      packages: { "": { name: "repo-root", version: "1.0.0" } }
    });
    await writeFile(path.join(root, "root-dev.js"), "require('node:fs').writeFileSync('root-hit.txt', 'root');\n");

    const child = path.join(root, "apps", "landing");
    await writeJson(path.join(child, "package.json"), {
      name: "landing",
      version: "1.0.0",
      scripts: { dev: "node ./child-dev.js" }
    });
    await writeFile(path.join(child, "child-dev.js"), "require('node:fs').writeFileSync('child-hit.txt', 'child');\n");

    const { stdout } = await execFileAsync(process.execPath, [betterBin, "run", "dev", "--json"], {
      cwd: child,
      env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
    });
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.kind, "better.run.report");
    assert.equal(report.run.script, "dev");
    const childReal = await fs.realpath(child);
    assert.equal(path.resolve(report.projectRoot), path.resolve(childReal));
    assert.equal(report.projectRootResolution.reason, "found:cwd-package.json");
    assert.equal(await fileExists(path.join(child, "child-hit.txt")), true);
    assert.equal(await fileExists(path.join(root, "root-hit.txt")), false);
  } finally {
    await rmrf(root);
  }
});

test("lint alias forwards script args", async () => {
  const dir = await makeTempDir("better-run-alias-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "run-alias-test",
      version: "1.0.0",
      scripts: { lint: "node ./lint.js" }
    });
    await writeFile(
      path.join(dir, "lint.js"),
      "require('node:fs').writeFileSync('lint-args.json', JSON.stringify(process.argv.slice(2)));\n"
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [betterBin, "lint", "--json", "--", "--alpha", "--beta=1"],
      {
        cwd: dir,
        env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
      }
    );
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.run.script, "lint");

    const lintArgs = JSON.parse(await fs.readFile(path.join(dir, "lint-args.json"), "utf8"));
    assert.deepEqual(lintArgs, ["--alpha", "--beta=1"]);
  } finally {
    await rmrf(dir);
  }
});

test("run --json returns structured error when script is missing", async () => {
  const dir = await makeTempDir("better-run-missing-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "run-missing-test",
      version: "1.0.0",
      scripts: { test: "node -e \"console.log('ok')\"" }
    });

    await assert.rejects(
      execFileAsync(process.execPath, [betterBin, "run", "lint", "--json"], {
        cwd: dir,
        env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
      }),
      (err) => {
        const parsed = JSON.parse(err.stdout);
        assert.equal(parsed.ok, false);
        assert.equal(parsed.kind, "better.run.report");
        assert.equal(parsed.reason, "script_missing");
        assert.equal(parsed.run.script, "lint");
        return true;
      }
    );
  } finally {
    await rmrf(dir);
  }
});
