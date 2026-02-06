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

export async function detectPackageManager(projectRoot) {
  const pkgPath = path.join(projectRoot, "package.json");
  let pkg = null;
  if (await exists(pkgPath)) {
    try {
      pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    } catch {
      // ignore
    }
  }

  const declared = pkg?.packageManager;
  if (typeof declared === "string" && declared.length) {
    const [name] = declared.split("@");
    if (name === "npm" || name === "pnpm" || name === "yarn") {
      return { pm: name, reason: "package.json#packageManager" };
    }
  }

  const hasPnpm = await exists(path.join(projectRoot, "pnpm-lock.yaml"));
  const hasYarn = await exists(path.join(projectRoot, "yarn.lock"));
  const hasYarnBerryConfig = await exists(path.join(projectRoot, ".yarnrc.yml"));
  const hasNpm = (await exists(path.join(projectRoot, "package-lock.json"))) ||
    (await exists(path.join(projectRoot, "npm-shrinkwrap.json")));

  if (hasPnpm) return { pm: "pnpm", reason: "pnpm-lock.yaml" };
  if (hasYarn) return { pm: "yarn", reason: hasYarnBerryConfig ? "yarn.lock + .yarnrc.yml" : "yarn.lock" };
  if (hasNpm) return { pm: "npm", reason: "package-lock/shrinkwrap" };

  return { pm: "npm", reason: "default" };
}

