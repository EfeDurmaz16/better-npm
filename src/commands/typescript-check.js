/**
 * better typescript-check — run TypeScript type checking without emitting files
 *
 * Runs tsc --noEmit with smart defaults, shows errors with context,
 * and supports project references and composite projects.
 *
 * Usage:
 *   better typescript-check
 *   better typescript-check --strict
 *   better typescript-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parseTscOutput(output) {
  const lines = output.split("\n").filter(Boolean);
  const errors = [];
  const errorRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

  for (const line of lines) {
    const m = line.match(errorRe);
    if (m) {
      errors.push({
        file: m[1],
        line: parseInt(m[2]),
        col: parseInt(m[3]),
        severity: m[4],
        code: m[5],
        message: m[6],
      });
    }
  }

  return errors;
}

export async function cmdTypescriptCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      strict:     { type: "boolean", default: false },
      config:     { type: "string" },
      "no-emit":  { type: "boolean", default: true },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better typescript-check [options]

Run TypeScript type checking (tsc --noEmit).

Options:
  --strict          Enable strict mode (--strict flag)
  --config <file>   Use specific tsconfig file
  --json            Machine-readable output
  -h, --help        Show this help

Examples:
  better typescript-check
  better typescript-check --strict
  better typescript-check --config tsconfig.build.json
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  // Find tsc
  const tscPath = path.join(projectRoot, "node_modules", ".bin", "tsc");
  try {
    await fs.access(tscPath);
  } catch {
    const msg = "TypeScript (tsc) not found. Install with: npm install --save-dev typescript";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  // Find tsconfig
  const configFile = values.config || "tsconfig.json";
  const configPath = path.isAbsolute(configFile) ? configFile : path.join(projectRoot, configFile);
  try {
    await fs.access(configPath);
  } catch {
    const msg = `${configFile} not found`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mRunning tsc --noEmit…\x1b[0m\n`);
  }

  const tscArgs = ["--noEmit", "--pretty", "false"];
  if (values.config) tscArgs.push("--project", configFile);
  if (values.strict) tscArgs.push("--strict");

  const result = spawnSync(tscPath, tscArgs, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rawOutput = (result.stdout || "") + (result.stderr || "");
  const errors = parseTscOutput(rawOutput);
  const passed = result.status === 0;

  if (values.json) {
    printJson({
      ok: passed,
      kind: "better.typescript-check",
      errorCount: errors.length,
      errors,
    });
    if (!passed) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter typescript-check\x1b[0m\n`);

  if (passed) {
    printText(`\x1b[32m✔ No TypeScript errors found.\x1b[0m\n`);
    return;
  }

  // Group by file
  const byFile = new Map();
  for (const e of errors) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }

  for (const [file, fileErrors] of byFile) {
    const relFile = path.relative(projectRoot, file);
    printText(`  \x1b[1m${relFile}\x1b[0m`);
    for (const e of fileErrors.slice(0, 5)) {
      printText(`    \x1b[31m${e.code}\x1b[0m  line ${e.line}:${e.col}  ${e.message}`);
    }
    if (fileErrors.length > 5) {
      printText(`    \x1b[90m... and ${fileErrors.length - 5} more errors\x1b[0m`);
    }
  }

  printText(`\n\x1b[31m✖ ${errors.length} TypeScript error(s) in ${byFile.size} file(s).\x1b[0m\n`);
  process.exitCode = 1;
}
