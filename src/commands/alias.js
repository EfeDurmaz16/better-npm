/**
 * better alias — manage custom command aliases
 *
 * Create, list, and run custom shortcuts for frequently used
 * better commands or npm scripts. Aliases are stored in the
 * project's package.json under "better.aliases".
 *
 * Usage:
 *   better alias list
 *   better alias add <name> <command>
 *   better alias remove <name>
 *   better alias run <name>
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function readAliases(pkgJsonPath) {
  try {
    const pkg = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
    return { pkg, aliases: pkg.better?.aliases || {} };
  } catch {
    return { pkg: null, aliases: {} };
  }
}

async function writeAliases(pkgJsonPath, pkg, aliases) {
  if (!pkg.better) pkg.better = {};
  pkg.better.aliases = aliases;
  await fs.writeFile(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

export async function cmdAlias(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better alias <subcommand> [args]

Manage custom better command aliases.

Subcommands:
  list                  List all defined aliases
  add <name> <cmd...>   Create a new alias
  remove <name>         Delete an alias
  run <name>            Execute an alias

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better alias add check "better health-score --json"
  better alias add fresh "better cleanup && npm install"
  better alias list
  better alias run check

Aliases are stored in package.json under "better.aliases".
`);
    return;
  }

  if (positionals.length === 0) {
    printText(`Usage: better alias <list|add|remove|run>\nRun: better alias --help for more info.`);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const pkgJsonPath = path.join(projectRoot, "package.json");

  const subcmd = positionals[0];
  const { pkg, aliases } = await readAliases(pkgJsonPath);

  if (!pkg && subcmd !== "list") {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  switch (subcmd) {
    case "list": {
      const entries = Object.entries(aliases);
      if (values.json) {
        printJson({ ok: true, kind: "better.alias.list", aliases });
        return;
      }
      printText(`\n\x1b[1mbetter alias list\x1b[0m\n`);
      if (entries.length === 0) {
        printText(`  \x1b[90mNo aliases defined.\x1b[0m`);
        printText(`  \x1b[90mAdd one: better alias add <name> <command>\x1b[0m`);
      } else {
        for (const [name, cmd] of entries) {
          printText(`  \x1b[1m${name.padEnd(20)}\x1b[0m  \x1b[90m${cmd}\x1b[0m`);
        }
      }
      printText("");
      break;
    }

    case "add": {
      if (positionals.length < 3) {
        const msg = "Usage: better alias add <name> <command...>";
        if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
        process.exitCode = 1;
        return;
      }
      const name = positionals[1];
      const cmd = positionals.slice(2).join(" ");
      const existing = aliases[name];
      aliases[name] = cmd;
      await writeAliases(pkgJsonPath, pkg, aliases);
      if (values.json) {
        printJson({ ok: true, kind: "better.alias.add", name, command: cmd, replaced: !!existing });
        return;
      }
      if (existing) {
        printText(`\x1b[33m⚠ Replaced alias "${name}"\x1b[0m`);
        printText(`  Old: \x1b[90m${existing}\x1b[0m`);
      } else {
        printText(`\x1b[32m✔ Alias "${name}" added\x1b[0m`);
      }
      printText(`  \x1b[90m${cmd}\x1b[0m`);
      break;
    }

    case "remove":
    case "rm":
    case "delete": {
      if (positionals.length < 2) {
        const msg = "Usage: better alias remove <name>";
        if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
        process.exitCode = 1;
        return;
      }
      const name = positionals[1];
      if (!aliases[name]) {
        const msg = `Alias "${name}" not found`;
        if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
        process.exitCode = 1;
        return;
      }
      delete aliases[name];
      await writeAliases(pkgJsonPath, pkg, aliases);
      if (values.json) { printJson({ ok: true, kind: "better.alias.remove", name }); return; }
      printText(`\x1b[32m✔ Alias "${name}" removed\x1b[0m`);
      break;
    }

    case "run":
    case "exec": {
      if (positionals.length < 2) {
        const msg = "Usage: better alias run <name>";
        if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
        process.exitCode = 1;
        return;
      }
      const name = positionals[1];
      const cmd = aliases[name];
      if (!cmd) {
        const msg = `Alias "${name}" not found`;
        if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
        process.exitCode = 1;
        return;
      }
      if (!values.json) {
        printText(`\x1b[90m▶ Running alias "${name}": ${cmd}\x1b[0m`);
      }
      await new Promise((resolve) => {
        const child = spawn(cmd, [], {
          shell: true,
          cwd: projectRoot,
          stdio: "inherit",
          env: { ...process.env },
        });
        child.on("close", (code) => {
          process.exitCode = code || 0;
          resolve();
        });
        child.on("error", (err) => {
          if (!values.json) printText(`\x1b[31mError: ${err.message}\x1b[0m`);
          process.exitCode = 1;
          resolve();
        });
      });
      break;
    }

    default: {
      const msg = `Unknown subcommand: ${subcmd}`;
      if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m\nRun: better alias --help`); }
      process.exitCode = 1;
    }
  }
}
