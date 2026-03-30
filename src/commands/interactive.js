/**
 * better interactive — interactive dependency manager
 *
 * Provides an interactive terminal interface for common dependency
 * management tasks: install, update, remove packages with a
 * readline-based UI.
 *
 * Usage:
 *   better interactive
 *   better interactive update
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function promptMenu(rl, title, options) {
  return new Promise(async (resolve) => {
    printText(`\n\x1b[1m${title}\x1b[0m\n`);
    options.forEach((opt, i) => {
      printText(`  \x1b[36m${i + 1}\x1b[0m) ${opt.label}`);
    });
    printText(`  \x1b[90m0) Exit\x1b[0m\n`);
    const answer = await ask(rl, "\x1b[90mChoose: \x1b[0m");
    const idx = parseInt(answer);
    if (idx === 0 || isNaN(idx)) {
      resolve(null);
    } else if (idx >= 1 && idx <= options.length) {
      resolve(options[idx - 1]);
    } else {
      resolve(null);
    }
  });
}

async function runInteractiveUpdate(rl, projectRoot, pkgJson) {
  printText(`\n\x1b[1mInteractive Update\x1b[0m — choose packages to update\n`);

  const prodDeps = Object.entries(pkgJson.dependencies || {});
  if (prodDeps.length === 0) {
    printText(`\x1b[90mNo production dependencies.\x1b[0m`);
    return;
  }

  printText(`Production dependencies:\n`);
  for (let i = 0; i < prodDeps.length; i++) {
    const [name, version] = prodDeps[i];
    printText(`  \x1b[36m${i + 1}\x1b[0m) ${name.padEnd(28)} ${version}`);
  }
  printText("");

  const answer = await ask(rl, "\x1b[90mEnter numbers (comma-separated) or 'all': \x1b[0m");
  let selected;
  if (answer.trim().toLowerCase() === "all") {
    selected = prodDeps;
  } else {
    const indices = answer.split(",").map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < prodDeps.length);
    selected = indices.map(i => prodDeps[i]);
  }

  if (selected.length === 0) {
    printText(`\x1b[90mNo packages selected.\x1b[0m`);
    return;
  }

  const type = await ask(rl, "\x1b[90mUpdate type (patch/minor/latest) [minor]: \x1b[0m") || "minor";

  printText(`\n\x1b[90mUpdating ${selected.length} package(s)…\x1b[0m`);
  const pkgNames = selected.map(([name]) => name + (type === "latest" ? "@latest" : ""));

  const result = spawnSync("npm", ["install", ...pkgNames], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.status === 0) {
    printText(`\n\x1b[32m✔ Updated ${selected.length} package(s).\x1b[0m`);
  } else {
    printText(`\n\x1b[31m✖ Update failed.\x1b[0m`);
  }
}

async function runInteractiveInstall(rl, projectRoot) {
  const pkg = await ask(rl, "\x1b[90mPackage to install (e.g. lodash or lodash@4): \x1b[0m");
  if (!pkg.trim()) return;

  const type = await ask(rl, "\x1b[90mDependency type (prod/dev/peer/optional) [prod]: \x1b[0m") || "prod";
  const flag = { prod: "", dev: "--save-dev", peer: "--save-peer", optional: "--save-optional" }[type] || "";

  const args = ["install", pkg.trim()];
  if (flag) args.push(flag);

  printText(`\x1b[90mRunning: npm ${args.join(" ")}…\x1b[0m`);
  const result = spawnSync("npm", args, { cwd: projectRoot, stdio: "inherit" });

  if (result.status === 0) {
    printText(`\n\x1b[32m✔ Installed ${pkg}.\x1b[0m`);
  } else {
    printText(`\n\x1b[31m✖ Install failed.\x1b[0m`);
  }
}

async function runInteractiveRemove(rl, projectRoot, pkgJson) {
  const allDeps = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });
  if (allDeps.length === 0) {
    printText(`\x1b[90mNo dependencies to remove.\x1b[0m`);
    return;
  }

  printText(`\nDependencies:\n`);
  for (let i = 0; i < allDeps.length; i++) {
    printText(`  \x1b[36m${i + 1}\x1b[0m) ${allDeps[i]}`);
  }

  const answer = await ask(rl, "\x1b[90mEnter numbers to remove (comma-separated): \x1b[0m");
  const indices = answer.split(",").map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < allDeps.length);
  const toRemove = indices.map(i => allDeps[i]);

  if (toRemove.length === 0) return;

  const confirm = await ask(rl, `\x1b[33mRemove ${toRemove.join(", ")}? (y/N): \x1b[0m`);
  if (confirm.toLowerCase() !== "y") {
    printText(`\x1b[90mCancelled.\x1b[0m`);
    return;
  }

  const result = spawnSync("npm", ["uninstall", ...toRemove], { cwd: projectRoot, stdio: "inherit" });
  if (result.status === 0) {
    printText(`\n\x1b[32m✔ Removed ${toRemove.length} package(s).\x1b[0m`);
  }
}

export async function cmdInteractive(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: false },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better interactive [options]

Interactive terminal UI for dependency management.

Options:
  -h, --help   Show this help
`);
    return;
  }

  if (!process.stdin.isTTY) {
    printText(`\x1b[31mInteractive mode requires a terminal (TTY).\x1b[0m`);
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
    printText(`\x1b[31mError: Cannot read package.json\x1b[0m`);
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("close", () => process.exit(0));

  const name = pkgJson.name || path.basename(projectRoot);
  const prodCount = Object.keys(pkgJson.dependencies || {}).length;
  const devCount = Object.keys(pkgJson.devDependencies || {}).length;

  printText(`\n\x1b[1mbetter interactive\x1b[0m — ${name} (${prodCount} prod, ${devCount} dev)`);

  const MENU = [
    { label: "Install a package", action: "install" },
    { label: "Update packages", action: "update" },
    { label: "Remove packages", action: "remove" },
    { label: "Run a script", action: "run" },
    { label: "Show project summary", action: "summary" },
  ];

  while (true) {
    const choice = await promptMenu(rl, "What would you like to do?", MENU);
    if (!choice) break;

    switch (choice.action) {
      case "install":
        await runInteractiveInstall(rl, projectRoot);
        // Reload pkgJson
        try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}
        break;
      case "update":
        await runInteractiveUpdate(rl, projectRoot, pkgJson);
        break;
      case "remove":
        await runInteractiveRemove(rl, projectRoot, pkgJson);
        try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}
        break;
      case "run": {
        const scripts = Object.keys(pkgJson.scripts || {});
        if (scripts.length === 0) {
          printText(`\x1b[90mNo scripts defined.\x1b[0m`);
        } else {
          const scriptOpts = scripts.map(s => ({ label: s, name: s }));
          const sc = await promptMenu(rl, "Run script:", scriptOpts);
          if (sc) {
            spawnSync("npm", ["run", sc.name], { cwd: projectRoot, stdio: "inherit" });
          }
        }
        break;
      }
      case "summary": {
        const { spawnSync: ss } = await import("node:child_process");
        ss("node", [path.resolve(process.cwd(), "bin/better.js"), "summarize"], {
          cwd: projectRoot, stdio: "inherit",
        });
        break;
      }
    }
  }

  rl.close();
  printText(`\n\x1b[90mGoodbye!\x1b[0m`);
}
