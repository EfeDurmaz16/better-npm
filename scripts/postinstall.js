#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, "..", "bin");
const binaryPath = join(binDir, "better-core");

// Skip if binary already exists
if (existsSync(binaryPath)) process.exit(0);

const VERSION = process.env.BETTER_VERSION || "latest";
const REPO = "EfeDurmaz16/better-npm";

const PLATFORM_MAP = {
  darwin: "apple-darwin",
  linux: "unknown-linux-gnu",
};

const ARCH_MAP = {
  x64: "x86_64",
  arm64: "aarch64",
};

const platform = PLATFORM_MAP[process.platform];
const arch = ARCH_MAP[process.arch];

if (!platform || !arch) {
  console.warn(`better: no prebuilt binary for ${process.platform}-${process.arch}, Rust core unavailable`);
  process.exit(0); // Don't fail install
}

const target = `${arch}-${platform}`;
const url = VERSION === "latest"
  ? `https://github.com/${REPO}/releases/latest/download/better-${target}.tar.gz`
  : `https://github.com/${REPO}/releases/download/v${VERSION}/better-${target}.tar.gz`;

console.log(`better: downloading prebuilt binary for ${target}...`);

// Download and extract using curl (available on all platforms)
// Note: execSync is safe here — url and binDir are constructed from hardcoded
// constants and process.platform/process.arch, not from user input.
try {
  execSync(`curl -fsSL "${url}" | tar -xz -C "${binDir}" better-core`, { stdio: "pipe" });
  chmodSync(binaryPath, 0o755);
  console.log("better: binary installed successfully");
} catch {
  console.warn("better: failed to download prebuilt binary, Rust core unavailable");
  console.warn("better: JS commands will still work, but install/analyze require the Rust binary");
  // Don't fail — graceful degradation
}
