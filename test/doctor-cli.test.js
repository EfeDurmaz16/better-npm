import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("doctor emits a score and deductions in JSON", async () => {
  const dir = await makeTempDir();
  try {
    await fs.mkdir(path.join(dir, "node_modules", "dup"), { recursive: true });
    await writeJson(path.join(dir, "node_modules", "dup", "package.json"), { name: "dup", version: "2.0.0" });
    await fs.mkdir(path.join(dir, "node_modules", "app", "node_modules", "dup"), { recursive: true });
    await writeJson(path.join(dir, "node_modules", "app", "package.json"), { name: "app", version: "1.0.0" });
    await writeJson(path.join(dir, "node_modules", "app", "node_modules", "dup", "package.json"), { name: "dup", version: "1.0.0" });
    await writeJson(path.join(dir, "package.json"), { name: "proj", version: "1.0.0" });
    await writeJson(path.join(dir, "pnpm-lock.yaml"), { lockfileVersion: 9 });

    const betterBin = path.resolve(process.cwd(), "bin", "better.js");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "doctor", "--json"], {
      cwd: dir
    });
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.kind, "better.doctor");
    assert.ok(typeof out.healthScore.score === "number");
  } finally {
    await rmrf(dir);
  }
});
