import fs from "node:fs/promises";
import path from "node:path";

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function depNames(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj).sort();
}

export async function enrichPackagesWithManifest(packages) {
  const enriched = [];
  for (const pkg of packages ?? []) {
    const firstPath = Array.isArray(pkg.paths) && pkg.paths.length > 0 ? pkg.paths[0] : null;
    if (!firstPath) {
      enriched.push({
        ...pkg,
        manifest: { dependencies: [], devDependencies: [], peerDependencies: [] },
        deprecated: null
      });
      continue;
    }

    const pkgJsonPath = path.join(firstPath, "package.json");
    try {
      const parsed = await readJson(pkgJsonPath);
      const deprecated = typeof parsed.deprecated === "string"
        ? parsed.deprecated
        : parsed.deprecated === true
          ? "This package is deprecated."
          : null;

      enriched.push({
        ...pkg,
        manifest: {
          dependencies: depNames(parsed.dependencies),
          devDependencies: depNames(parsed.devDependencies),
          peerDependencies: depNames(parsed.peerDependencies),
          optionalDependencies: depNames(parsed.optionalDependencies)
        },
        deprecated
      });
    } catch {
      enriched.push({
        ...pkg,
        manifest: { dependencies: [], devDependencies: [], peerDependencies: [], optionalDependencies: [] },
        deprecated: null
      });
    }
  }
  return enriched;
}

