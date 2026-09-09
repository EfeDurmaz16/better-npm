import path from "node:path";

// Match the native Integrity parser: one canonical, supported SRI digest.
export function lazyPackageCasPath(cacheRoot, integrity) {
  const match = typeof integrity === "string"
    ? /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity)
    : null;
  if (!match || match[0] !== integrity) throw new Error("lazy: invalid or unsupported integrity");
  const [, algorithm, encoded] = match;
  const digest = Buffer.from(encoded, "base64");
  const lengths = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  if (digest.length !== lengths[algorithm] || digest.toString("base64") !== encoded) {
    throw new Error("lazy: invalid integrity digest");
  }
  const hex = digest.toString("hex");
  return path.join(cacheRoot, "store", "unpacked", algorithm, hex.slice(0, 2), hex.slice(2, 4), hex, "package");
}
