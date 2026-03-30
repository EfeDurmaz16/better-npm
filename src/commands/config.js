import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { join } from "node:path";
import fs from "node:fs/promises";

const CONFIG_FILE = join(process.env.HOME || "/tmp", ".better", "config.json");

/**
 * `better config` — view and manage better configuration
 *
 * Subcommands:
 *   list              Show all configuration values
 *   get <key>         Get a specific value
 *   set <key> <val>   Set a value
 *   unset <key>       Remove a value
 *   edit              Open config in editor
 *   init              Create default config
 */
export async function cmdConfig(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    printText(`Usage: better config <subcommand> [options]

View and manage better configuration.

Subcommands:
  list              Show all configuration
  get <key>         Get a specific value
  set <key> <val>   Set a configuration value
  unset <key>       Remove a configuration value
  init              Create default configuration file

Configuration keys:
  json              Always output JSON (true/false)
  log-level         debug|info|warn|error|silent
  cache-root        Path to better cache directory
  registry          Default npm registry URL
  auto-install      Auto-install on package.json change (true/false)
  telemetry         Enable anonymous telemetry (true/false)

Config file location: ${CONFIG_FILE}

Options:
  --json           Machine-readable output
  -h, --help       Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      global: { type: "boolean", default: true },
    },
    allowPositionals: true,
    strict: false,
  });

  const useJson = values.json;
  const sub = positionals[0];

  let config = {};
  try {
    config = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  } catch { /* no config yet */ }

  switch (sub) {
    case "list": {
      if (useJson) {
        printJson({ ok: true, kind: "better.config.list", config });
      } else {
        if (Object.keys(config).length === 0) {
          printText("No configuration set. Run 'better config init' to create defaults.");
        } else {
          printText("better configuration:");
          for (const [key, val] of Object.entries(config)) {
            printText(`  ${key} = ${JSON.stringify(val)}`);
          }
          printText(`\nConfig file: ${CONFIG_FILE}`);
        }
      }
      break;
    }

    case "get": {
      const key = positionals[1];
      if (!key) {
        if (useJson) { printJson({ ok: false, error: "Key required" }); } else { printText("Error: key required"); }
        process.exitCode = 1;
        return;
      }
      const val = config[key];
      if (useJson) {
        printJson({ ok: true, kind: "better.config.get", key, value: val !== undefined ? val : null, exists: val !== undefined });
      } else {
        if (val !== undefined) { printText(`${key} = ${JSON.stringify(val)}`); }
        else { printText(`${key} is not set`); process.exitCode = 1; }
      }
      break;
    }

    case "set": {
      const key = positionals[1];
      const rawVal = positionals[2];
      if (!key || rawVal === undefined) {
        if (useJson) { printJson({ ok: false, error: "Usage: better config set <key> <value>" }); }
        else { printText("Usage: better config set <key> <value>"); }
        process.exitCode = 1;
        return;
      }

      // Parse value: booleans, numbers, or strings
      let val;
      if (rawVal === "true") val = true;
      else if (rawVal === "false") val = false;
      else if (/^\d+$/.test(rawVal)) val = parseInt(rawVal);
      else val = rawVal;

      config[key] = val;
      await saveConfig(config);
      if (useJson) { printJson({ ok: true, kind: "better.config.set", key, value: val }); }
      else { printText(`Set ${key} = ${JSON.stringify(val)}`); }
      break;
    }

    case "unset": {
      const key = positionals[1];
      if (!key) {
        if (useJson) { printJson({ ok: false, error: "Key required" }); } else { printText("Error: key required"); }
        process.exitCode = 1;
        return;
      }
      const existed = key in config;
      delete config[key];
      await saveConfig(config);
      if (useJson) { printJson({ ok: true, kind: "better.config.unset", key, existed }); }
      else { printText(existed ? `Unset ${key}` : `${key} was not set`); }
      break;
    }

    case "init": {
      if (Object.keys(config).length > 0) {
        if (!useJson) printText("Config already exists. Use 'better config set' to modify values.");
      } else {
        const defaults = {
          json: false,
          "log-level": "info",
          "auto-install": false,
          telemetry: false,
        };
        await saveConfig(defaults);
        if (useJson) { printJson({ ok: true, kind: "better.config.init", config: defaults }); }
        else { printText(`Created default config at ${CONFIG_FILE}`); }
      }
      break;
    }

    default: {
      printText(`Unknown subcommand: ${sub}. Run 'better config --help' for usage.`);
      process.exitCode = 1;
    }
  }
}

async function saveConfig(config) {
  await fs.mkdir(join(process.env.HOME || "/tmp", ".better"), { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}
