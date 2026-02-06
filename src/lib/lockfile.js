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

function countNpmLockPackages(parsed) {
  if (parsed && typeof parsed === "object") {
    if (parsed.packages && typeof parsed.packages === "object") {
      return Object.keys(parsed.packages).filter((k) => k !== "").length;
    }
    if (parsed.dependencies && typeof parsed.dependencies === "object") {
      const stack = [parsed.dependencies];
      let count = 0;
      while (stack.length > 0) {
        const current = stack.pop();
        for (const value of Object.values(current)) {
          count += 1;
          if (value?.dependencies && typeof value.dependencies === "object") {
            stack.push(value.dependencies);
          }
        }
      }
      return count;
    }
  }
  return 0;
}

function countPnpmLockPackages(raw) {
  return raw
    .split("\n")
    .filter((line) => /^ {2}['"]?(?:@|\/)/.test(line) && line.includes(":"))
    .length;
}

function countYarnLockPackages(raw) {
  return raw
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.endsWith(":")) return false;
      if (trimmed.startsWith("#")) return false;
      if (trimmed.startsWith("__metadata")) return false;
      return !line.startsWith(" ");
    })
    .length;
}

export async function detectPrimaryLockfile(projectRoot) {
  const order = [
    { pm: "pnpm", file: "pnpm-lock.yaml" },
    { pm: "yarn", file: "yarn.lock" },
    { pm: "npm", file: "package-lock.json" },
    { pm: "npm", file: "npm-shrinkwrap.json" }
  ];
  for (const item of order) {
    const full = path.join(projectRoot, item.file);
    if (await exists(full)) {
      return { ...item, path: full };
    }
  }
  return null;
}

export async function estimatePackagesFromLockfile(projectRoot) {
  const lock = await detectPrimaryLockfile(projectRoot);
  if (!lock) {
    return { ok: false, reason: "lockfile_not_found", packageCount: 0, lockfile: null };
  }

  try {
    const raw = await fs.readFile(lock.path, "utf8");
    let packageCount = 0;
    if (lock.file === "package-lock.json" || lock.file === "npm-shrinkwrap.json") {
      packageCount = countNpmLockPackages(JSON.parse(raw));
    } else if (lock.file === "pnpm-lock.yaml") {
      packageCount = countPnpmLockPackages(raw);
    } else if (lock.file === "yarn.lock") {
      packageCount = countYarnLockPackages(raw);
    }

    return {
      ok: true,
      packageCount,
      lockfile: { pm: lock.pm, file: lock.file, path: lock.path }
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message ?? String(err),
      packageCount: 0,
      lockfile: { pm: lock.pm, file: lock.file, path: lock.path }
    };
  }
}

