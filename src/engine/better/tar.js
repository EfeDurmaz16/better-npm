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

async function detectPackageDir(destDir) {
  const explicit = path.join(destDir, "package");
  if (await exists(path.join(explicit, "package.json"))) return explicit;

  if (await exists(path.join(destDir, "package.json"))) return destDir;

  const entries = await fs.readdir(destDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  if (dirs.length === 1) {
    const candidate = path.join(destDir, dirs[0]);
    if (await exists(path.join(candidate, "package.json"))) return candidate;
  }
  return null;
}

export async function extractTgz(tgzPath, destDir) {
  const marker = path.join(destDir, ".better_extracted");
  await fs.mkdir(destDir, { recursive: true });

  // Reuse only when marker and a detected package root both exist.
  const hasMarker = await exists(marker);
  const detectedBefore = await detectPackageDir(destDir);
  if (hasMarker && detectedBefore) {
    return { ok: true, reused: true, packageDir: detectedBefore };
  }
  if (hasMarker && !detectedBefore) {
    // Self-heal stale/partial unpack cache entries.
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.mkdir(destDir, { recursive: true });
  }

  // tarball layout typically contains "package/" prefix.
  const res = await runCommand("tar", ["-xzf", tgzPath, "-C", destDir], { passthroughStdio: false, captureLimitBytes: 1024 * 64 });
  if (res.exitCode !== 0) {
    throw new Error(`tar extract failed (exit ${res.exitCode}): ${res.stderrTail}`);
  }
  const detectedAfter = await detectPackageDir(destDir);
  if (!detectedAfter) {
    throw new Error(`tar extract missing package root for ${tgzPath}`);
  }
  await fs.writeFile(marker, "ok\n");
  return { ok: true, reused: false, packageDir: detectedAfter };
}
