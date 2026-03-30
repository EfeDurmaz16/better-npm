/**
 * better npm-run-order — show pre/post script execution order
 *
 * Displays the full execution order for npm scripts including
 * automatically prepended pre/post hooks, helping developers
 * understand what runs when they execute a script.
 *
 * Usage:
 *   better npm-run-order build
 *   better npm-run-order --all
 *   better npm-run-order --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function getExecutionChain(scripts, scriptName) {
  const chain = [];
  // npm lifecycle order: pre<name> → <name> → post<name>
  const pre = `pre${scriptName}`;
  const post = `post${scriptName}`;

  if (scripts[pre]) chain.push({ name: pre, script: scripts[pre], type: "pre" });
  if (scripts[scriptName]) chain.push({ name: scriptName, script: scripts[scriptName], type: "main" });
  if (scripts[post]) chain.push({ name: post, script: scripts[post], type: "post" });

  // Check if the script calls other scripts via npm run
  return chain;
}

function findNestedCalls(script) {
  const calls = [];
  const re = /\bnpm\s+run\s+([\w:-]+)/g;
  let m;
  while ((m = re.exec(script)) !== null) {
    calls.push(m[1]);
  }
  return calls;
}

export async function cmdNpmRunOrder(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      all:   { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better npm-run-order [<script>] [options]

Show npm script execution order including pre/post hooks.

Options:
  --all        Show order for all scripts
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better npm-run-order build
  better npm-run-order test
  better npm-run-order --all
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter npm-run-order\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const scripts = pkgJson.scripts || {};

  if (Object.keys(scripts).length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.npm-run-order", scripts: [] }); return; }
    printText(`  \x1b[90mNo scripts defined in package.json.\x1b[0m\n`);
    return;
  }

  let scriptsToShow = [];
  if (values.all) {
    // Show all user-visible scripts (not pre/post hooks)
    scriptsToShow = Object.keys(scripts).filter(s => !s.startsWith("pre") && !s.startsWith("post"));
  } else if (positionals.length > 0) {
    scriptsToShow = positionals;
  } else {
    // Default: show common scripts
    const COMMON = ["build", "test", "start", "dev", "lint", "typecheck", "prepare", "release"];
    scriptsToShow = COMMON.filter(s => scripts[s]);
    if (scriptsToShow.length === 0) scriptsToShow = Object.keys(scripts).slice(0, 5);
  }

  const result = [];

  for (const scriptName of scriptsToShow) {
    if (!scripts[scriptName]) {
      if (!values.json) printText(`  \x1b[33m⚠\x1b[0m  Script not found: ${scriptName}`);
      continue;
    }

    const chain = getExecutionChain(scripts, scriptName);

    // Detect nested npm run calls
    for (const step of chain) {
      step.calls = findNestedCalls(step.script);
    }

    result.push({ name: scriptName, chain });
  }

  if (values.json) {
    printJson({ ok: true, kind: "better.npm-run-order", scripts: result });
    return;
  }

  const TYPE_COLOR = { pre: "\x1b[90m", main: "\x1b[32m", post: "\x1b[90m" };

  for (const entry of result) {
    printText(`\x1b[1mnpm run ${entry.name}\x1b[0m`);
    if (entry.chain.length === 1 && entry.chain[0].type === "main" && entry.chain[0].calls.length === 0) {
      printText(`  \x1b[90m${entry.chain[0].script}\x1b[0m`);
    } else {
      for (let i = 0; i < entry.chain.length; i++) {
        const step = entry.chain[i];
        const isLast = i === entry.chain.length - 1;
        const connector = isLast ? "└──" : "├──";
        const color = TYPE_COLOR[step.type] || "\x1b[0m";
        const short = step.script.length > 60 ? step.script.slice(0, 60) + "..." : step.script;
        printText(`  ${connector} ${color}${step.name}\x1b[0m`);
        printText(`       \x1b[90m${short}\x1b[0m`);
        if (step.calls.length > 0) {
          printText(`       \x1b[90m→ calls: ${step.calls.join(", ")}\x1b[0m`);
        }
      }
    }
    printText("");
  }
}
