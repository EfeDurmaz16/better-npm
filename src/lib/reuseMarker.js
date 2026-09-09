import fs from "node:fs/promises";
import path from "node:path";

function stableValue(value) {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableValue(value[key]);
  }
  return out;
}

function stableString(value) {
  return JSON.stringify(stableValue(value));
}

export function reuseMarkerPath(projectRoot) {
  return path.join(projectRoot, "node_modules", ".better-state.json");
}

export async function readReuseMarker(projectRoot) {
  const markerPath = reuseMarkerPath(projectRoot);
  try {
    const raw = await fs.readFile(markerPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Inventory package identities and link destinations, not arbitrary file contents.
// Never recurse through symlinks: strict dependency links may form cycles.
async function packageInventory(projectRoot) {
  const root = path.join(projectRoot, "node_modules");
  const inventory = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === ".better" && entry.isDirectory()) {
        for (const stored of await fs.readdir(full, { withFileTypes: true })) {
          if (!stored.isDirectory()) continue;
          const store = path.join(full, stored.name);
          if (stored.name.startsWith("@")) {
            for (const scoped of await fs.readdir(store)) pending.push(path.join(store, scoped, "node_modules"));
          } else pending.push(path.join(store, "node_modules"));
        }
        continue;
      }
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const pkg = JSON.parse(await fs.readFile(path.join(full, "package.json"), "utf8"));
      const identity = { path: path.relative(root, full), name: pkg.name ?? null, version: pkg.version ?? null };
      if (entry.isSymbolicLink()) {
        identity.target = await fs.readlink(full);
      } else {
        const nested = path.join(full, "node_modules");
        try {
          if ((await fs.lstat(nested)).isDirectory()) pending.push(nested);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      inventory.push(identity);
    }
  }
  return inventory.sort((a, b) => a.path.localeCompare(b.path));
}

export async function writeReuseMarker(projectRoot, marker) {
  const markerPath = reuseMarkerPath(projectRoot);
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  const inventory = await packageInventory(projectRoot);
  await fs.writeFile(markerPath, `${JSON.stringify({ ...marker, version: 2, inventory }, null, 2)}\n`);
  return markerPath;
}

export async function evaluateReuseMarker(projectRoot, expected) {
  if (!expected?.key || !expected?.lockHash || !expected?.fingerprint) {
    return {
      hit: false,
      reason: "reuse_context_unavailable",
      marker: null
    };
  }

  const marker = await readReuseMarker(projectRoot);
  if (!marker) return { hit: false, reason: "marker_missing", marker: null };
  if (marker?.version !== 2) return { hit: false, reason: "marker_version_mismatch", marker };
  if (marker?.engine !== "better") return { hit: false, reason: "marker_engine_mismatch", marker };
  if (marker?.globalKey !== expected.key) return { hit: false, reason: "key_mismatch", marker };
  if (marker?.lockHash !== expected.lockHash) return { hit: false, reason: "lock_hash_mismatch", marker };

  const markerFingerprint = marker?.runtimeFingerprint ?? null;
  if (stableString(markerFingerprint) !== stableString(expected.fingerprint)) {
    return { hit: false, reason: "runtime_fingerprint_mismatch", marker };
  }

  try {
    if (!Array.isArray(marker.inventory) || stableString(marker.inventory) !== stableString(await packageInventory(projectRoot))) {
      return { hit: false, reason: "package_inventory_mismatch", marker };
    }
  } catch {
    return { hit: false, reason: "package_inventory_unreadable", marker };
  }

  return { hit: true, reason: "reuse_marker_hit", marker };
}
