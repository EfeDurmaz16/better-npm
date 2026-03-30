/**
 * better env-validate — validate environment variables at runtime
 *
 * Checks that required environment variables are set, have the
 * correct types/formats, and optionally validates against a schema.
 * Reads schema from .env.schema.json or betterrc.
 *
 * Usage:
 *   better env-validate
 *   better env-validate --schema .env.schema.json
 *   better env-validate --required DATABASE_URL PORT
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const SCHEMA_PATHS = [
  ".env.schema.json",
  ".env.schema",
  "env.schema.json",
];

const TYPE_VALIDATORS = {
  string:  (v) => typeof v === "string",
  number:  (v) => !isNaN(Number(v)) && v.trim() !== "",
  boolean: (v) => ["true", "false", "1", "0", "yes", "no"].includes(v.toLowerCase()),
  url:     (v) => { try { new URL(v); return true; } catch { return false; } },
  port:    (v) => { const n = parseInt(v); return !isNaN(n) && n >= 1 && n <= 65535; },
  email:   (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  json:    (v) => { try { JSON.parse(v); return true; } catch { return false; } },
  uuid:    (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  semver:  (v) => /^\d+\.\d+\.\d+/.test(v),
};

function parseEnvFile(content) {
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    // Strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

async function loadSchema(projectRoot, schemaPath) {
  const searchPaths = schemaPath
    ? [schemaPath]
    : SCHEMA_PATHS.map(p => path.join(projectRoot, p));

  for (const sp of searchPaths) {
    try {
      const content = await fs.readFile(sp, "utf8");
      return { schema: JSON.parse(content), path: sp };
    } catch {}
  }
  return null;
}

export async function cmdEnvValidate(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      schema:   { type: "string" },
      required: { type: "boolean", default: false },
      env:      { type: "string", default: ".env" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better env-validate [VAR_NAMES...] [options]

Validate environment variables against a schema or required list.

Schema file (.env.schema.json) format:
  {
    "DATABASE_URL": { "type": "url", "required": true },
    "PORT":         { "type": "port", "default": "3000" },
    "NODE_ENV":     { "type": "string", "enum": ["development","production","test"] }
  }

Supported types: string, number, boolean, url, port, email, json, uuid, semver

Options:
  --schema <file>   Path to schema JSON file
  --env <file>      Env file to read (default: .env)
  --json            Machine-readable output
  -h, --help        Show this help

Examples:
  better env-validate
  better env-validate DATABASE_URL PORT NODE_ENV
  better env-validate --schema .env.schema.json
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  // Load .env file
  const envFilePath = path.isAbsolute(values.env) ? values.env : path.join(projectRoot, values.env);
  let fileEnv = {};
  try {
    const content = await fs.readFile(envFilePath, "utf8");
    fileEnv = parseEnvFile(content);
  } catch {}

  // Merge with process.env (process.env takes precedence)
  const env = { ...fileEnv, ...process.env };

  // Load schema
  const schemaResult = await loadSchema(projectRoot, values.schema);
  let schema = schemaResult?.schema || null;

  // If positionals provided, build a simple required schema from them
  if (positionals.length > 0 && !schema) {
    schema = {};
    for (const varName of positionals) {
      schema[varName] = { required: true };
    }
  }

  if (!schema) {
    const msg = "No schema found and no variables specified. Create .env.schema.json or pass variable names.";
    if (values.json) {
      printJson({ ok: false, kind: "better.env-validate", error: msg });
    } else {
      printText(`\n\x1b[1mbetter env-validate\x1b[0m\n\n\x1b[33m⚠ ${msg}\x1b[0m`);
      printText(`\n\x1b[90mCreate .env.schema.json:\x1b[0m`);
      printText(`\x1b[90m{\n  "DATABASE_URL": { "type": "url", "required": true },\n  "PORT": { "type": "port", "default": "3000" }\n}\x1b[0m`);
    }
    process.exitCode = 1;
    return;
  }

  const results = [];

  for (const [varName, spec] of Object.entries(schema)) {
    const value = env[varName];
    const isSet = value !== undefined && value !== "";
    const isRequired = spec.required !== false;

    if (!isSet) {
      if (isRequired) {
        results.push({
          name: varName,
          status: "missing",
          severity: "error",
          message: "Required but not set",
          default: spec.default ?? null,
        });
      } else if (spec.default !== undefined) {
        results.push({
          name: varName,
          status: "default",
          severity: "info",
          message: `Using default: ${spec.default}`,
        });
      }
      continue;
    }

    const errors = [];

    // Type check
    if (spec.type && TYPE_VALIDATORS[spec.type]) {
      if (!TYPE_VALIDATORS[spec.type](value)) {
        errors.push(`Expected type "${spec.type}", got "${value.slice(0, 30)}"`);
      }
    }

    // Enum check
    if (spec.enum && !spec.enum.includes(value)) {
      errors.push(`Must be one of: ${spec.enum.join(", ")}`);
    }

    // Min/max for numbers
    if (spec.min !== undefined && !isNaN(Number(value)) && Number(value) < spec.min) {
      errors.push(`Must be >= ${spec.min}`);
    }
    if (spec.max !== undefined && !isNaN(Number(value)) && Number(value) > spec.max) {
      errors.push(`Must be <= ${spec.max}`);
    }

    // Pattern check
    if (spec.pattern) {
      const re = new RegExp(spec.pattern);
      if (!re.test(value)) {
        errors.push(`Must match pattern: ${spec.pattern}`);
      }
    }

    if (errors.length > 0) {
      results.push({ name: varName, status: "invalid", severity: "error", message: errors.join("; "), value: value.slice(0, 50) });
    } else {
      results.push({ name: varName, status: "ok", severity: "info", message: "Valid" });
    }
  }

  const errors = results.filter(r => r.severity === "error");
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.env-validate",
      schemaPath: schemaResult?.path || null,
      envFile: envFilePath,
      results,
      errors: errors.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter env-validate\x1b[0m`);
  if (schemaResult) printText(`\x1b[90mSchema: ${path.relative(process.cwd(), schemaResult.path)}\x1b[0m`);
  printText(`\x1b[90mEnv file: ${path.relative(process.cwd(), envFilePath)}\x1b[0m\n`);

  for (const r of results) {
    if (r.status === "ok") {
      printText(`  \x1b[32m✔\x1b[0m  ${r.name}`);
    } else if (r.status === "missing") {
      printText(`  \x1b[31m✖\x1b[0m  ${r.name}  \x1b[31mmissing\x1b[0m${r.default ? `  \x1b[90m(default: ${r.default})\x1b[0m` : ""}`);
    } else if (r.status === "invalid") {
      printText(`  \x1b[31m✖\x1b[0m  ${r.name}  \x1b[31m${r.message}\x1b[0m`);
    } else if (r.status === "default") {
      printText(`  \x1b[90m·\x1b[0m  ${r.name}  \x1b[90m${r.message}\x1b[0m`);
    }
  }

  printText("");
  if (allOk) {
    printText(`\x1b[32m✔ All ${Object.keys(schema).length} variable(s) valid.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} validation error(s).\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
