/**
 * better env-diff — compare two .env files
 *
 * Shows added, removed, and changed variables between two
 * environment files. Useful for comparing .env vs .env.production,
 * or checking what changed between environments.
 *
 * Usage:
 *   better env-diff .env .env.production
 *   better env-diff .env.example .env
 *   better env-diff --json .env.staging .env.production
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parseEnvFile(content) {
  const vars = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const rawValue = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    let value = rawValue;
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function maskValue(val) {
  if (!val) return "(empty)";
  // Mask likely secrets — show first 3 chars + ***
  const lower = val.toLowerCase();
  if (lower.includes("key") || lower.includes("secret") || lower.includes("token") ||
      lower.includes("password") || lower.includes("pass") || val.length > 20) {
    return val.slice(0, 3) + "***";
  }
  return val;
}

export async function cmdEnvDiff(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      "no-mask":{ type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length < 2) {
    printText(`Usage: better env-diff <file1> <file2> [options]

Compare two .env files and show differences.

Options:
  --no-mask    Show actual values (default: mask sensitive values)
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better env-diff .env .env.production
  better env-diff .env.example .env
`);
    if (positionals.length < 2) process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const file1Path = path.resolve(projectRoot, positionals[0]);
  const file2Path = path.resolve(projectRoot, positionals[1]);

  let content1, content2;
  try {
    content1 = await fs.readFile(file1Path, "utf8");
  } catch {
    const msg = `Cannot read ${positionals[0]}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }
  try {
    content2 = await fs.readFile(file2Path, "utf8");
  } catch {
    const msg = `Cannot read ${positionals[1]}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const vars1 = parseEnvFile(content1);
  const vars2 = parseEnvFile(content2);

  const keys1 = new Set(Object.keys(vars1));
  const keys2 = new Set(Object.keys(vars2));
  const allKeys = new Set([...keys1, ...keys2]);

  const added = [];      // in file2, not in file1
  const removed = [];    // in file1, not in file2
  const changed = [];    // in both, value differs
  const same = [];       // in both, same value

  for (const key of allKeys) {
    if (keys1.has(key) && !keys2.has(key)) {
      removed.push({ key, value: vars1[key] });
    } else if (!keys1.has(key) && keys2.has(key)) {
      added.push({ key, value: vars2[key] });
    } else if (vars1[key] !== vars2[key]) {
      changed.push({ key, from: vars1[key], to: vars2[key] });
    } else {
      same.push(key);
    }
  }

  const hasDiff = added.length > 0 || removed.length > 0 || changed.length > 0;

  if (values.json) {
    const mask = !values["no-mask"];
    printJson({
      ok: true,
      kind: "better.env-diff",
      file1: positionals[0],
      file2: positionals[1],
      identical: !hasDiff,
      added: added.map(e => ({ key: e.key, value: mask ? maskValue(e.value) : e.value })),
      removed: removed.map(e => ({ key: e.key, value: mask ? maskValue(e.value) : e.value })),
      changed: changed.map(e => ({
        key: e.key,
        from: mask ? maskValue(e.from) : e.from,
        to: mask ? maskValue(e.to) : e.to,
      })),
      same: same.length,
    });
    return;
  }

  const rel1 = path.relative(process.cwd(), file1Path);
  const rel2 = path.relative(process.cwd(), file2Path);

  printText(`\n\x1b[1mbetter env-diff\x1b[0m  ${rel1}  →  ${rel2}\n`);

  if (!hasDiff) {
    printText(`\x1b[32m✔ Files are identical (${same.length} variables)\x1b[0m`);
    return;
  }

  const mask = !values["no-mask"];

  if (removed.length > 0) {
    printText(`\x1b[31m${removed.length} variable(s) only in ${rel1}:\x1b[0m`);
    for (const e of removed) {
      const val = mask ? maskValue(e.value) : e.value;
      printText(`  \x1b[31m- ${e.key}\x1b[0m\x1b[90m=${val}\x1b[0m`);
    }
    printText("");
  }

  if (added.length > 0) {
    printText(`\x1b[32m${added.length} variable(s) only in ${rel2}:\x1b[0m`);
    for (const e of added) {
      const val = mask ? maskValue(e.value) : e.value;
      printText(`  \x1b[32m+ ${e.key}\x1b[0m\x1b[90m=${val}\x1b[0m`);
    }
    printText("");
  }

  if (changed.length > 0) {
    printText(`\x1b[33m${changed.length} variable(s) with different values:\x1b[0m`);
    for (const e of changed) {
      const from = mask ? maskValue(e.from) : e.from;
      const to = mask ? maskValue(e.to) : e.to;
      printText(`  \x1b[33m~ ${e.key}\x1b[0m`);
      printText(`    \x1b[31m- ${from}\x1b[0m`);
      printText(`    \x1b[32m+ ${to}\x1b[0m`);
    }
    printText("");
  }

  printText(`\x1b[90m${same.length} variable(s) unchanged\x1b[0m`);
}
