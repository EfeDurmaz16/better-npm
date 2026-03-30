/**
 * better monorepo-info — detect and display monorepo structure
 *
 * Detects monorepo tooling (npm workspaces, Turborepo, Lerna, Nx,
 * Rush, pnpm workspaces) and displays workspace structure, stats,
 * and configuration.
 *
 * Usage:
 *   better monorepo-info
 *   better monorepo-info --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

async function expandWorkspaces(patterns, root) {
  const workspaces = [];
  for (const pattern of patterns) {
    const parts = pattern.split("/");
    let bases = [root];
    for (const part of parts) {
      const next = [];
      for (const base of bases) {
        if (part.includes("*")) {
          let entries;
          try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { continue; }
          for (const e of entries) {
            if (e.isDirectory()) {
              const re = new RegExp("^" + part.replace(/\*/g, ".*") + "$");
              if (re.test(e.name)) next.push(path.join(base, e.name));
            }
          }
        } else {
          const candidate = path.join(base, part);
          if (await fileExists(candidate)) next.push(candidate);
        }
      }
      bases = next;
    }
    for (const dir of bases) {
      const pkg = await readJson(path.join(dir, "package.json"));
      if (pkg) workspaces.push({ dir, name: pkg.name || path.basename(dir), version: pkg.version, private: !!pkg.private });
    }
  }
  return workspaces;
}

export async function cmdMonorepoInfo(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better monorepo-info [options]

Detect and display monorepo structure and tooling.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Detects:
  • npm workspaces
  • pnpm workspaces (pnpm-workspace.yaml)
  • Turborepo (turbo.json)
  • Lerna (lerna.json)
  • Nx (nx.json)
  • Rush (rush.json)
  • Changesets (.changeset/)
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const pkgJson = await readJson(path.join(projectRoot, "package.json")) || {};

  if (!values.json) {
    printText(`\n\x1b[1mbetter monorepo-info\x1b[0m\n`);
  }

  // Detect tools
  const tools = [];
  const toolChecks = [
    { name: "Turborepo", file: "turbo.json", color: "\x1b[35m" },
    { name: "Lerna", file: "lerna.json", color: "\x1b[33m" },
    { name: "Nx", file: "nx.json", color: "\x1b[34m" },
    { name: "Rush", file: "rush.json", color: "\x1b[36m" },
    { name: "Changesets", file: ".changeset/config.json", color: "\x1b[32m" },
    { name: "pnpm workspaces", file: "pnpm-workspace.yaml", color: "\x1b[33m" },
    { name: "Yarn Berry", file: ".yarnrc.yml", color: "\x1b[34m" },
  ];

  const detectedConfig = {};
  for (const check of toolChecks) {
    const filePath = path.join(projectRoot, check.file);
    if (await fileExists(filePath)) {
      tools.push(check.name);
      const config = await readJson(filePath);
      if (config) detectedConfig[check.name] = config;
    }
  }

  // npm/pnpm workspaces
  const workspacePatterns = Array.isArray(pkgJson.workspaces) ? pkgJson.workspaces
    : Array.isArray(pkgJson.workspaces?.packages) ? pkgJson.workspaces.packages : [];

  let pnpmWorkspacePatterns = [];
  try {
    const pnpmWs = await fs.readFile(path.join(projectRoot, "pnpm-workspace.yaml"), "utf8");
    const m = pnpmWs.match(/packages:\s*\n((?:\s+-\s+.+\n?)+)/);
    if (m) {
      pnpmWorkspacePatterns = m[1].split("\n")
        .map(l => l.trim().replace(/^-\s+['"]?/, "").replace(/['"]?$/, ""))
        .filter(Boolean);
    }
  } catch {}

  const allPatterns = [...new Set([...workspacePatterns, ...pnpmWorkspacePatterns])];
  const workspaces = allPatterns.length > 0 ? await expandWorkspaces(allPatterns, projectRoot) : [];

  // Determine workspace manager
  if (workspacePatterns.length > 0 && !tools.includes("pnpm workspaces")) {
    tools.unshift("npm workspaces");
  }

  const isMonorepo = tools.length > 0 || workspaces.length > 0;

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.monorepo-info",
      isMonorepo,
      rootName: pkgJson.name || null,
      tools,
      workspacePatterns: allPatterns,
      workspaces: workspaces.map(w => ({
        name: w.name,
        version: w.version,
        private: w.private,
        dir: path.relative(projectRoot, w.dir),
      })),
    });
    return;
  }

  if (!isMonorepo) {
    printText(`  \x1b[90mThis does not appear to be a monorepo.\x1b[0m`);
    printText(`  \x1b[90mNo workspaces field or monorepo tooling detected.\x1b[0m`);
    printText("");
    return;
  }

  // Root info
  printText(`  Root: \x1b[1m${pkgJson.name || "(unnamed)"}\x1b[0m@${pkgJson.version || "?"}\n`);

  // Tools
  if (tools.length > 0) {
    printText(`  \x1b[1mDetected tooling:\x1b[0m`);
    for (const t of tools) {
      printText(`    \x1b[32m✔\x1b[0m  ${t}`);
    }
    printText("");
  }

  // Turbo pipelines
  if (detectedConfig["Turborepo"]?.pipeline) {
    const pipelines = Object.keys(detectedConfig["Turborepo"].pipeline);
    printText(`  \x1b[1mTurborepo pipelines:\x1b[0m  ${pipelines.join(", ")}`);
    printText("");
  }

  // Workspace list
  if (workspaces.length > 0) {
    printText(`  \x1b[1mWorkspaces (${workspaces.length}):\x1b[0m  \x1b[90mPatterns: ${allPatterns.join(", ")}\x1b[0m`);
    for (const ws of workspaces) {
      const rel = path.relative(projectRoot, ws.dir);
      const priv = ws.private ? " \x1b[90m[private]\x1b[0m" : "";
      printText(`    \x1b[36m${ws.name || rel}\x1b[0m@${ws.version || "?"}  \x1b[90m(${rel})\x1b[0m${priv}`);
    }
  } else if (allPatterns.length > 0) {
    printText(`  \x1b[33m⚠  Workspace patterns found but no packages resolved\x1b[0m`);
    printText(`  \x1b[90m  Patterns: ${allPatterns.join(", ")}\x1b[0m`);
  }
  printText("");
}
