import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function makeTempDir(prefix = "better-test-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

export async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(obj, null, 2)}\n`);
}

export async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

