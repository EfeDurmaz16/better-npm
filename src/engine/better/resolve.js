import { tryLoadNapiAddon } from "../../lib/core.js";
import { readNpmLockfile, iterNodeModulesPackages } from "./npmLockfile.js";

/**
 * Resolve packages from package-lock.json
 * Falls back to JS implementation if NAPI addon is not available
 */
export async function resolveFromLockfile(lockfilePath) {
  const addon = tryLoadNapiAddon();

  if (addon?.resolve) {
    try {
      const result = addon.resolve(lockfilePath);
      if (result.ok) {
        return {
          ok: true,
          packages: result.packages,
          lockfileVersion: result.lockfileVersion,
          runtime: "napi"
        };
      }
    } catch (err) {
      // Fall through to JS implementation
      console.warn(`NAPI resolve failed, falling back to JS: ${err.message}`);
    }
  }

  // JS fallback
  const lock = await readNpmLockfile(lockfilePath);
  const items = iterNodeModulesPackages(lock);

  const packages = items
    .filter(it => it.meta?.resolved && it.meta?.integrity)
    .map(it => ({
      name: it.meta.name ?? packageNameFromRelPath(it.relPath),
      version: it.meta.version ?? "0.0.0",
      relPath: it.relPath,
      resolvedUrl: it.meta.resolved,
      integrity: it.meta.integrity
    }));

  return {
    ok: true,
    packages,
    lockfileVersion: lock.lockfileVersion,
    runtime: "js"
  };
}

function packageNameFromRelPath(relPath) {
  const segments = relPath.split("/").filter(Boolean);
  const nm = segments.indexOf("node_modules");
  if (nm < 0 || nm + 1 >= segments.length) return "unknown";
  const first = segments[nm + 1];
  if (!first) return "unknown";
  if (first.startsWith("@")) {
    const second = segments[nm + 2];
    if (!second) return "unknown";
    return `${first}/${second}`;
  }
  return first;
}
