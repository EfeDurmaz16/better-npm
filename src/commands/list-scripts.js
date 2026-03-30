/**
 * better list-scripts — list all available npm scripts with descriptions
 *
 * Shows all scripts from package.json with their commands,
 * lifecycle hooks, and pre/post variants. More readable than
 * `npm run` alone.
 *
 * Usage:
 *   better list-scripts
 *   better list-scripts --filter test
 *   better list-scripts --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const LIFECYCLE = new Set([
  "preinstall", "install", "postinstall", "prepare",
  "prepublishOnly", "prepublish", "publish", "postpublish",
  "prepack", "postpack",
  "pretest", "test", "posttest",
  "prebuild", "build", "postbuild",
  "prestart", "start", "poststart",
  "prestop", "stop", "poststop",
  "prerestart", "restart", "postrestart",
  "preversion", "version", "postversion",
]);

const COMMON_SCRIPTS = new Set([
  "dev", "lint", "format", "check", "clean", "generate", "deploy",
  "watch", "storybook", "docs", "typecheck", "e2e",
]);

function scriptIcon(name) {
  if (name === "test" || name.includes("test")) return "🧪";
  if (name === "build" || name.includes("build")) return "🔨";
  if (name === "dev" || name === "start") return "🚀";
  if (name === "lint" || name.includes("lint")) return "🔍";
  if (name === "clean") return "🧹";
  if (name === "deploy") return "📦";
  if (name.includes("format")) return "✨";
  return "▶";
}

function scriptCategory(name) {
  if (LIFECYCLE.has(name)) return "lifecycle";
  if (name === "test" || name.startsWith("test:")) return "test";
  if (name === "build" || name.startsWith("build:")) return "build";
  if (name === "dev" || name === "start" || name.startsWith("dev:")) return "dev";
  if (name === "lint" || name.startsWith("lint:")) return "lint";
  return "custom";
}

export async function cmdListScripts(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      filter: { type: "string" },
      all:    { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better list-scripts [options]

List all npm scripts with their commands.

Options:
  --filter <str>  Show only scripts matching a string
  --all           Include lifecycle hooks (preinstall, etc.)
  --json          Machine-readable output
  -h, --help      Show this help

Examples:
  better list-scripts
  better list-scripts --filter test
  better list-scripts --all
`);
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

  const scripts = pkgJson.scripts || {};

  let entries = Object.entries(scripts);

  // Filter lifecycle unless --all
  if (!values.all) {
    entries = entries.filter(([name]) => {
      // Keep non-lifecycle, but also keep pre/post of common scripts
      if (LIFECYCLE.has(name) && !COMMON_SCRIPTS.has(name)) return false;
      return true;
    });
  }

  // Apply filter
  if (values.filter) {
    const filter = values.filter.toLowerCase();
    entries = entries.filter(([name, cmd]) =>
      name.toLowerCase().includes(filter) || cmd.toLowerCase().includes(filter)
    );
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.list-scripts",
      total: Object.keys(scripts).length,
      shown: entries.length,
      scripts: entries.map(([name, command]) => ({
        name,
        command,
        category: scriptCategory(name),
        isLifecycle: LIFECYCLE.has(name),
      })),
    });
    return;
  }

  printText(`\n\x1b[1mbetter list-scripts\x1b[0m — ${pkgJson.name || "project"}\n`);

  if (entries.length === 0) {
    if (values.filter) {
      printText(`\x1b[90mNo scripts matching "${values.filter}".\x1b[0m\n`);
    } else {
      printText(`\x1b[90mNo scripts defined in package.json.\x1b[0m\n`);
    }
    return;
  }

  // Group by category
  const groups = new Map();
  for (const [name, cmd] of entries) {
    const cat = scriptCategory(name);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push([name, cmd]);
  }

  const categoryOrder = ["dev", "build", "test", "lint", "custom", "lifecycle"];

  for (const cat of categoryOrder) {
    const group = groups.get(cat);
    if (!group || group.length === 0) continue;

    const catLabel = cat === "dev" ? "Development" : cat === "lifecycle" ? "Lifecycle hooks" : cat.charAt(0).toUpperCase() + cat.slice(1);
    printText(`\x1b[90m${catLabel}:\x1b[0m`);

    for (const [name, cmd] of group) {
      const icon = scriptIcon(name);
      const truncCmd = cmd.length > 70 ? cmd.slice(0, 67) + "..." : cmd;
      printText(`  ${icon}  \x1b[1m${name.padEnd(20)}\x1b[0m  \x1b[90m${truncCmd}\x1b[0m`);
    }
    printText("");
  }

  printText(`\x1b[90mRun with: better run <script> or npm run <script>\x1b[0m\n`);
}
