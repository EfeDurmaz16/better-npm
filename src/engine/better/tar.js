import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../../lib/spawn.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function extractTgz(tgzPath, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  // If already extracted (marker exists), skip.
  const marker = path.join(destDir, ".better_extracted");
  if (await exists(marker)) return { ok: true, reused: true };

  // tarball layout typically contains "package/" prefix.
  const res = await runCommand("tar", ["-xzf", tgzPath, "-C", destDir], { passthroughStdio: false, captureLimitBytes: 1024 * 64 });
  if (res.exitCode !== 0) {
    throw new Error(`tar extract failed (exit ${res.exitCode}): ${res.stderrTail}`);
  }
  await fs.writeFile(marker, "ok\n");
  return { ok: true, reused: false };
}

