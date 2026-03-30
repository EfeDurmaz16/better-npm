import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better registry` — manage package registries
 *
 * Subcommands:
 *   list                     List configured registries
 *   add NAME URL [--type]    Add a registry
 *   remove NAME              Remove a registry
 *   set-default NAME         Set default registry
 *   ping [NAME]              Test registry connectivity
 *   publish [NAME]           Publish to a specific registry
 *   federate NAME1 NAME2...  Federate multiple registries
 */
export async function cmdRegistry(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    printText(`Usage:
  better registry <subcommand> [options]

Manage package registries (npm, private, decentralized).

Subcommands:
  list                   List all configured registries
  add NAME URL           Add a registry (--type npm|ipfs|arweave|better)
  remove NAME            Remove a registry
  set-default NAME       Set the default registry
  ping [NAME]            Test registry connectivity
  federate NAME...       Show federated resolution order
  stats                  Show registry usage statistics

Options:
  --json  Machine-readable output
  -h, --help  Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      type: { type: "string", default: "npm" },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const sub = positionals[0];
  const configPath = path.join(process.env.HOME || "/tmp", ".better", "registries.json");
  const useJson = values.json || runtime.json === true;

  async function loadConfig() {
    try { return JSON.parse(await fs.readFile(configPath, "utf8")); }
    catch { return { default: "npm", registries: { npm: { url: "https://registry.npmjs.org", type: "npm" } } }; }
  }

  async function saveConfig(cfg) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
  }

  switch (sub) {
    case "list": {
      const cfg = await loadConfig();
      const result = { ok: true, kind: "better.registry.list", registries: cfg.registries, default: cfg.default };
      if (useJson) { printJson(result); }
      else {
        printText(Object.entries(cfg.registries).map(([name, r]) =>
          `  ${name === cfg.default ? "* " : "  "}${name} (${r.type}) — ${r.url}`
        ).join("\n"));
      }
      break;
    }
    case "add": {
      const [, name, url] = positionals;
      if (!name || !url) { printText("Error: name and URL required"); process.exitCode = 1; return; }
      const cfg = await loadConfig();
      cfg.registries[name] = { url, type: values.type };
      await saveConfig(cfg);
      const result = { ok: true, name, url, type: values.type };
      if (useJson) { printJson(result); } else { printText(`Added registry: ${name} (${url})`); }
      break;
    }
    case "remove": {
      const name = positionals[1];
      if (!name) { printText("Error: registry name required"); process.exitCode = 1; return; }
      const cfg = await loadConfig();
      delete cfg.registries[name];
      if (cfg.default === name) cfg.default = "npm";
      await saveConfig(cfg);
      const result = { ok: true, removed: name };
      if (useJson) { printJson(result); } else { printText(`Removed registry: ${name}`); }
      break;
    }
    case "set-default": {
      const name = positionals[1];
      if (!name) { printText("Error: registry name required"); process.exitCode = 1; return; }
      const cfg = await loadConfig();
      if (!cfg.registries[name]) { printText(`Error: registry '${name}' not found`); process.exitCode = 1; return; }
      cfg.default = name;
      await saveConfig(cfg);
      const result = { ok: true, default: name };
      if (useJson) { printJson(result); } else { printText(`Default registry set to: ${name}`); }
      break;
    }
    case "ping": {
      const name = positionals[1] || "npm";
      const cfg = await loadConfig();
      const reg = cfg.registries[name];
      if (!reg) { printText(`Error: registry '${name}' not found`); process.exitCode = 1; return; }
      const start = Date.now();
      try {
        const resp = await fetch(reg.url + "/-/ping");
        const ms = Date.now() - start;
        const result = { ok: true, name, url: reg.url, status: resp.status, latencyMs: ms };
        if (useJson) { printJson(result); }
        else { printText(`${name} (${reg.url}): ${resp.ok ? "OK" : "FAIL"} ${ms}ms`); }
      } catch (err) {
        const result = { ok: false, name, error: err.message };
        if (useJson) { printJson(result); } else { printText(`${name}: FAIL — ${err.message}`); }
        process.exitCode = 1;
      }
      break;
    }
    case "stats": {
      const cfg = await loadConfig();
      const result = {
        ok: true, kind: "better.registry.stats",
        registries: Object.keys(cfg.registries).length,
        default: cfg.default,
      };
      if (useJson) { printJson(result); }
      else { printText(`${Object.keys(cfg.registries).length} registry/registries configured. Default: ${cfg.default}`); }
      break;
    }
    default:
      printText(`Unknown subcommand: ${sub}. Run 'better registry --help' for usage.`);
      process.exitCode = 1;
  }
}
