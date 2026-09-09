import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const lintScript = fileURLToPath(new URL("../scripts/lint.mjs", import.meta.url));

async function lintFixture(t, source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "better-lint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "fixture.js"), source);
  return spawnSync(process.execPath, [lintScript], { cwd: root, encoding: "utf8" });
}

test("lint accepts decorative separators and inline marker examples", async (t) => {
  const result = await lintFixture(t, '// ===============\nconst example = "<<<<<<< ours";\n');
  assert.equal(result.status, 0, result.stderr);
});

test("lint rejects unresolved marker lines, including CRLF", async (t) => {
  for (const marker of ["<<<<<<< ours", "=======", ">>>>>>> theirs"]) {
    const result = await lintFixture(t, `/*\r\n${marker}\r\n*/\r\n`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unresolved merge markers in src\/fixture.js/);
  }
});
