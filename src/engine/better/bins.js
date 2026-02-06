import fs from "node:fs/promises";
import path from "node:path";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isWindows() {
  return process.platform === "win32";
}

export async function readPackageBin(packageDir) {
  const pkgPath = path.join(packageDir, "package.json");
  let raw;
  try {
    raw = await fs.readFile(pkgPath, "utf8");
  } catch {
    return [];
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  const name = pkg?.name;
  const bin = pkg?.bin;
  if (!bin) return [];
  if (typeof bin === "string") {
    if (typeof name !== "string") return [];
    return [{ name, relPath: bin }];
  }
  if (typeof bin === "object") {
    return Object.entries(bin)
      .filter(([k, v]) => typeof k === "string" && typeof v === "string")
      .map(([k, v]) => ({ name: k, relPath: v }));
  }
  return [];
}

export async function writeRootBinLinks(projectRoot, packagesByPath, opts = {}) {
  const binDir = path.join(projectRoot, "node_modules", ".bin");
  const clean = opts.clean === true;
  if (clean) {
    await fs.rm(binDir, { recursive: true, force: true });
  }
  await fs.mkdir(binDir, { recursive: true });
  const linkMode = opts.linkMode ?? "rootOnly";
  if (linkMode !== "rootOnly") return { linksWritten: 0, cleaned: clean };

  let linksWritten = 0;

  // Deterministic: sort by install path.
  const paths = [...packagesByPath.keys()].sort((a, b) => a.localeCompare(b));
  for (const pkgPath of paths) {
    const abs = packagesByPath.get(pkgPath);
    const bins = await readPackageBin(abs);
    for (const b of bins) {
      const targetAbs = path.join(abs, b.relPath);
      const outName = b.name;
      if (isWindows()) {
        const cmdPath = path.join(binDir, `${outName}.cmd`);
        if (await exists(cmdPath)) continue;
        const rel = path.relative(binDir, targetAbs).replace(/\//g, "\\");
        const content = `@ECHO OFF\r\n"${process.execPath}" "%~dp0\\${rel}" %*\r\n`;
        await fs.writeFile(cmdPath, content, "utf8");
        linksWritten += 1;
      } else {
        const linkPath = path.join(binDir, outName);
        if (await exists(linkPath)) continue;
        const rel = path.relative(binDir, targetAbs);
        await fs.symlink(rel, linkPath);
        linksWritten += 1;
      }
    }
  }

  return { linksWritten, cleaned: clean };
}
