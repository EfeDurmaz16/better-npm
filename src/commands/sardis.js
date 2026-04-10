/**
 * better login/logout/wallet — Sardis authentication and wallet management
 *
 * Usage:
 *   better login --sardis                 Interactive Sardis login
 *   better login --sardis --token TOKEN   Non-interactive login with API key
 *   better wallet                         Show wallet balance and trust tier
 *   better logout --sardis                Revoke session and delete credentials
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const LOGIN_HELP = `better login --sardis — Sardis authentication

Usage:
  better login --sardis                        Interactive login (prompts for credentials)
  better login --sardis --token API_KEY        Non-interactive login with API key
  better login --sardis --token $SARDIS_TOKEN  Use environment variable

Options:
  --token TOKEN  API key for non-interactive / CI login
  --json         Machine-readable output
  -h, --help     Show this help
`;

const WALLET_HELP = `better wallet — Sardis wallet balance

Usage:
  better wallet              Show balance and trust tier
  better wallet --json       Machine-readable output
  -h, --help                 Show this help
`;

const LOGOUT_HELP = `better logout --sardis — Remove Sardis credentials

Usage:
  better logout --sardis     Revoke session and delete local credentials
  -h, --help                 Show this help
`;

export async function cmdSardisLogin(argv) {
  const runtime = getRuntimeConfig();
  if (argv.includes("-h") || argv.includes("--help")) {
    printText(LOGIN_HELP);
    return;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      sardis:  { type: "boolean", default: false },
      token:   { type: "string" },
      json:    { type: "boolean", default: runtime.json === true },
    },
    strict: false,
  });

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.sardis.login", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found — cannot authenticate with Sardis"); }
    process.exitCode = 1;
    return;
  }

  const token = values.token ?? process.env.SARDIS_TOKEN;
  const coreArgs = ["sardis", "login"];
  if (token) coreArgs.push("--token", token);
  if (values.json) coreArgs.push("--json");

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

export async function cmdWallet(argv) {
  const runtime = getRuntimeConfig();
  if (argv.includes("-h") || argv.includes("--help")) {
    printText(WALLET_HELP);
    return;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
    },
    strict: false,
  });

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.sardis.wallet", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["sardis", "wallet"];
  if (values.json) coreArgs.push("--json");

  const result = spawnSync(corePath, coreArgs, {
    stdio: values.json ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });

  if (values.json && result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      printJson(parsed);
    } catch {
      printText(result.stdout.trim());
    }
  } else if (!values.json && result.stdout) {
    printText(result.stdout.trim());
  }
  process.exitCode = result.status ?? 0;
}

export async function cmdSardisLogout(argv) {
  const runtime = getRuntimeConfig();
  if (argv.includes("-h") || argv.includes("--help")) {
    printText(LOGOUT_HELP);
    return;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      sardis: { type: "boolean", default: false },
      json:   { type: "boolean", default: runtime.json === true },
    },
    strict: false,
  });

  const corePath = await findBetterCore();
  if (!corePath) {
    const out = { ok: false, kind: "better.sardis.logout", error: "better-core binary not found" };
    if (values.json) { printJson(out); } else { printText("error: better-core binary not found"); }
    process.exitCode = 1;
    return;
  }

  const coreArgs = ["sardis", "logout"];
  if (values.json) coreArgs.push("--json");

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
  } else if (!values.json && result.stdout) {
    printText(result.stdout.trim());
  }
  process.exitCode = result.status ?? 0;
}
