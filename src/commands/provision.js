/**
 * better provision — OSP service provisioning
 *
 * Usage:
 *   better provision supabase.com/postgres             Provision postgres from Supabase
 *   better provision supabase.com/postgres --tier free  Specific tier
 *   better provision supabase.com/postgres --pay sardis  Pay via Sardis wallet
 *   better provision --dry-run                          Show what would be provisioned
 *   better deprovision <resource_id>                    Deprovision a service
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const PROVISION_HELP = `better provision — Provision an OSP service

Usage:
  better provision <provider/offering>              Provision using default tier
  better provision <provider/offering> --tier TIER  Provision specific tier
  better provision <provider/offering> --pay sardis  Pay with Sardis wallet
  better provision --dry-run                        Preview without provisioning

Arguments:
  provider/offering   e.g. supabase.com/postgres, upstash.com/redis

Options:
  --tier TIER       Service tier (e.g. free, pro, enterprise)
  --pay METHOD      Payment method: sardis (default: sardis)
  --region REGION   Preferred deployment region
  --org ORG         Organisation budget (enterprise)
  --dry-run         Preview cost + steps without provisioning
  --json            Machine-readable output
  -h, --help        Show this help

Examples:
  better provision supabase.com/postgres
  better provision supabase.com/postgres --tier pro --pay sardis
  better provision upstash.com/redis --region us-east-1
`;

const DEPROVISION_HELP = `better deprovision — Remove a provisioned OSP service

Usage:
  better deprovision <resource_id>          Remove a provisioned service
  better deprovision <resource_id> --force  Also remove .env.osp references

Options:
  --force    Remove references from .env.osp as well
  --json     Machine-readable output
  -h, --help Show this help
`;

export async function cmdProvision(argv) {
  const runtime = getRuntimeConfig();
  if (argv.includes("-h") || argv.includes("--help")) {
    printText(PROVISION_HELP);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      tier:     { type: "string" },
      pay:      { type: "string", default: "sardis" },
      region:   { type: "string" },
      org:      { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json:     { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const offering = positionals[0];
  if (!offering) {
    printText("error: 'provision' requires a provider/offering argument\n\nUsage: better provision <provider/offering> [options]");
    process.exitCode = 1;
    return;
  }

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.osp.provision", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["provision", offering];
  if (values.tier) coreArgs.push("--tier", values.tier);
  if (values.pay)  coreArgs.push("--pay", values.pay);
  if (values.region) coreArgs.push("--region", values.region);
  if (values.org)  coreArgs.push("--org", values.org);
  if (values["dry-run"]) coreArgs.push("--dry-run");
  if (values.json) coreArgs.push("--json");

  if (!values.json) {
    const [provider, svc] = offering.split("/");
    printText(`Provisioning ${svc ?? offering} from ${provider}${values["dry-run"] ? " (dry run)" : ""}...`);
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

export async function cmdDeprovision(argv) {
  const runtime = getRuntimeConfig();
  if (argv.includes("-h") || argv.includes("--help")) {
    printText(DEPROVISION_HELP);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean", default: false },
      json:  { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const resourceId = positionals[0];
  if (!resourceId) {
    printText("error: 'deprovision' requires a resource_id argument\n\nUsage: better deprovision <resource_id>");
    process.exitCode = 1;
    return;
  }

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.osp.deprovision", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["deprovision", resourceId];
  if (values.force) coreArgs.push("--force");
  if (values.json)  coreArgs.push("--json");

  if (!values.json) printText(`Deprovisioning resource ${resourceId}...`);

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
