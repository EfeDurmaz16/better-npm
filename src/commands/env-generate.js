/**
 * better env generate — resolve .env.osp template to .env
 *
 * JS-native: parses .env.osp, resolves osp:// URIs from local vault,
 * writes .env. Delegates to better-core binary if available.
 *
 * osp:// URI format:  osp://<provider>/<service>/<credential_key>
 * Example:  DATABASE_URL=osp://supabase.com/postgres/connection_string
 */

import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { findBetterCore } from "../lib/core.js";
import { runCommand } from "../lib/spawn.js";

const HELP = `better env generate — resolve .env.osp to .env

Usage:
  better env generate                       Resolve .env.osp → .env
  better env generate --template FILE       Use custom template file
  better env generate --output FILE         Write to custom output (default: .env)
  better env generate --dry-run             Print resolved values without writing
  better env generate --json                Output as JSON

Options:
  --template FILE    Path to .env.osp template (default: .env.osp in project root)
  --output FILE      Output path (default: .env in project root)
  --dry-run          Print without writing
  --project-root     Override project root detection
  --json             Machine-readable output
  -h, --help         Show this help

How it works:
  .env.osp is a template where osp:// URIs are replaced by credentials
  from your provisioned services vault.

  DATABASE_URL=osp://supabase.com/postgres/connection_string
  REDIS_URL=osp://upstash.com/redis/url
  PORT=3000   (static values pass through unchanged)

Vault location: ~/.better/vault/<provider>/<service>.json
`;

/** Parse a .env.osp file into an array of {key, value, isOsp, ospUri} entries */
function parseEnvTemplate(content) {
  const lines = content.split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      entries.push({ kind: "comment", raw: line });
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      entries.push({ kind: "comment", raw: line });
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    const isOsp = value.startsWith("osp://");
    entries.push({ kind: "entry", key, value, isOsp, ospUri: isOsp ? value : null, raw: line });
  }
  return entries;
}

/** Load credential from local vault at ~/.better/vault/<provider>/<service>.json */
async function loadVaultCredential(provider, service, credKey) {
  const vaultDir = path.join(os.homedir(), ".better", "vault", provider);
  const vaultFile = path.join(vaultDir, `${service}.json`);
  try {
    const raw = await fs.readFile(vaultFile, "utf8");
    const data = JSON.parse(raw);
    return data[credKey] ?? data.credentials?.[credKey] ?? null;
  } catch {
    return null;
  }
}

/** Resolve osp:// URI to a credential value */
async function resolveOspUri(ospUri) {
  // Format: osp://<provider>/<service>/<cred_key>
  const withoutScheme = ospUri.slice("osp://".length);
  const parts = withoutScheme.split("/");
  if (parts.length < 3) return null;
  const [provider, service, ...credParts] = parts;
  const credKey = credParts.join("_");
  return loadVaultCredential(provider, service, credKey);
}

export async function cmdEnvGenerate(argv) {
  const runtime = getRuntimeConfig();
  if (argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      template:       { type: "string" },
      output:         { type: "string" },
      "dry-run":      { type: "boolean", default: false },
      "project-root": { type: "string" },
      json:           { type: "boolean", default: runtime.json === true },
    },
    strict: false,
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  // Try better-core binary first
  const corePath = await findBetterCore();
  if (corePath) {
    const coreArgs = ["env", "generate", "--project-root", projectRoot];
    if (values.template)    coreArgs.push("--template", values.template);
    if (values.output)      coreArgs.push("--output", values.output);
    if (values["dry-run"])  coreArgs.push("--dry-run");
    if (values.json)        coreArgs.push("--json");
    const res = await runCommand(corePath, coreArgs, { passthroughStdio: !values.json });
    process.exitCode = res.exitCode ?? 0;
    if (values.json && res.stdout) {
      try { printJson(JSON.parse(res.stdout.trim())); } catch { printText(res.stdout.trim()); }
    }
    return;
  }

  // JS-native fallback
  const templatePath = values.template
    ? path.resolve(values.template)
    : path.join(projectRoot, ".env.osp");

  let templateContent;
  try {
    templateContent = await fs.readFile(templatePath, "utf8");
  } catch {
    const out = { ok: false, kind: "better.env.generate", error: `Template not found: ${templatePath}` };
    if (values.json) { printJson(out); } else { printText(`error: template file not found: ${templatePath}\nCreate a .env.osp file to get started.`); }
    process.exitCode = 1;
    return;
  }

  const entries = parseEnvTemplate(templateContent);
  const resolved = [];
  const unresolved = [];

  for (const entry of entries) {
    if (entry.kind !== "entry" || !entry.isOsp) continue;
    const value = await resolveOspUri(entry.ospUri);
    if (value !== null) {
      resolved.push({ key: entry.key, ospUri: entry.ospUri, resolvedValue: "***" });
    } else {
      unresolved.push({ key: entry.key, ospUri: entry.ospUri });
    }
    entry.resolvedValue = value;
  }

  // Build output .env content
  const outputLines = [];
  for (const entry of entries) {
    if (entry.kind === "comment") {
      outputLines.push(entry.raw);
      continue;
    }
    if (entry.isOsp) {
      const val = entry.resolvedValue;
      if (val !== null && val !== undefined) {
        outputLines.push(`${entry.key}=${val}`);
      } else {
        outputLines.push(`# UNRESOLVED: ${entry.key}=${entry.ospUri}`);
      }
    } else {
      outputLines.push(`${entry.key}=${entry.value}`);
    }
  }
  const outputContent = outputLines.join("\n") + "\n";

  if (values.json) {
    const out = {
      ok: unresolved.length === 0,
      kind: "better.env.generate",
      schemaVersion: 1,
      templatePath,
      outputPath: values["dry-run"] ? null : (values.output ? path.resolve(values.output) : path.join(projectRoot, ".env")),
      dryRun: values["dry-run"],
      resolved,
      unresolved,
      totalEntries: entries.filter(e => e.kind === "entry").length,
    };
    printJson(out);
    if (unresolved.length > 0) process.exitCode = 1;
    return;
  }

  if (values["dry-run"]) {
    printText(`--- Resolved .env preview ---\n${outputContent}\n---`);
    if (unresolved.length > 0) {
      printText(`\nUnresolved OSP credentials (${unresolved.length}):`);
      for (const u of unresolved) {
        printText(`  ${u.key}: ${u.ospUri}`);
      }
      printText(`\nRun: better provision <provider/service>  to provision missing services`);
      process.exitCode = 1;
    }
    return;
  }

  const outputPath = values.output
    ? path.resolve(values.output)
    : path.join(projectRoot, ".env");

  await fs.writeFile(outputPath, outputContent, "utf8");
  printText(`Generated ${outputPath} (${resolved.length} OSP credentials resolved, ${unresolved.length} unresolved)`);
  if (unresolved.length > 0) {
    for (const u of unresolved) printText(`  unresolved: ${u.key} = ${u.ospUri}`);
    process.exitCode = 1;
  }
}
