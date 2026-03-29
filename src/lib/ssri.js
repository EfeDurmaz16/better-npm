import crypto from "node:crypto";

export function parseIntegrity(integrity) {
  if (typeof integrity !== "string" || integrity.length === 0) return [];
  // Support multi-hash strings separated by whitespace.
  return integrity
    .trim()
    .split(/\s+/g)
    .map((part) => {
      const idx = part.indexOf("-");
      if (idx <= 0) return null;
      const algorithm = part.slice(0, idx);
      const base64 = part.slice(idx + 1);
      return { algorithm, base64, raw: part };
    })
    .filter(Boolean);
}

export function toHexFromBase64(base64) {
  return Buffer.from(base64, "base64").toString("hex");
}

export function computeHashFile(filePath, algorithm) {
  const hash = crypto.createHash(algorithm);
  return hashFileStream(filePath, hash).then(() => hash.digest());
}

async function hashFileStream(filePath, hash) {
  const fs = await import("node:fs");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
}

export async function verifyFileIntegrity(filePath, integrity, opts = {}) {
  const { required = true } = opts;
  const parsed = parseIntegrity(integrity);
  if (parsed.length === 0) {
    if (required) throw new Error("Missing or invalid integrity");
    return { ok: false, reason: "missing_integrity" };
  }

  // Prefer sha512 if available.
  const sha512 = parsed.find((p) => p.algorithm === "sha512");
  const chosen = sha512 ?? parsed[0];
  if (!chosen) throw new Error("No supported integrity hashes");

  const digest = await computeHashFile(filePath, chosen.algorithm);
  const expected = Buffer.from(chosen.base64, "base64");
  const ok = digest.equals(expected);
  return {
    ok,
    algorithm: chosen.algorithm,
    expectedBase64: chosen.base64,
    actualBase64: digest.toString("base64")
  };
}

