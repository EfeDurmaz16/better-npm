import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { makeTempDir, rmrf, writeFile, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);

// Helper to extract JSON from output (may have npm/bun output before/after it)
function extractJson(stdout) {
  // Look for the JSON object that starts with "ok" field
  // This is the better report, not npm's output
  const lines = stdout.split('\n');
  let jsonStart = -1;
  let braceCount = 0;
  let inJson = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Start of JSON object
    if (line === '{' || line.startsWith('{')) {
      if (!inJson) {
        jsonStart = i;
        inJson = true;
      }
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;

      if (braceCount === 0 && inJson) {
        // Complete JSON object found
        const jsonStr = lines.slice(jsonStart, i + 1).join('\n');
        try {
          const parsed = JSON.parse(jsonStr);
          // Check if this is the better report
          if (parsed.kind === 'better.install.report') {
            return parsed;
          }
        } catch {
          // Not valid JSON, continue searching
        }
        inJson = false;
        jsonStart = -1;
      }
    } else if (inJson) {
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;

      if (braceCount === 0) {
        // Complete JSON object found
        const jsonStr = lines.slice(jsonStart, i + 1).join('\n');
        try {
          const parsed = JSON.parse(jsonStr);
          // Check if this is the better report
          if (parsed.kind === 'better.install.report') {
            return parsed;
          }
        } catch {
          // Not valid JSON, continue searching
        }
        inJson = false;
        jsonStart = -1;
      }
    }
  }

  throw new Error(`No valid better.install.report JSON found in output: ${stdout}`);
}

// Check if bun is available
async function bunAvailable() {
  try {
    await execFileAsync("bun", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const hasBun = await bunAvailable();

async function hasTar() {
  try {
    await execFileAsync("tar", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const hasSystemTar = await hasTar();

async function packFixture(dir, pkgName) {
  const pkgDir = path.join(dir, "pkg");
  await fs.mkdir(pkgDir, { recursive: true });
  await writeJson(path.join(pkgDir, "package.json"), { name: pkgName, version: "1.0.0", main: "index.js" });
  await writeFile(path.join(pkgDir, "index.js"), "module.exports = 1;\n");

  const tarRoot = path.join(dir, "tarroot");
  const packageDir = path.join(tarRoot, "package");
  await fs.mkdir(packageDir, { recursive: true });
  await fs.copyFile(path.join(pkgDir, "package.json"), path.join(packageDir, "package.json"));
  await fs.copyFile(path.join(pkgDir, "index.js"), path.join(packageDir, "index.js"));

  const tgz = path.join(dir, `${pkgName}-1.0.0.tgz`);
  await execFileAsync("tar", ["-czf", tgz, "-C", tarRoot, "package"]);

  const data = await fs.readFile(tgz);
  const digest = crypto.createHash("sha512").update(data).digest("base64");
  const integrity = `sha512-${digest}`;
  return { tgz, integrity };
}

async function writeLocalDepProject(dir, opts = {}) {
  const depName = opts.depName ?? "local-dep";
  const depsDir = path.join(dir, "deps");
  await fs.mkdir(depsDir, { recursive: true });
  const { tgz } = await packFixture(depsDir, depName);

  await writeJson(path.join(dir, "package.json"), {
    name: opts.projectName ?? "test-proj",
    version: "1.0.0",
    dependencies: {
      [depName]: `file:./deps/${path.basename(tgz)}`
    }
  });
}

test("bun engine: should run bun install when --engine bun", { skip: !hasBun || !hasSystemTar }, async () => {
  const dir = await makeTempDir("better-bun-test-");
  try {
    await writeLocalDepProject(dir, { projectName: "bun-test" });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--engine", "bun", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.engine, "bun");
    assert.equal(report.command.cmd, "bun");
  } finally {
    await rmrf(dir);
  }
});

test("bun engine: should default to pm engine", async () => {
  const dir = await makeTempDir("better-pm-test-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "pm-test",
      version: "1.0.0",
      dependencies: {}
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.engine, "pm");
  } finally {
    await rmrf(dir);
  }
});

test("bun engine: should enable parity check by default with bun engine", { skip: !hasBun || !hasSystemTar }, async () => {
  const dir = await makeTempDir("better-bun-parity-");
  try {
    await writeLocalDepProject(dir, { projectName: "bun-parity-test" });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--engine", "bun", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.ok(report.parity);
    assert.equal(report.parity.mode, "warn");
  } finally {
    await rmrf(dir);
  }
});

test("bun engine: should skip parity check when --parity-check off", { skip: !hasBun || !hasSystemTar }, async () => {
  const dir = await makeTempDir("better-bun-no-parity-");
  try {
    await writeLocalDepProject(dir, { projectName: "bun-no-parity-test" });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--engine", "bun", "--parity-check", "off", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.parity, undefined);
  } finally {
    await rmrf(dir);
  }
});

test("bun engine: should include lockfilePolicy in report", { skip: !hasBun || !hasSystemTar }, async () => {
  const dir = await makeTempDir("better-bun-lockfile-");
  try {
    await writeLocalDepProject(dir, { projectName: "bun-lockfile-test" });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--engine", "bun", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.lockfilePolicy, "keep");
  } finally {
    await rmrf(dir);
  }
});

test("bun engine: should allow bun.lockb with --lockfile-policy allow-engine", { skip: !hasBun || !hasSystemTar }, async () => {
  const dir = await makeTempDir("better-bun-allow-engine-");
  try {
    await writeLocalDepProject(dir, { projectName: "bun-allow-engine-test" });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--engine", "bun", "--lockfile-policy", "allow-engine", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.lockfilePolicy, "allow-engine");
  } finally {
    await rmrf(dir);
  }
});

test("bun engine: should have schemaVersion 2", { skip: !hasBun || !hasSystemTar }, async () => {
  const dir = await makeTempDir("better-bun-schema-");
  try {
    await writeLocalDepProject(dir, { projectName: "bun-schema-test" });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--engine", "bun", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.schemaVersion, 2);
  } finally {
    await rmrf(dir);
  }
});

test("bun engine: should include lockfileMigration info with allow-engine policy", { skip: !hasBun || !hasSystemTar }, async () => {
  const dir = await makeTempDir("better-bun-migration-");
  try {
    await writeLocalDepProject(dir, { projectName: "bun-migration-test" });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--engine", "bun", "--lockfile-policy", "allow-engine", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.ok(report.lockfileMigration);
    assert.equal(report.lockfileMigration.status, "migrating");
    assert.equal(report.lockfileMigration.engineLockfile, "bun.lockb");
  } finally {
    await rmrf(dir);
  }
});

test("bun engine: should set lockfileMigration to null with keep policy", { skip: !hasBun || !hasSystemTar }, async () => {
  const dir = await makeTempDir("better-bun-keep-");
  try {
    await writeLocalDepProject(dir, { projectName: "bun-keep-test" });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--engine", "bun", "--lockfile-policy", "keep", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.lockfileMigration, null);
  } finally {
    await rmrf(dir);
  }
});

test("bun engine: should include parity check results in report", { skip: !hasBun || !hasSystemTar }, async () => {
  const dir = await makeTempDir("better-bun-parity-check-");
  try {
    await writeLocalDepProject(dir, { projectName: "bun-parity-check-test" });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--engine", "bun", "--parity-check", "warn", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.ok(report.parity);
    assert.ok(typeof report.parity.ok === "boolean");
    assert.equal(report.parity.mode, "warn");
    assert.ok(report.parity.checks);
    assert.ok(report.parity.checks.lockfileDrift);
  } finally {
    await rmrf(dir);
  }
});

test("engine validation: should reject invalid engine", async () => {
  const dir = await makeTempDir("better-invalid-engine-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "invalid-engine-test",
      version: "1.0.0"
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    await assert.rejects(
      execFileAsync(process.execPath, [betterBin, "install", "--engine", "invalid"], {
        cwd: dir
      }),
      (err) => {
        assert.ok(err.stderr.includes("Unknown --engine"));
        return true;
      }
    );
  } finally {
    await rmrf(dir);
  }
});

test("engine validation: should reject invalid parity-check mode", async () => {
  const dir = await makeTempDir("better-invalid-parity-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "invalid-parity-test",
      version: "1.0.0"
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    await assert.rejects(
      execFileAsync(process.execPath, [betterBin, "install", "--parity-check", "invalid"], {
        cwd: dir
      }),
      (err) => {
        assert.ok(err.stderr.includes("Unknown --parity-check"));
        return true;
      }
    );
  } finally {
    await rmrf(dir);
  }
});

test("engine validation: should reject invalid measure-cache mode", async () => {
  const dir = await makeTempDir("better-invalid-measure-cache-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "invalid-measure-cache-test",
      version: "1.0.0"
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    await assert.rejects(
      execFileAsync(process.execPath, [betterBin, "install", "--measure-cache", "invalid"], {
        cwd: dir
      }),
      (err) => {
        assert.ok(err.stderr.includes("Unknown --measure-cache"));
        return true;
      }
    );
  } finally {
    await rmrf(dir);
  }
});

test("engine validation: should reject invalid lockfile-policy", async () => {
  const dir = await makeTempDir("better-invalid-lockfile-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "invalid-lockfile-test",
      version: "1.0.0"
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    await assert.rejects(
      execFileAsync(process.execPath, [betterBin, "install", "--lockfile-policy", "invalid"], {
        cwd: dir
      }),
      (err) => {
        assert.ok(err.stderr.includes("Unknown --lockfile-policy"));
        return true;
      }
    );
  } finally {
    await rmrf(dir);
  }
});

test("bun engine: fast mode should skip cache size scan by default", { skip: !hasBun || !hasSystemTar }, async () => {
  const dir = await makeTempDir("better-bun-fast-skip-cache-");
  try {
    await writeLocalDepProject(dir, { projectName: "bun-fast-skip-cache-test" });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--engine", "bun", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.cache?.before?.reason, "measure_cache_off");
    assert.equal(report.cache?.after?.reason, "measure_cache_off");
    assert.equal(report.nodeModules?.path?.includes("node_modules"), true);
  } finally {
    await rmrf(dir);
  }
});

test("pm engine: should not run parity check by default", async () => {
  const dir = await makeTempDir("better-pm-no-parity-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "pm-no-parity-test",
      version: "1.0.0",
      dependencies: {}
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.engine, "pm");
    assert.equal(report.parity, undefined);
  } finally {
    await rmrf(dir);
  }
});

test("pm engine: should allow explicit parity check", async () => {
  const dir = await makeTempDir("better-pm-explicit-parity-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "pm-explicit-parity-test",
      version: "1.0.0",
      dependencies: {}
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--parity-check", "warn", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.engine, "pm");
    assert.ok(report.parity);
    assert.equal(report.parity.mode, "warn");
  } finally {
    await rmrf(dir);
  }
});

test("report schema: should have all required fields", async () => {
  const dir = await makeTempDir("better-schema-fields-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "schema-fields-test",
      version: "1.0.0",
      dependencies: {}
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.kind, "better.install.report");
    assert.equal(report.schemaVersion, 2);
    assert.ok(report.runId);
    assert.ok(report.startedAt);
    assert.ok(report.endedAt);
    // On macOS, /var and /private/var are the same (symlink)
    const real = await fs.realpath(dir);
    assert.ok(report.projectRoot === dir || report.projectRoot === path.resolve(dir) || report.projectRoot === real);
    assert.ok(report.pm);
    assert.ok(report.engine);
    assert.ok(report.mode);
    assert.ok(report.lockfilePolicy);
    assert.ok(report.cacheRoot);
    assert.ok(report.command);
    assert.ok(report.install);
    assert.ok(report.nodeModules);
    assert.ok(report.cache);
    assert.ok(report.baseline);
  } finally {
    await rmrf(dir);
  }
});

test("report schema: should have valid command structure", async () => {
  const dir = await makeTempDir("better-schema-command-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "schema-command-test",
      version: "1.0.0",
      dependencies: {}
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.ok(report.command.cmd);
    assert.ok(Array.isArray(report.command.args));
  } finally {
    await rmrf(dir);
  }
});

test("report schema: should have valid pm structure", async () => {
  const dir = await makeTempDir("better-schema-pm-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "schema-pm-test",
      version: "1.0.0",
      dependencies: {}
    });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--json"], {
      cwd: dir,
      timeout: 60000
    });

    const report = extractJson(stdout);
    assert.ok(report.pm.name);
    assert.ok(report.pm.detected);
    assert.ok(report.pm.reason);
  } finally {
    await rmrf(dir);
  }
});
