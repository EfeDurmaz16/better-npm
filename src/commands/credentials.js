/**
 * better credentials — manage OSP service credentials
 *
 * Usage:
 *   better credentials list                          List credentials for all services
 *   better credentials show supabase.com/postgres    Show masked credentials
 *   better credentials rotate supabase.com/postgres  Rotate credentials for a service
 *   better credentials export supabase.com/postgres  Export credentials to .env format
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const HELP = `better credentials — manage OSP service credentials

Usage:
  better credentials list                          List all provisioned service credentials
  better credentials show <provider/offering>      Show masked credentials for a service
  better credentials rotate <provider/offering>    Rotate credentials (calls OSP rotate endpoint)
  better credentials export <provider/offering>    Export credentials as .env format

Arguments:
  provider/offering   e.g. supabase.com/postgres, upstash.com/redis

Options:
  --format FORMAT    Output format for export: env|json|dotenv (default: env)
  --force            For rotate: force rotation even if recently rotated
  --json             Machine-readable output
  -h, --help         Show this help

Examples:
  better credentials list
  better credentials rotate supabase.com/postgres
  better credentials export upstash.com/redis --format json
`;

export async function cmdCredentials(argv) {
  const runtime = getRuntimeConfig();
  if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  if (!["list", "show", "rotate", "export"].includes(sub)) {
    printText(`Unknown credentials subcommand '${sub}'. Run 'better credentials --help' for usage.`);
    process.exitCode = 1;
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      format: { type: "string", default: "env" },
      force:  { type: "boolean", default: false },
      json:   { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const service = positionals[0];
  if (sub !== "list" && !service) {
    printText(`error: 'credentials ${sub}' requires a provider/offering argument\n\nExample: better credentials ${sub} supabase.com/postgres`);
    process.exitCode = 1;
    return;
  }

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: `better.credentials.${sub}`, error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["credentials", sub];
  if (service) coreArgs.push(service);
  if (values.format) coreArgs.push("--format", values.format);
  if (values.force)  coreArgs.push("--force");
  if (values.json)   coreArgs.push("--json");

  if (!values.json && sub === "rotate") {
    printText(`Rotating credentials for ${service}...`);
  }

  const result = spawnSync(corePath, coreArgs, {
    stdio: values.json ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });

  if (values.json && result.stdout) {
    try {
      printJson(JSON.parse(result.stdout.trim()));
    } catch {
      printText(result.stdout.trim());
    }
  }
  process.exitCode = result.status ?? 0;
}
