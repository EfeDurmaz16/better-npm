/**
 * better workspace-run — run a script across all workspace packages
 *
 * Executes an npm script in all (or filtered) workspace packages,
 * in parallel or sequentially, with output aggregation.
 *
 * Usage:
 *   better workspace-run build
 *   better workspace-run test --filter @myorg/
 *   better workspace-run lint --parallel
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function findWorkspacePackages(projectRoot, workspaceGlobs) {
  const packages = [];
  for (const glob of workspaceGlobs) {
    const parts = glob.split("/");
    const baseDir = parts.slice(0, -1).join("/") || ".";
    const pattern = parts[parts.length - 1];
    const absBase = path.join(projectRoot, baseDir);
    try {
      const entries = await fs.readdir(absBase, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (pattern !== "*" && e.name !== pattern) continue;
        const pkgPath = path.join(absBase, e.name, "package.json");
        try {
          const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
          if (pkg.name) packages.push({ name: pkg.name, path: path.join(absBase, e.name), scripts: pkg.scripts || {} });
        } catch {}
      }
    } catch {}
  }
  return packages;
}

function runScript(pkgPath, script) {
  return new Promise((resolve) => {
    const proc = spawn("npm", ["run", script], {
      cwd: pkgPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; });
    proc.on("close", code => resolve({ ok: code === 0, exitCode: code, stdout, stderr }));
    proc.on("error", (e) => resolve({ ok: false, exitCode: -1, stdout, stderr: stderr + e.message }));
  });
}

export async function cmdWorkspaceRun(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      filter:     { type: "string" },
      parallel:   { type: "boolean", default: false },
      "bail":     { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better workspace-run <script> [options]

Run a script across all workspace packages.

Options:
  --filter <pat>   Only run in packages matching pattern
  --parallel       Run all packages in parallel
  --bail           Stop on first failure
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better workspace-run build
  better workspace-run test --parallel
  better workspace-run lint --filter @myorg/
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better workspace-run <script>\nRun: better workspace-run --help for more info.");
    process.exitCode = 1;
    return;
  }

  const scriptName = positionals[0];
  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let rootPkg = {};
  try { rootPkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces
    : Array.isArray(rootPkg.workspaces?.packages) ? rootPkg.workspaces.packages : [];

  if (workspaces.length === 0) {
    if (values.json) { printJson({ ok: false, error: "No workspaces found" }); return; }
    printText(`\x1b[33m⚠ No workspaces found. This command requires a monorepo.\x1b[0m\n`);
    process.exitCode = 1;
    return;
  }

  let packages = await findWorkspacePackages(projectRoot, workspaces);

  // Filter
  if (values.filter) {
    packages = packages.filter(p => p.name.includes(values.filter));
  }

  // Only packages that have the script
  const withScript = packages.filter(p => p.scripts[scriptName]);
  const withoutScript = packages.filter(p => !p.scripts[scriptName]);

  if (!values.json) {
    printText(`\n\x1b[1mbetter workspace-run\x1b[0m — ${scriptName}\n`);
    printText(`  Packages: ${withScript.length} have script, ${withoutScript.length} skip\n`);
  }

  if (withScript.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.workspace-run", script: scriptName, ran: 0, results: [] }); return; }
    printText(`  \x1b[90mNo packages have a "${scriptName}" script.\x1b[0m\n`);
    return;
  }

  const results = [];

  if (values.parallel) {
    const runs = await Promise.all(withScript.map(async (pkg) => {
      const result = await runScript(pkg.path, scriptName);
      return { package: pkg.name, ...result };
    }));
    results.push(...runs);
  } else {
    for (const pkg of withScript) {
      if (!values.json) process.stderr.write(`\x1b[90m  Running ${scriptName} in ${pkg.name}...\x1b[0m\n`);
      const result = await runScript(pkg.path, scriptName);
      results.push({ package: pkg.name, ...result });
      if (values.bail && !result.ok) break;
    }
  }

  const failed = results.filter(r => !r.ok);
  const ok = failed.length === 0;

  if (values.json) {
    printJson({ ok, kind: "better.workspace-run", script: scriptName, ran: results.length, failed: failed.length, results: results.map(r => ({ package: r.package, ok: r.ok, exitCode: r.exitCode })) });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const r of results) {
    const icon = r.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    printText(`  ${icon}  \x1b[1m${r.package}\x1b[0m`);
    if (!r.ok && r.stderr) {
      const errLines = r.stderr.trim().split("\n").slice(0, 3);
      for (const line of errLines) printText(`       \x1b[31m${line}\x1b[0m`);
    }
  }

  printText("");
  if (ok) {
    printText(`\x1b[32m✔ All ${results.length} packages completed successfully.\x1b[0m`);
  } else {
    printText(`\x1b[31m✘ ${failed.length}/${results.length} packages failed.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
