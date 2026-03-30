/**
 * better workspace-run — run commands across workspace packages
 *
 * Discovers workspaces from package.json and runs a script
 * or command in each one, with filtering and parallelization.
 *
 * Usage:
 *   better workspace-run test
 *   better workspace-run build --filter @myorg
 *   better workspace-run --parallel lint
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function discoverWorkspaces(projectRoot, pkgJson) {
  const workspacePatterns = pkgJson.workspaces;
  if (!workspacePatterns) return [];

  const patterns = Array.isArray(workspacePatterns)
    ? workspacePatterns
    : workspacePatterns.packages || [];

  const workspaces = [];

  for (const pattern of patterns) {
    // Expand glob patterns (handle packages/*)
    const isGlob = pattern.includes("*");
    if (isGlob) {
      const base = pattern.split("*")[0].replace(/\/$/, "");
      const baseDir = path.join(projectRoot, base);
      try {
        const entries = await fs.readdir(baseDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          const wsPath = path.join(baseDir, e.name);
          try {
            const wsPkg = JSON.parse(await fs.readFile(path.join(wsPath, "package.json"), "utf8"));
            workspaces.push({ name: wsPkg.name || e.name, path: wsPath, pkg: wsPkg });
          } catch {}
        }
      } catch {}
    } else {
      const wsPath = path.join(projectRoot, pattern);
      try {
        const wsPkg = JSON.parse(await fs.readFile(path.join(wsPath, "package.json"), "utf8"));
        workspaces.push({ name: wsPkg.name || pattern, path: wsPath, pkg: wsPkg });
      } catch {}
    }
  }

  return workspaces;
}

function runInWorkspace(wsPath, script, command, args) {
  return new Promise((resolve) => {
    let cmd, cmdArgs;

    if (script) {
      // Run as npm script
      cmd = "npm";
      cmdArgs = ["run", script, ...args];
    } else {
      // Run as raw command
      const parts = command.split(" ");
      cmd = parts[0];
      cmdArgs = [...parts.slice(1), ...args];
    }

    const child = spawn(cmd, cmdArgs, {
      cwd: wsPath,
      stdio: "pipe",
      shell: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", d => { stdout += d; });
    child.stderr?.on("data", d => { stderr += d; });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on("error", (err) => {
      resolve({ code: 1, stdout: "", stderr: err.message });
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      child.kill();
      resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]" });
    }, 120000);
  });
}

export async function cmdWorkspaceRun(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:      { type: "boolean", default: runtime.json === true },
      help:      { type: "boolean", short: "h", default: false },
      parallel:  { type: "boolean", default: false },
      filter:    { type: "string" },
      "if-present": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printText(`Usage: better workspace-run <script|command> [args...] [options]

Run a script or command in all workspace packages.

Options:
  --parallel     Run in all workspaces simultaneously
  --filter <q>   Only run in workspaces matching name/path
  --if-present   Skip workspaces that don't have the script
  --json         Machine-readable output
  -h, --help     Show this help

Examples:
  better workspace-run test
  better workspace-run build --parallel
  better workspace-run lint --filter @myorg
`);
    if (positionals.length === 0) process.exitCode = 1;
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

  if (!pkgJson.workspaces) {
    const msg = "No workspaces defined in package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    return;
  }

  const workspaces = await discoverWorkspaces(projectRoot, pkgJson);
  const script = positionals[0];
  const extraArgs = positionals.slice(1);

  // Filter workspaces
  let targets = workspaces;
  if (values.filter) {
    const filter = values.filter.toLowerCase();
    targets = workspaces.filter(ws =>
      ws.name.toLowerCase().includes(filter) ||
      ws.path.toLowerCase().includes(filter)
    );
  }

  // Filter by script presence if --if-present
  if (values["if-present"]) {
    targets = targets.filter(ws => Boolean(ws.pkg.scripts?.[script]));
  }

  if (targets.length === 0) {
    const msg = values.filter ? `No workspaces match filter "${values.filter}"` : "No workspaces found";
    if (values.json) { printJson({ ok: true, kind: "better.workspace-run", message: msg, ran: 0 }); }
    else { printText(`\x1b[90m${msg}\x1b[0m`); }
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter workspace-run ${script}\x1b[0m — ${targets.length} workspace(s)${values.parallel ? " (parallel)" : ""}\n`);
  }

  const results = [];

  if (values.parallel) {
    const promises = targets.map(ws => {
      const hasScript = Boolean(ws.pkg.scripts?.[script]);
      if (!hasScript && values["if-present"]) return Promise.resolve({ ws, code: 0, skipped: true });
      return runInWorkspace(ws.path, hasScript ? script : null, !hasScript ? script : null, extraArgs)
        .then(r => ({ ws, ...r }));
    });
    results.push(...await Promise.all(promises));
  } else {
    for (const ws of targets) {
      const hasScript = Boolean(ws.pkg.scripts?.[script]);
      if (!hasScript && values["if-present"]) {
        results.push({ ws, code: 0, skipped: true, stdout: "", stderr: "" });
        continue;
      }

      if (!values.json) {
        process.stderr.write(`\x1b[90m  Running in ${ws.name}…\x1b[0m\n`);
      }

      const result = await runInWorkspace(ws.path, hasScript ? script : null, !hasScript ? script : null, extraArgs);
      results.push({ ws, ...result });

      if (!values.json) {
        const icon = result.code === 0 ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
        printText(`  ${icon}  ${ws.name}`);
        if (result.code !== 0 && result.stderr) {
          printText(`\x1b[31m${result.stderr.trim().slice(0, 200)}\x1b[0m`);
        }
      }
    }
  }

  if (values.parallel && !values.json) {
    for (const r of results) {
      const icon = r.code === 0 ? "\x1b[32m✔\x1b[0m" : r.skipped ? "\x1b[90m·\x1b[0m" : "\x1b[31m✖\x1b[0m";
      printText(`  ${icon}  ${r.ws.name}`);
    }
  }

  const failed = results.filter(r => r.code !== 0 && !r.skipped);
  const allOk = failed.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.workspace-run",
      script,
      ran: results.filter(r => !r.skipped).length,
      skipped: results.filter(r => r.skipped).length,
      failed: failed.length,
      results: results.map(r => ({
        workspace: r.ws.name,
        code: r.code,
        skipped: r.skipped || false,
      })),
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText("");
  if (allOk) {
    printText(`\x1b[32m✔ Completed in ${results.length} workspace(s).\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ Failed in ${failed.length} workspace(s): ${failed.map(r => r.ws.name).join(", ")}\x1b[0m`);
    process.exitCode = 1;
  }
}
