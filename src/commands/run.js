import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { runCommand } from "../lib/spawn.js";
import { printJson, printText } from "../lib/output.js";
import { detectPackageManager } from "../pm/detect.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function collectUnknownFlagArgs(values, knownKeys) {
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    if (knownKeys.has(key)) continue;
    if (value === false || value == null) continue;
    const prefix = key.length === 1 ? "-" : "--";
    if (value === true) {
      args.push(`${prefix}${key}`);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) args.push(`${prefix}${key}`, String(item));
      continue;
    }
    args.push(`${prefix}${key}`, String(value));
  }
  return args;
}

async function resolveRunProjectRoot(startDir, projectRootFlag) {
  if (projectRootFlag) {
    return { root: path.resolve(projectRootFlag), reason: "flag:--project-root" };
  }
  const cwd = path.resolve(startDir);
  if (await exists(path.join(cwd, "package.json"))) {
    return { root: cwd, reason: "found:cwd-package.json" };
  }
  return await resolveInstallProjectRoot(cwd);
}

function pmRunCommand(pm, scriptName, scriptArgs, ifPresent) {
  const args = ["run", scriptName];
  if (pm === "npm" && ifPresent) args.push("--if-present");
  if (scriptArgs.length > 0) args.push("--", ...scriptArgs);
  if (pm === "pnpm") return { cmd: "pnpm", args };
  if (pm === "yarn") return { cmd: "yarn", args };
  return { cmd: "npm", args };
}

export async function cmdRun(argv, opts = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better run <script> [--project-root PATH] [--pm auto|npm|pnpm|yarn] [--if-present] [--json] [-- <script args>]

Aliases:
  better lint [-- ...]
  better test [-- ...]
  better dev [-- ...]
  better build [-- ...]
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "run" });
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
      pm: { type: "string", default: "auto" },
      "if-present": { type: "boolean", default: false }
    },
    allowPositionals: true,
    strict: false
  });

  const knownOptionKeys = new Set(["json", "project-root", "pm", "if-present"]);
  const unknownArgs = collectUnknownFlagArgs(values, knownOptionKeys);
  const passIndex = positionals.indexOf("--");
  const positionalsBeforeDash = passIndex >= 0 ? positionals.slice(0, passIndex) : positionals;
  const scriptArgsAfterDash = passIndex >= 0 ? positionals.slice(passIndex + 1) : [];

  const scriptName = opts.aliasScript ?? positionalsBeforeDash[0];
  if (!scriptName) {
    throw new Error("better run requires a script name (e.g. better run lint).");
  }

  const positionalTail = opts.aliasScript ? positionalsBeforeDash : positionalsBeforeDash.slice(1);
  const scriptArgs = [...positionalTail, ...unknownArgs, ...scriptArgsAfterDash];

  const resolvedRoot = await resolveRunProjectRoot(process.cwd(), values["project-root"]);
  const projectRoot = resolvedRoot.root;
  const packageJson = await readJsonIfExists(path.join(projectRoot, "package.json"));
  if (!packageJson || typeof packageJson !== "object") {
    throw new Error(`No package.json found at project root: ${projectRoot}`);
  }
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const hasScript = Object.prototype.hasOwnProperty.call(scripts, scriptName);

  const detected = await detectPackageManager(projectRoot);
  const pm = values.pm === "auto" ? detected.pm : values.pm;
  if (pm !== "npm" && pm !== "pnpm" && pm !== "yarn") {
    throw new Error(`Unknown --pm '${pm}'. Expected npm|pnpm|yarn|auto.`);
  }

  if (!hasScript && !values["if-present"]) {
    const missing = {
      ok: false,
      kind: "better.run.report",
      schemaVersion: 1,
      reason: "script_missing",
      run: {
        script: scriptName,
        skipped: true
      },
      projectRoot,
      projectRootResolution: { root: projectRoot, reason: resolvedRoot.reason },
      pm: { name: pm, detected: detected.pm, reason: detected.reason }
    };
    if (values.json) printJson(missing);
    else printText(`better run: script '${scriptName}' not found in ${path.join(projectRoot, "package.json")}`);
    process.exitCode = 1;
    return;
  }

  if (!hasScript && values["if-present"]) {
    const skipped = {
      ok: true,
      kind: "better.run.report",
      schemaVersion: 1,
      run: {
        script: scriptName,
        skipped: true,
        reason: "if_present_missing"
      },
      projectRoot,
      projectRootResolution: { root: projectRoot, reason: resolvedRoot.reason },
      pm: { name: pm, detected: detected.pm, reason: detected.reason }
    };
    if (values.json) printJson(skipped);
    else printText(`better run: skipped '${scriptName}' (script missing, --if-present)`);
    return;
  }

  const command = pmRunCommand(pm, scriptName, scriptArgs, values["if-present"] === true);
  commandLogger.info("run.start", {
    script: scriptName,
    pm,
    projectRoot,
    projectRootReason: resolvedRoot.reason,
    args: scriptArgs
  });
  const result = await runCommand(command.cmd, command.args, {
    cwd: projectRoot,
    passthroughStdio: !values.json
  });

  const report = {
    ok: result.exitCode === 0,
    kind: "better.run.report",
    schemaVersion: 1,
    run: {
      script: scriptName,
      args: scriptArgs,
      skipped: false
    },
    projectRoot,
    projectRootResolution: { root: projectRoot, reason: resolvedRoot.reason },
    pm: { name: pm, detected: detected.pm, reason: detected.reason },
    command,
    execution: {
      wallTimeMs: result.wallTimeMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut
    },
    tails: values.json
      ? {
          stdoutTail: result.stdoutTail,
          stderrTail: result.stderrTail
        }
      : null
  };

  commandLogger.info("run.end", {
    script: scriptName,
    pm,
    projectRoot,
    wallTimeMs: result.wallTimeMs,
    exitCode: result.exitCode
  });

  if (values.json) {
    printJson(report);
  } else if (result.exitCode === 0) {
    printText(`better run (${pm}) '${scriptName}' in ${result.wallTimeMs} ms`);
  }

  if (result.exitCode !== 0) {
    process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1;
  }
}
