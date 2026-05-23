import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runGetEnvInfoNapi } from "../lib/core.js";

/**
 * `better env` — manage environment variables for the project
 *
 * Subcommands:
 *   better env list              List all env vars from .env, .env.local, .env.osp
 *   better env set KEY=VALUE     Set an env var in .env.local
 *   better env get KEY           Get the value of a key
 *   better env unset KEY         Remove a key from .env.local
 *   better env diff              Show diff between .env and .env.example
 *   better env validate          Check all required vars from .env.example are set
 *   better env export            Export all vars as shell `export KEY=VALUE` lines
 */
export async function cmdEnv(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    printText(`Usage:
  better env <subcommand> [options]

Manage environment variables for your project.

Subcommands:
  list              Show all env vars (merged from .env files)
  set KEY=VALUE     Set a variable in .env.local
  get KEY           Get a variable value
  unset KEY         Remove a variable from .env.local
  diff              Show diff between .env and .env.example
  validate          Check all .env.example vars are set
  export            Print as shell export statements

Options:
  --env FILE        Env file to use (default: .env)
  --json            Machine-readable JSON output
  --project-root PATH Override project root
  -h, --help        Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      env: { type: "string", default: ".env" },
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

  switch (sub) {
    case "list": return await envList(projectRoot, values);
    case "set": return await envSet(projectRoot, positionals.slice(1), values);
    case "get": return await envGet(projectRoot, positionals[1], values);
    case "unset": return await envUnset(projectRoot, positionals[1], values);
    case "diff": return await envDiff(projectRoot, values);
    case "validate": return await envValidate(projectRoot, values);
    case "export": return await envExport(projectRoot, values);
    case "info": {
      const napiInfo = runGetEnvInfoNapi(projectRoot);
      if (napiInfo?.ok) {
        if (values.json) { printJson({ ok: true, kind: "better.env.info", ...napiInfo }); return; }
        printText([
          `better env info`,
          `- node: ${napiInfo.nodeVersion}`,
          `- npm: ${napiInfo.npmVersion}`,
          `- better: ${napiInfo.betterVersion}`,
          `- platform: ${napiInfo.platform}/${napiInfo.arch}`,
          ...(napiInfo.projectName ? [`- project: ${napiInfo.projectName}@${napiInfo.projectVersion ?? "0.0.0"}`] : []),
          ...(napiInfo.engines ? [`- engines: ${napiInfo.engines}`] : []),
        ].join("\n"));
        return;
      }
      printText("env info unavailable (NAPI not loaded)");
      return;
    }
    default:
      printText(`Unknown subcommand: ${sub}. Run 'better env --help' for usage.`);
      process.exitCode = 1;
  }
}

// Parse .env file format
function parseEnvFile(content) {
  const vars = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

async function loadAllEnv(projectRoot) {
  const files = [".env", ".env.local", ".env.osp", ".env.defaults"];
  const merged = {};
  for (const f of files) {
    try {
      const content = await fs.readFile(path.join(projectRoot, f), "utf8");
      Object.assign(merged, parseEnvFile(content));
    } catch { /* file not found, skip */ }
  }
  return merged;
}

async function envList(projectRoot, values) {
  const vars = await loadAllEnv(projectRoot);
  if (values.json) {
    printJson({ ok: true, kind: "better.env.list", vars, count: Object.keys(vars).length });
    return;
  }
  if (Object.keys(vars).length === 0) {
    printText("No environment variables found.");
    return;
  }
  const lines = Object.entries(vars).map(([k, v]) => {
    // Redact secrets
    if (/secret|key|token|password|pass|pwd/i.test(k)) {
      return `${k}=***`;
    }
    return `${k}=${v}`;
  });
  printText(lines.join("\n"));
}

async function envSet(projectRoot, pairs, values) {
  const envLocalPath = path.join(projectRoot, ".env.local");
  let current = {};
  try { current = parseEnvFile(await fs.readFile(envLocalPath, "utf8")); } catch {}

  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    current[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  const content = Object.entries(current).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  await fs.writeFile(envLocalPath, content);

  if (values.json) { printJson({ ok: true, set: pairs }); }
  else { printText(`Set ${pairs.length} variable(s) in .env.local`); }
}

async function envGet(projectRoot, key, values) {
  if (!key) { printText("Error: key required"); process.exitCode = 1; return; }
  const vars = await loadAllEnv(projectRoot);
  const val = vars[key];
  if (values.json) { printJson({ ok: !!val, key, value: val || null }); }
  else { printText(val !== undefined ? val : `${key} not found`); }
  if (val === undefined) process.exitCode = 1;
}

async function envUnset(projectRoot, key, values) {
  if (!key) { printText("Error: key required"); process.exitCode = 1; return; }
  const envLocalPath = path.join(projectRoot, ".env.local");
  let current = {};
  try { current = parseEnvFile(await fs.readFile(envLocalPath, "utf8")); } catch {}
  delete current[key];
  const content = Object.entries(current).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  await fs.writeFile(envLocalPath, content);
  if (values.json) { printJson({ ok: true, unset: key }); }
  else { printText(`Unset ${key} from .env.local`); }
}

async function envDiff(projectRoot, values) {
  let envVars = {}, exampleVars = {};
  try { envVars = parseEnvFile(await fs.readFile(path.join(projectRoot, ".env"), "utf8")); } catch {}
  try { exampleVars = parseEnvFile(await fs.readFile(path.join(projectRoot, ".env.example"), "utf8")); } catch {}

  const inEnv = new Set(Object.keys(envVars));
  const inExample = new Set(Object.keys(exampleVars));
  const missing = [...inExample].filter(k => !inEnv.has(k));
  const extra = [...inEnv].filter(k => !inExample.has(k));

  if (values.json) { printJson({ ok: true, missing, extra }); }
  else {
    if (missing.length) printText(`Missing from .env (in .env.example):\n${missing.map(k => `  - ${k}`).join("\n")}`);
    if (extra.length) printText(`Extra in .env (not in .env.example):\n${extra.map(k => `  + ${k}`).join("\n")}`);
    if (!missing.length && !extra.length) printText(".env matches .env.example");
  }
}

async function envValidate(projectRoot, values) {
  let exampleVars = {};
  try { exampleVars = parseEnvFile(await fs.readFile(path.join(projectRoot, ".env.example"), "utf8")); } catch {}
  const allVars = await loadAllEnv(projectRoot);
  const missing = Object.keys(exampleVars).filter(k => !(k in allVars));

  if (values.json) { printJson({ ok: missing.length === 0, missing }); }
  else {
    if (missing.length === 0) printText("All required environment variables are set.");
    else { printText(`Missing required variables:\n${missing.map(k => `  - ${k}`).join("\n")}`); process.exitCode = 1; }
  }
}

async function envExport(projectRoot, values) {
  const vars = await loadAllEnv(projectRoot);
  const lines = Object.entries(vars).map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`);
  if (values.json) { printJson({ ok: true, exports: lines }); }
  else { printText(lines.join("\n")); }
}
