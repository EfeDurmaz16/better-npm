/**
 * better postinstall-audit — audit postinstall scripts across dependencies
 *
 * Scans node_modules for packages with postinstall, preinstall, and
 * install lifecycle scripts, flagging potentially risky ones and
 * showing what they do.
 *
 * Usage:
 *   better postinstall-audit
 *   better postinstall-audit --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const RISKY_PATTERNS = [
  { pattern: /\bcurl\b|\bwget\b/, label: "network fetch" },
  { pattern: /\beval\b/, label: "eval" },
  { pattern: /\brm\s+-rf?\b/, label: "destructive rm" },
  { pattern: /node\s+-e\b|node\s+-p\b/, label: "inline node exec" },
  { pattern: /\bbase64\b/, label: "base64 decode" },
  { pattern: /process\.exit|process\.env\b/, label: "process manipulation" },
];

function assessRisk(scriptContent) {
  const risks = [];
  for (const { pattern, label } of RISKY_PATTERNS) {
    if (pattern.test(scriptContent)) risks.push(label);
  }
  return risks;
}

export async function cmdPostinstallAudit(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      "risky-only": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better postinstall-audit [options]

Audit postinstall/preinstall scripts across dependencies.

Options:
  --risky-only   Only show packages with risky patterns
  --json         Machine-readable output
  -h, --help     Show this help

Detects packages that run scripts during installation,
particularly those with network fetches, eval, or other risky patterns.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter postinstall-audit\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning install scripts...\x1b[0m\n`);
  }

  const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];

  // Collect all top-level package dirs
  let pkgDirs = [];
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymlink()) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name.startsWith("@")) {
        const scopeDir = path.join(nmPath, e.name);
        try {
          const scoped = await fs.readdir(scopeDir, { withFileTypes: true });
          for (const s of scoped) {
            if (s.isDirectory() || s.isSymlink()) pkgDirs.push(path.join(scopeDir, s.name));
          }
        } catch {}
      } else {
        pkgDirs.push(path.join(nmPath, e.name));
      }
    }
  } catch {
    const msg = "Cannot read node_modules";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const results = [];
  const BATCH = 20;
  for (let i = 0; i < pkgDirs.length; i += BATCH) {
    const batch = pkgDirs.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dir) => {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
        const scripts = pkg.scripts || {};
        const hookScripts = {};
        for (const hook of INSTALL_HOOKS) {
          if (scripts[hook]) hookScripts[hook] = scripts[hook];
        }
        if (Object.keys(hookScripts).length === 0) return;

        const allScripts = Object.values(hookScripts).join(" ");
        const risks = assessRisk(allScripts);
        const isRisky = risks.length > 0;

        if (!values["risky-only"] || isRisky) {
          results.push({ name: pkg.name, version: pkg.version, scripts: hookScripts, risks, isRisky });
        }
      } catch {}
    }));
  }

  results.sort((a, b) => b.risks.length - a.risks.length || a.name.localeCompare(b.name));

  const risky = results.filter(r => r.isRisky);

  if (values.json) {
    printJson({
      ok: risky.length === 0,
      kind: "better.postinstall-audit",
      total: results.length,
      risky: risky.length,
      packages: results,
    });
    if (risky.length > 0) process.exitCode = 1;
    return;
  }

  printText(`  Packages with install scripts: ${results.length}  |  Risky: ${risky.length}\n`);

  if (results.length === 0) {
    printText(`\x1b[32m✔ No install scripts found.\x1b[0m`);
    printText("");
    return;
  }

  for (const r of results) {
    const icon = r.isRisky ? "\x1b[31m⚠\x1b[0m" : "\x1b[90m·\x1b[0m";
    const riskStr = r.risks.length > 0 ? `  \x1b[31m[${r.risks.join(", ")}]\x1b[0m` : "";
    printText(`  ${icon}  \x1b[1m${r.name}@${r.version}\x1b[0m${riskStr}`);
    for (const [hook, script] of Object.entries(r.scripts)) {
      const short = script.length > 70 ? script.slice(0, 70) + "..." : script;
      printText(`       \x1b[90m${hook}: ${short}\x1b[0m`);
    }
  }

  if (risky.length > 0) {
    printText(`\n\x1b[31m✘ ${risky.length} package(s) with potentially risky install scripts.\x1b[0m`);
    printText(`  \x1b[90mReview these scripts carefully before deploying to production.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
