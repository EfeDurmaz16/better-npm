import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findBetterCore, tryLoadNapiAddon } from "../src/lib/core.js";

const exec = promisify(execFile);
test("resident completion does not occupy Node filesystem workers", { timeout: 20_000 }, async (t) => {
  const addon = tryLoadNapiAddon();
  const core = await findBetterCore();
  if (!core || typeof addon?.installResident !== "function") {
    t.skip("Build the native core and resident addon to run the I/O isolation test");
    return;
  }
  const { stdout } = await exec(process.execPath, [fileURLToPath(new URL("./fixtures/resident-io-probe.mjs", import.meta.url)), core], {
    env: { ...process.env, UV_THREADPOOL_SIZE: "4" },
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  assert.deepEqual(JSON.parse(stdout), { responsive: true, completed: 4 });
});
