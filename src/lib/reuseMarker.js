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

export async function writeReuseMarker(projectRoot, marker) {
  const markerPath = reuseMarkerPath(projectRoot);
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
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
  if (marker?.version !== 1) return { hit: false, reason: "marker_version_mismatch", marker };
  if (marker?.engine !== "better") return { hit: false, reason: "marker_engine_mismatch", marker };
  if (marker?.globalKey !== expected.key) return { hit: false, reason: "key_mismatch", marker };
  if (marker?.lockHash !== expected.lockHash) return { hit: false, reason: "lock_hash_mismatch", marker };

  const markerFingerprint = marker?.runtimeFingerprint ?? null;
  if (stableString(markerFingerprint) !== stableString(expected.fingerprint)) {
    return { hit: false, reason: "runtime_fingerprint_mismatch", marker };
  }

  return { hit: true, reason: "reuse_marker_hit", marker };
}
