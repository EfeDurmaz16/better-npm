import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/better.js", import.meta.url));

test("native workspace requests fail before cache, package-manager, or core execution", async () => {
  for (const kind of ["npm", "pnpm", "selection"]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "better-native-workspace-"));
    try {
      const pkg = { name: "root", private: true };
      if (kind === "npm") pkg.workspaces = ["packages/*"];
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
      if (kind === "pnpm") await fs.writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      const child = path.join(dir, "packages", "lib");
      await fs.mkdir(child, { recursive: true });
      await fs.writeFile(path.join(child, "package.json"), '{"name":"lib","version":"1.0.0"}');
      const cache = path.join(dir, "cache");
      const args = [cli, "install", "--engine", "better", "--experimental", "--project-root", dir, "--cache-root", cache, "--json"];
      if (kind === "selection") args.push("--workspace", "lib");
      // An empty PATH prevents any external installer or Rust binary from being available.
      const result = spawnSync(process.execPath, args, { cwd: dir, env: { ...process.env, PATH: "" }, encoding: "utf8" });
      assert.notEqual(result.status, 0, `${kind}: ${result.stdout}`);
      assert.match(result.stdout + result.stderr, /Native install does not support workspaces or workspace selection/);
      for (const output of [cache, path.join(dir, "node_modules"), path.join(child, "node_modules"), path.join(dir, "better.lock")]) {
        await assert.rejects(fs.access(output), { code: "ENOENT" });
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});
