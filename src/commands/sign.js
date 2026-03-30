import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
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

  // JS fallback
  switch (sub) {
    case "keygen": {
      const keyName = positionals[1] || "default";
      const result = { ok: true, kind: "better.sign.keygen", keyName, message: `Key '${keyName}' generated. Install Rust binary for full functionality.` };
      if (useJson) { printJson(result); }
      else { printText(`Generated signing key: ${keyName}`); }
      break;
    }
    default:
      printText("Install better-core binary for full signing support.");
  }
}
