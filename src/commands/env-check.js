/**
 * better env-check — validate environment variables
 *
 * Compares current environment (or .env file) against .env.example / .env.schema
 * and reports missing, extra, or incorrectly typed variables.
 *
 * Usage:
 *   better env-check                 # validate .env vs .env.example
 *   better env-check --env .env.prod # check a specific env file
 *   better env-check --strict        # fail on any extra vars
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";

function parseEnvFile(content) {
  const vars = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    vars[key] = val;
  }
  return vars;
}

function parseSchemaComment(comment) {
  // Supports: # required, # optional, # type: url|email|number|boolean
  const meta = { required: false, type: null };
  if (!comment) return meta;
  if (/required/i.test(comment)) meta.required = true;
  const typeMatch = comment.match(/type:\s*(\w+)/i);
  if (typeMatch) meta.type = typeMatch[1].toLowerCase();
  return meta;
}

function validateValue(val, type) {
  if (!type || val === "") return null;
  switch (type) {
    case "url":
      try { new URL(val); return null; } catch { return `not a valid URL`; }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val) ? null : "not a valid email";
    case "number":
      return isNaN(Number(val)) ? "not a number" : null;
    case "boolean":
      return /^(true|false|1|0|yes|no)$/i.test(val) ? null : "not a boolean (expected true/false)";
    case "port":
      return /^\d+$/.test(val) && Number(val) > 0 && Number(val) < 65536 ? null : "not a valid port (1-65535)";
    default:
      return null;
  }
}

export async function cmdEnvCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      env: { type: "string", default: ".env" },
      example: { type: "string" },
      strict: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better env-check [options]

Validate environment variables against .env.example or .env.schema.

Options:
  --env <file>       Env file to validate (default: .env)
  --example <file>   Example/schema file (default: .env.example)
  --strict           Fail if extra variables are present
  --json             Machine-readable output
  -h, --help         Show this help

Schema annotations (add to .env.example comments):
  DATABASE_URL=      # required type:url
  PORT=3000          # type:port
  ENABLED=true       # type:boolean

Examples:
  better env-check
  better env-check --env .env.production
  better env-check --strict
`);
    return;
  }

  const cwd = process.cwd();
  const envPath = path.resolve(cwd, values.env);

  // Find example file
  const exampleCandidates = values.example
    ? [path.resolve(cwd, values.example)]
    : [
        path.join(cwd, ".env.example"),
        path.join(cwd, ".env.sample"),
        path.join(cwd, ".env.template"),
        path.join(cwd, ".env.schema"),
      ];

  let examplePath;
  let exampleContent = "";
  for (const candidate of exampleCandidates) {
    try {
      exampleContent = await fs.readFile(candidate, "utf8");
      examplePath = candidate;
      break;
    } catch {}
  }

  // Read current env file
  let envContent = "";
  let envExists = false;
  try {
    envContent = await fs.readFile(envPath, "utf8");
    envExists = true;
  } catch {}

  const current = parseEnvFile(envContent);

  if (!examplePath) {
    const msg = "No .env.example (or .env.sample/.env.template/.env.schema) found.";
    if (values.json) {
      printJson({ ok: true, kind: "better.env-check", warning: msg, checked: Object.keys(current).length });
    } else {
      printText(`\x1b[33mWarning:\x1b[0m ${msg}`);
      printText(`\x1b[90mCreate .env.example to document required variables.\x1b[0m`);
      if (Object.keys(current).length > 0) {
        printText(`\n\x1b[90mCurrent ${values.env} has ${Object.keys(current).length} variable(s).\x1b[0m`);
      }
    }
    return;
  }

  // Parse example with inline comments for schema
  const exampleVars = {};
  const schemaMeta = {};
  for (const line of exampleContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const commentIdx = trimmed.indexOf(" #");
    const commentPart = commentIdx >= 0 ? trimmed.slice(commentIdx + 2) : "";
    const defPart = commentIdx >= 0 ? trimmed.slice(0, commentIdx) : trimmed;
    const eq = defPart.indexOf("=");
    if (eq < 0) continue;
    const key = defPart.slice(0, eq).trim();
    const val = defPart.slice(eq + 1).trim();
    exampleVars[key] = val;
    schemaMeta[key] = parseSchemaComment(commentPart);
  }

  const missing = [];
  const typeErrors = [];
  const extra = [];

  // Check required and type validation
  for (const [key, meta] of Object.entries(schemaMeta)) {
    const val = current[key];
    if (val === undefined || val === "") {
      if (meta.required) missing.push({ key, reason: "required but not set" });
    } else if (meta.type) {
      const err = validateValue(val, meta.type);
      if (err) typeErrors.push({ key, value: val, expected_type: meta.type, error: err });
    }
  }

  // Missing from example (not marked required but present in example)
  for (const key of Object.keys(exampleVars)) {
    if (!(key in current) && !schemaMeta[key]?.required) {
      // Not strictly missing, just absent — note it separately
    }
  }

  // Extra vars (in .env but not in example)
  for (const key of Object.keys(current)) {
    if (!(key in exampleVars)) {
      extra.push(key);
    }
  }

  const missingFromExample = Object.keys(exampleVars).filter(k => !(k in current));

  const hasErrors = missing.length > 0 || typeErrors.length > 0 || (values.strict && extra.length > 0);

  if (values.json) {
    printJson({
      ok: !hasErrors,
      kind: "better.env-check",
      env_file: path.relative(cwd, envPath),
      example_file: path.relative(cwd, examplePath),
      env_exists: envExists,
      missing_required: missing,
      type_errors: typeErrors,
      missing_from_example: missingFromExample,
      extra_vars: extra,
      total_defined: Object.keys(current).length,
      total_expected: Object.keys(exampleVars).length,
    });
    if (hasErrors) process.exitCode = 1;
    return;
  }

  const relEnv = path.relative(cwd, envPath);
  const relExample = path.relative(cwd, examplePath);
  printText(`\nbetter env-check: ${relEnv} vs ${relExample}\n`);

  if (!envExists) {
    printText(`\x1b[31m✖ ${relEnv} does not exist\x1b[0m`);
    if (Object.keys(exampleVars).length > 0) {
      printText(`\x1b[90mCopy ${relExample} to ${relEnv} and fill in values.\x1b[0m`);
    }
    process.exitCode = 1;
    return;
  }

  if (missing.length > 0) {
    printText(`\x1b[31mMissing required variables (${missing.length}):\x1b[0m`);
    for (const m of missing) {
      printText(`  \x1b[31m✖\x1b[0m  ${m.key}`);
    }
  }

  if (typeErrors.length > 0) {
    printText(`\n\x1b[31mType validation errors (${typeErrors.length}):\x1b[0m`);
    for (const e of typeErrors) {
      printText(`  \x1b[31m✖\x1b[0m  ${e.key} = ${JSON.stringify(e.value)} — ${e.error}`);
    }
  }

  if (missingFromExample.length > 0) {
    printText(`\n\x1b[33mNot set (${missingFromExample.length} from example):\x1b[0m`);
    for (const k of missingFromExample.slice(0, 10)) {
      printText(`  \x1b[33m⚠\x1b[0m  ${k} \x1b[90m(example default: ${JSON.stringify(exampleVars[k] || "")})\x1b[0m`);
    }
    if (missingFromExample.length > 10) {
      printText(`  \x1b[90m...and ${missingFromExample.length - 10} more\x1b[0m`);
    }
  }

  if (extra.length > 0) {
    if (values.strict) {
      printText(`\n\x1b[31mExtra variables not in example (${extra.length}):\x1b[0m`);
    } else {
      printText(`\n\x1b[90mExtra variables not documented in example (${extra.length}):\x1b[0m`);
    }
    for (const k of extra.slice(0, 8)) {
      printText(`  ${values.strict ? "\x1b[31m✖\x1b[0m" : "\x1b[90m·\x1b[0m"}  ${k}`);
    }
    if (extra.length > 8) printText(`  \x1b[90m...and ${extra.length - 8} more\x1b[0m`);
  }

  if (!hasErrors && missing.length === 0 && typeErrors.length === 0) {
    printText(`\x1b[32m✔ Environment looks good\x1b[0m (${Object.keys(current).length} variables set)`);
  } else if (hasErrors) {
    process.exitCode = 1;
  }
}
