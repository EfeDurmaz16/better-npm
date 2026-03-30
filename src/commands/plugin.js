import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs/promises";

/**
 * `better plugin` — manage third-party PackageEngine plugins
 *
 * Subcommands:
 *   list              List installed plugins
 *   add PATH          Install a plugin from a local path
 *   remove NAME       Remove an installed plugin
 *   info NAME         Show plugin details
 */
export async function cmdPlugin(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    printText(`Usage:
  better plugin <subcommand> [options]

Manage better package manager engine plugins.

Subcommands:
  list              List installed plugins
  add PATH          Install a plugin from a local directory
  remove NAME       Remove an installed plugin
  info NAME         Show plugin details

Options:
  --json  Machine-readable JSON output
  -h, --help  Show this help

Plugin format:
  A plugin directory must contain plugin.json:
  {
    "name": "my-engine",
    "version": "1.0.0",
    "description": "Custom package engine",
    "bin": "./my-engine",
    "manifest_files": ["mylock.json"],
    "detect_files": ["mypackage.json"],
    "author": "you@example.com",
    "engine_api_version": 1
  }
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false
  });

  const sub = positionals[0];
  const useJson = values.json || runtime.json === true;

  // Forward to Rust binary
  const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin");
  let binPath = null;
  for (const name of ["better-core", "better"]) {
    try {
      await fs.access(join(binDir, name));
      binPath = join(binDir, name);
      break;
    } catch {}
  }

  if (binPath) {
    const args = ["plugin", ...positionals];
    if (useJson) args.push("--json");
    const result = spawnSync(binPath, args, { encoding: "utf8" });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status) process.exitCode = result.status;
    return;
  }

  // JS fallback — read from ~/.better/plugins/
  const pluginsDir = join(process.env.HOME || "/tmp", ".better", "plugins");

  switch (sub) {
    case "list": {
      let plugins = [];
      try {
        const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          try {
            const manifest = JSON.parse(
              await fs.readFile(join(pluginsDir, entry.name, "plugin.json"), "utf8")
            );
            plugins.push(manifest);
          } catch { /* skip invalid plugin dirs */ }
        }
      } catch { /* pluginsDir not found */ }

      const result = { ok: true, kind: "better.plugin.list", plugins, count: plugins.length };
      if (useJson) { printJson(result); }
      else {
        if (plugins.length === 0) printText("No plugins installed.");
        else printText(plugins.map(p => `  ${p.name}@${p.version} — ${p.description}`).join("\n"));
      }
      break;
    }
    case "add": {
      const pluginPath = positionals[1];
      if (!pluginPath) {
        printText("Error: plugin path required");
        process.exitCode = 1;
        return;
      }
      try {
        const manifestPath = join(pluginPath, "plugin.json");
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        const dest = join(pluginsDir, manifest.name);
        await fs.mkdir(dest, { recursive: true });
        // Copy all files
        const entries = await fs.readdir(pluginPath);
        for (const entry of entries) {
          await fs.copyFile(join(pluginPath, entry), join(dest, entry));
        }
        const result = { ok: true, kind: "better.plugin.add", name: manifest.name, version: manifest.version };
        if (useJson) { printJson(result); }
        else { printText(`Installed plugin: ${manifest.name}@${manifest.version}`); }
      } catch (err) {
        const result = { ok: false, error: err.message };
        if (useJson) { printJson(result); } else { printText(`Error: ${err.message}`); }
        process.exitCode = 1;
      }
      break;
    }
    case "remove": {
      const name = positionals[1];
      if (!name) { printText("Error: plugin name required"); process.exitCode = 1; return; }
      try {
        await fs.rm(join(pluginsDir, name), { recursive: true, force: true });
        const result = { ok: true, kind: "better.plugin.remove", name };
        if (useJson) { printJson(result); } else { printText(`Removed plugin: ${name}`); }
      } catch (err) {
        const result = { ok: false, error: err.message };
        if (useJson) { printJson(result); } else { printText(`Error: ${err.message}`); }
        process.exitCode = 1;
      }
      break;
    }
    default:
      printText(`Unknown subcommand: ${sub}. Use 'list', 'add', or 'remove'.`);
      process.exitCode = 1;
  }
}
