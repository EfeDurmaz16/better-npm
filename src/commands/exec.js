/**
 * better exec — run a command using locally installed binaries
 *
 * Like npx but for already-installed packages. Runs a command
 * using the project's local node_modules/.bin, with helpful
 * diagnostics if the binary isn't found.
 *
 * Usage:
 *   better exec jest --watch
 *   better exec tsc --noEmit
 *   better exec -- eslint src/
 */
import { parseArgs } from "node:util";
import { printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function findBinary(nmPath, name) {
  const binPath = path.join(nmPath, ".bin", name);
  try {
    await fs.access(binPath);
    return binPath;
  } catch {}

  // Try with .cmd extension on Windows
  if (process.platform === "win32") {
    const cmdPath = binPath + ".cmd";
    try {
      await fs.access(cmdPath);
      return cmdPath;
    } catch {}
  }

  return null;
}

async function findSimilarBinaries(nmPath, name) {
  try {
    const entries = await fs.readdir(path.join(nmPath, ".bin"));
    return entries
      .filter(e => e.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(e.toLowerCase().slice(0, 3)))
      .slice(0, 5);
  } catch { return []; }
}

export async function cmdExec(argv) {
  getRuntimeConfig();

  // Find the -- separator or first non-option arg
  let binName = null;
  let binArgs = [];

  const ddIdx = argv.indexOf("--");
  if (ddIdx !== -1) {
    binName = argv[ddIdx + 1];
    binArgs = argv.slice(ddIdx + 2);
  } else if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage: better exec <binary> [args...]

Run a command using locally installed node_modules/.bin binaries.

Options:
  -h, --help   Show this help

Examples:
  better exec jest --watch
  better exec tsc --noEmit
  better exec -- eslint src/ --fix
  better exec vitest run
`);
    return;
  } else {
    // Find first non-flag argument
    for (let i = 0; i < argv.length; i++) {
      if (!argv[i].startsWith("-")) {
        binName = argv[i];
        binArgs = argv.slice(i + 1);
        break;
      }
    }
  }

  if (!binName) {
    printText(`Usage: better exec <binary> [args...]\nRun with --help for details.`);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  const binPath = await findBinary(nmPath, binName);

  if (!binPath) {
    process.stderr.write(`\x1b[31mError: Binary "${binName}" not found in node_modules/.bin\x1b[0m\n`);

    const similar = await findSimilarBinaries(nmPath, binName);
    if (similar.length > 0) {
      process.stderr.write(`\x1b[90mDid you mean: ${similar.join(", ")}?\x1b[0m\n`);
    }

    // Check if it exists as a global
    const { spawnSync } = await import("node:child_process");
    const whichResult = spawnSync("which", [binName], { encoding: "utf8" });
    if (whichResult.status === 0 && whichResult.stdout.trim()) {
      process.stderr.write(`\x1b[90mFound globally at: ${whichResult.stdout.trim()}\x1b[0m\n`);
      process.stderr.write(`\x1b[90mIf needed, install locally: npm install --save-dev ${binName}\x1b[0m\n`);
    } else {
      process.stderr.write(`\x1b[90mInstall with: npm install --save-dev ${binName}\x1b[0m\n`);
    }

    process.exitCode = 1;
    return;
  }

  // Run the binary
  const child = spawn(binPath, binArgs, {
    stdio: "inherit",
    cwd,
    env: {
      ...process.env,
      PATH: `${path.join(nmPath, ".bin")}${path.delimiter}${process.env.PATH}`,
    },
  });

  child.on("close", (code) => {
    if (code !== null) process.exitCode = code;
  });

  child.on("error", (err) => {
    process.stderr.write(`\x1b[31mFailed to run "${binName}": ${err.message}\x1b[0m\n`);
    process.exitCode = 1;
  });

  await new Promise((resolve) => child.on("close", resolve));
}
