/**
 * better hooks — manage git hooks setup
 *
 * Detects and manages git hooks configuration via husky, lefthook,
 * simple-git-hooks, or native git hooks. Shows status, installs
 * missing hooks, and validates hook scripts.
 *
 * Usage:
 *   better hooks
 *   better hooks install
 *   better hooks list
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const STANDARD_HOOKS = [
  "pre-commit",
  "commit-msg",
  "pre-push",
  "post-merge",
  "prepare-commit-msg",
];

async function detectHookManager(projectRoot, pkgJson) {
  const deps = { ...pkgJson.devDependencies, ...pkgJson.dependencies };

  if (deps.husky) return { manager: "husky", version: deps.husky };
  if (deps.lefthook) return { manager: "lefthook", version: deps.lefthook };
  if (deps["simple-git-hooks"]) return { manager: "simple-git-hooks", version: deps["simple-git-hooks"] };
  if (deps["lint-staged"] && !deps.husky) return { manager: "lint-staged-only", version: deps["lint-staged"] };

  // Check if husky is installed even if not in deps
  try {
    await fs.access(path.join(projectRoot, ".husky"));
    return { manager: "husky", version: "detected" };
  } catch {}

  try {
    await fs.access(path.join(projectRoot, "lefthook.yml"));
    return { manager: "lefthook", version: "detected" };
  } catch {}

  return { manager: "none", version: null };
}

async function getHooksStatus(projectRoot) {
  const gitHooksDir = path.join(projectRoot, ".git", "hooks");
  const huskyDir = path.join(projectRoot, ".husky");

  const hooks = [];

  // Check .git/hooks
  let gitHooks = [];
  try {
    const entries = await fs.readdir(gitHooksDir);
    gitHooks = entries.filter(e => !e.endsWith(".sample"));
  } catch {}

  // Check .husky dir
  let huskyHooks = [];
  try {
    const entries = await fs.readdir(huskyDir);
    huskyHooks = entries.filter(e => !e.startsWith(".") && !e.endsWith(".sh"));
  } catch {}

  for (const hookName of STANDARD_HOOKS) {
    const inGit = gitHooks.includes(hookName);
    const inHusky = huskyHooks.includes(hookName);
    let script = null;

    if (inHusky) {
      try {
        script = await fs.readFile(path.join(huskyDir, hookName), "utf8");
      } catch {}
    } else if (inGit) {
      try {
        script = await fs.readFile(path.join(gitHooksDir, hookName), "utf8");
      } catch {}
    }

    hooks.push({
      name: hookName,
      installed: inGit || inHusky,
      source: inHusky ? "husky" : inGit ? "git" : null,
      script: script?.trim()?.slice(0, 100),
    });
  }

  return hooks;
}

export async function cmdHooks(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better hooks [subcommand] [options]

Manage git hooks configuration.

Subcommands:
  (none)     Show hooks status
  list       List all installed hooks
  install    Install/re-install hooks (husky/lefthook)

Options:
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch { pkgJson = {}; }

  const sub = positionals[0] || "status";

  const hookManager = await detectHookManager(projectRoot, pkgJson);
  const hooks = await getHooksStatus(projectRoot);

  if (sub === "install") {
    if (!values.json) {
      if (hookManager.manager === "husky") {
        printText(`\x1b[90mRunning husky install…\x1b[0m`);
        const result = spawnSync("npx", ["husky", "install"], { cwd: projectRoot, stdio: "inherit" });
        if (result.status === 0) {
          printText(`\x1b[32m✔ Husky installed.\x1b[0m`);
        } else {
          printText(`\x1b[31m✖ Husky install failed.\x1b[0m`);
          process.exitCode = 1;
        }
      } else if (hookManager.manager === "lefthook") {
        const result = spawnSync("npx", ["lefthook", "install"], { cwd: projectRoot, stdio: "inherit" });
        if (result.status !== 0) process.exitCode = 1;
      } else {
        printText(`\x1b[33m⚠ No supported hook manager detected (husky/lefthook).\x1b[0m`);
        printText(`\x1b[90mInstall husky: npm install -D husky && npx husky install\x1b[0m`);
      }
    }
    return;
  }

  const installed = hooks.filter(h => h.installed);
  const missing = hooks.filter(h => !h.installed);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.hooks",
      manager: hookManager.manager,
      installed: installed.length,
      missing: missing.map(h => h.name),
      hooks,
    });
    return;
  }

  printText(`\n\x1b[1mbetter hooks\x1b[0m — manager: ${hookManager.manager}\n`);

  for (const hook of hooks) {
    const icon = hook.installed ? "\x1b[32m✔\x1b[0m" : "\x1b[90m·\x1b[0m";
    const src = hook.source ? `\x1b[90m(${hook.source})\x1b[0m` : "";
    printText(`  ${icon}  ${hook.name.padEnd(25)} ${src}`);
    if (hook.script) {
      const preview = hook.script.split("\n").filter(l => l && !l.startsWith("#")).slice(0, 1).join("");
      if (preview) printText(`       \x1b[90m${preview.slice(0, 60)}\x1b[0m`);
    }
  }

  printText("");
  if (hookManager.manager === "none") {
    printText(`\x1b[33m⚠ No git hook manager detected.\x1b[0m`);
    printText(`\x1b[90mConsider: npm install -D husky && npx husky install\x1b[0m`);
  } else {
    printText(`\x1b[32m${installed.length}\x1b[0m hook(s) active via \x1b[1m${hookManager.manager}\x1b[0m`);
  }

  // Check if prepare script is set (needed for husky auto-install)
  if (hookManager.manager === "husky" && !pkgJson.scripts?.prepare) {
    printText(`\n\x1b[33m⚠ Missing "prepare" script — husky won't auto-install on npm install\x1b[0m`);
    printText(`\x1b[90mAdd to package.json: "prepare": "husky install"\x1b[0m`);
  }
}
