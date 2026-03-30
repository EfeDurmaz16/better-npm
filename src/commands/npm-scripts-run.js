/**
 * better npm-scripts-run — run multiple npm scripts in sequence or parallel
 *
 * Executes multiple package.json scripts with better output,
 * timing, and error handling. Supports sequential and parallel modes.
 *
 * Usage:
 *   better npm-scripts-run lint test build
 *   better npm-scripts-run --parallel lint:js lint:css
 *   better npm-scripts-run --if-present test e2e
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function runScript(projectRoot, scriptName) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn("npm", ["run", scriptName], {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env },
    });

    child.on("close", (code) => {
      resolve({ script: scriptName, exitCode: code, elapsed: Date.now() - start });
    });

    child.on("error", (err) => {
      resolve({ script: scriptName, exitCode: 1, elapsed: Date.now() - start, error: err.message });
    });
  });
}

function fmtMs(ms) {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export async function cmdNpmScriptsRun(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:        { type: "boolean", default: runtime.json === true },
      help:        { type: "boolean", short: "h", default: false },
      parallel:    { type: "boolean", default: false },
      "if-present":{ type: "boolean", default: false },
      bail:        { type: "boolean", default: true },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better npm-scripts-run <script1> [script2...] [options]

Run multiple npm scripts with better output and timing.

Options:
  --parallel      Run all scripts simultaneously
  --if-present    Skip scripts that don't exist (no error)
  --no-bail       Continue even if a script fails
  --json          Machine-readable results
  -h, --help      Show this help

Examples:
  better npm-scripts-run lint test build
  better npm-scripts-run --parallel lint:js lint:css
  better npm-scripts-run --if-present typecheck test
`);
    return;
  }

  if (positionals.length === 0) {
    printText(`Usage: better npm-scripts-run <script1> [script2...] [options]\nRun: better npm-scripts-run --help for more info.`);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const scripts = pkgJson.scripts || {};

  // Filter scripts
  let targets = positionals;
  if (values["if-present"]) {
    targets = positionals.filter(s => !!scripts[s]);
    const skipped = positionals.filter(s => !scripts[s]);
    if (skipped.length > 0 && !values.json) {
      printText(`\x1b[90mSkipping (not present): ${skipped.join(", ")}\x1b[0m`);
    }
  } else {
    const missing = positionals.filter(s => !scripts[s]);
    if (missing.length > 0) {
      const msg = `Scripts not found: ${missing.join(", ")}`;
      if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
      process.exitCode = 1;
      return;
    }
  }

  if (targets.length === 0) {
    if (!values.json) printText(`\x1b[90mNo scripts to run.\x1b[0m`);
    return;
  }

  const totalStart = Date.now();
  const results = [];

  if (values.parallel) {
    if (!values.json) {
      printText(`\n\x1b[1mRunning ${targets.length} scripts in parallel:\x1b[0m ${targets.join(", ")}\n`);
    }
    const parallel = await Promise.all(targets.map(s => runScript(projectRoot, s)));
    results.push(...parallel);
  } else {
    if (!values.json) {
      printText(`\n\x1b[1mRunning ${targets.length} scripts:\x1b[0m ${targets.join(" → ")}\n`);
    }

    for (const scriptName of targets) {
      if (!values.json) {
        printText(`\x1b[90m▶ Running ${scriptName}…\x1b[0m`);
      }
      const result = await runScript(projectRoot, scriptName);
      results.push(result);

      if (result.exitCode !== 0 && values.bail !== false) {
        if (!values.json) {
          printText(`\n\x1b[31m✖ Script "${scriptName}" failed (exit code ${result.exitCode})\x1b[0m`);
        }
        break;
      }
    }
  }

  const totalElapsed = Date.now() - totalStart;
  const failed = results.filter(r => r.exitCode !== 0);
  const allOk = failed.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.npm-scripts-run",
      totalElapsed,
      results,
      failed: failed.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[90m${"─".repeat(40)}\x1b[0m`);
  for (const r of results) {
    const icon = r.exitCode === 0 ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    printText(`  ${icon}  ${r.script}  \x1b[90m${fmtMs(r.elapsed)}\x1b[0m`);
  }
  printText(`\n  Total: ${fmtMs(totalElapsed)}`);

  if (allOk) {
    printText(`\x1b[32m\n✔ All scripts passed.\x1b[0m`);
  } else {
    printText(`\x1b[31m\n✖ ${failed.length} script(s) failed: ${failed.map(r => r.script).join(", ")}\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
