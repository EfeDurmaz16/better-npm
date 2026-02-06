import fs from "node:fs/promises";

export async function readNpmLockfile(lockfilePath) {
  const raw = await fs.readFile(lockfilePath, "utf8");
  const json = JSON.parse(raw);
  const v = json?.lockfileVersion;
  if (v !== 2 && v !== 3) {
    throw new Error(`Unsupported package-lock.json lockfileVersion ${v}. Expected 2 or 3.`);
  }
  if (!json?.packages || typeof json.packages !== "object") {
    throw new Error("package-lock.json missing 'packages' map (lockfileVersion 2/3 expected).");
  }
  return json;
}

export function detectWorkspaceLikeEntries(lock) {
  const keys = Object.keys(lock.packages || {});
  return keys.some((k) => k !== "" && !k.startsWith("node_modules/"));
}

export function detectNonRootNodeModulesEntries(lock) {
  const keys = Object.keys(lock.packages || {});
  // npm lockfile keys always use forward slashes.
  return keys.some((k) => typeof k === "string" && k.includes("/node_modules/") && !k.startsWith("node_modules/"));
}

export function listWorkspacePackageEntries(lock) {
  const out = [];
  for (const [k, v] of Object.entries(lock.packages || {})) {
    if (!k || k === "") continue;
    if (k.startsWith("node_modules/")) continue;
    out.push({ relPath: k, meta: v });
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

export function iterNodeModulesPackages(lock) {
  const out = [];
  for (const [k, v] of Object.entries(lock.packages || {})) {
    if (!k || k === "") continue;
    if (!k.startsWith("node_modules/")) continue;
    out.push({ relPath: k, meta: v });
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}
