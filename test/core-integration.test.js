import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { makeTempDir, rmrf, writeFile, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureCoreBuilt() {
  const corePath = path.resolve(process.cwd(), "crates", "target", "debug", process.platform === "win32" ? "better-core.exe" : "better-core");
  if (await exists(corePath)) return corePath;
  try {
    await execFileAsync("cargo", ["build", "--manifest-path", "crates/Cargo.toml", "-p", "better-core"], {
      cwd: process.cwd(),
      timeout: 120_000
    });
  } catch (err) {
    test.skip(`cargo build not available: ${err?.message ?? err}`);
    return null;
  }
  if (await exists(corePath)) return corePath;
  throw new Error("better-core build did not produce expected binary");
}

test("better-core analyze emits a compatible better.analyze.report JSON", async () => {
  const corePath = await ensureCoreBuilt();
  if (!corePath) return;

  const dir = await makeTempDir("better-core-fixture-");
  try {
    await fs.mkdir(path.join(dir, "node_modules", "foo"), { recursive: true });
    await writeJson(path.join(dir, "node_modules", "foo", "package.json"), { name: "foo", version: "1.0.0" });
    await writeFile(path.join(dir, "node_modules", "foo", "index.js"), "module.exports = 1;\n");

    const { stdout } = await execFileAsync(corePath, ["analyze", "--root", dir, "--no-graph"], { timeout: 60_000 });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "better.analyze.report");
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(Array.isArray(parsed.packages));
    assert.ok(parsed.packages.some((p) => p.key === "foo@1.0.0"));
    assert.ok(parsed.nodeModules.logicalBytes > 0);
  } finally {
    await rmrf(dir);
  }
});

