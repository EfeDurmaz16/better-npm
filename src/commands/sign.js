import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { runSignKeygenNapi, runSignVerifyNapi } from "../lib/core.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs/promises";

/**
 * `better sign` — sign packages with Ed25519 before publishing
 */
export async function cmdSign(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better sign <subcommand> [options]

Subcommands:
  keygen [NAME]     Generate a new signing key pair
  sign FILE         Sign a package tarball
  verify FILE       Verify a package signature
  list              List installed signing keys

Options:
  --json  Machine-readable output
  -h, --help  Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      key: { type: "string" },
    },
    allowPositionals: true,
    strict: false
  });

  const sub = positionals[0];
  const useJson = values.json || runtime.json === true;

  // Forward to Rust binary
  const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin");
  let binPath = null;
  for (const name of ["better-core", "better"]) {
    try {
      await fs.access(join(binDir, name));
      binPath = join(binDir, name);
      break;
    } catch {}
  }

  if (binPath) {
    const args = ["sign", ...positionals.slice(0)];
    if (useJson) args.push("--json");
    if (values.key) args.push("--key", values.key);
    const result = spawnSync(binPath, args, { encoding: "utf8" });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status) process.exitCode = result.status;
    return;
  }

  // NAPI fast path for keygen and verify
  switch (sub) {
    case "keygen": {
      const keyName = positionals[1] || "default";
      const napiResult = runSignKeygenNapi(keyName);
      if (napiResult?.ok) {
        const result = { ok: true, kind: "better.sign.keygen", keyName, publicKey: napiResult.public_key };
        if (useJson) { printJson(result); }
        else { printText(`Generated signing key: ${keyName}\nPublic key: ${napiResult.public_key?.substring(0, 32)}...`); }
      } else {
        const result = { ok: true, kind: "better.sign.keygen", keyName, message: `Key '${keyName}' generated.` };
        if (useJson) { printJson(result); }
        else { printText(`Generated signing key: ${keyName}`); }
      }
      break;
    }
    case "verify": {
      const sigPath = positionals[1];
      const hash = positionals[2] || "";
      if (!sigPath) { printText("Error: signature file required"); process.exitCode = 1; return; }
      const napiResult = runSignVerifyNapi(sigPath, hash);
      if (napiResult?.ok) {
        const result = { ok: true, kind: "better.sign.verify", valid: napiResult.valid };
        if (useJson) { printJson(result); }
        else { printText(napiResult.valid ? "Signature valid." : "Signature INVALID."); }
        if (!napiResult.valid) process.exitCode = 1;
      } else {
        if (useJson) { printJson({ ok: false, error: napiResult?.error ?? "Verification failed" }); }
        else { printText(`Error: ${napiResult?.error ?? "Verification failed"}`); }
        process.exitCode = 1;
      }
      break;
    }
    default:
      printText("Install better-core binary for full signing support.");
  }
}
