import crypto from "node:crypto";

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function shortHash(input) {
  return sha256Hex(input).slice(0, 10);
}

