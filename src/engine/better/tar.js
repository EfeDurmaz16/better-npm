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
  const marker = path.join(destDir, ".better_extracted");
  const packageDir = path.join(destDir, "package");
  await fs.mkdir(destDir, { recursive: true });

  // Reuse only when both marker and expected package dir exist.
  const hasMarker = await exists(marker);
  const hasPackageDir = await exists(packageDir);
  if (hasMarker && hasPackageDir) {
    return { ok: true, reused: true };
  }
  if (hasMarker && !hasPackageDir) {
    // Self-heal stale/partial unpack cache entries.
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.mkdir(destDir, { recursive: true });
  }

  // tarball layout typically contains "package/" prefix.
  const res = await runCommand("tar", ["-xzf", tgzPath, "-C", destDir], { passthroughStdio: false, captureLimitBytes: 1024 * 64 });
  if (res.exitCode !== 0) {
    throw new Error(`tar extract failed (exit ${res.exitCode}): ${res.stderrTail}`);
  }
  if (!(await exists(packageDir))) {
    throw new Error(`tar extract missing expected package/ dir for ${tgzPath}`);
  }
  await fs.writeFile(marker, "ok\n");
  return { ok: true, reused: false };
}
