/**
 * better hooks-audit — audit npm lifecycle hooks in package.json
 *
 * Reviews all lifecycle hooks (pre/post scripts, prepare, etc.) across
 * your package.json and installed packages, flagging suspicious or
 * potentially dangerous hook scripts.
 *
 * Usage:
 *   better hooks-audit
 *   better hooks-audit --all       Check all node_modules too
 *   better hooks-audit --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const ALL_LIFECYCLE_HOOKS = new Set([
  "preinstall", "install", "postinstall", "prepare",
  "prepublish", "prepublishOnly", "publish", "postpublish",
  "prepack", "pack", "postpack",
  "pretest", "test", "posttest",
  "prebuild", "build", "postbuild",
  "prestart", "start", "poststart",
  "prestop", "stop", "poststop",
  "prerestart", "restart", "postrestart",
  "preversion", "version", "postversion",
]);

const SUSPICIOUS_PATTERNS = [
  { pattern: /\bcurl\b|\bwget\b/, label: "network fetch" },
  { pattern: /\beval\b/, label: "eval" },
  { pattern: /\brm\s+-rf?\b/, label: "rm -rf" },
  { pattern: /\bchmod\b.*\+x/, label: "chmod +x" },
  { pattern: /node\s+-e\b/, label: "inline node execution" },
  { pattern: /\bbase64\b.*decode/, label: "base64 decode" },
  { pattern: /\bexec\b\s*\(/, label: "exec()" },
  { pattern: /process\.env\[['"]\w+['"]\]/, label: "reads env vars" },
];

function auditScript(script) {
  return SUSPICIOUS_PATTERNS.filter(({ pattern }) => pattern.test(script)).map(p => p.label);
}

export async function cmdHooksAudit(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      all:   { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better hooks-audit [options]

Audit npm lifecycle hooks for suspicious patterns.

Options:
  --all        Also check hooks in all node_modules packages
  --json       Machine-readable output
  -h, --help   Show this help

Checks lifecycle hooks (preinstall, postinstall, prepare, etc.)
for potentially dangerous patterns like network fetches, eval, etc.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter hooks-audit\x1b[0m\n`);
  }

  const allResults = [];

  // Check root package.json
  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}
  const rootScripts = pkgJson.scripts || {};
  for (const [name, script] of Object.entries(rootScripts)) {
    if (!ALL_LIFECYCLE_HOOKS.has(name)) continue;
    const issues = auditScript(script);
    allResults.push({ package: pkgJson.name || "(root)", source: "root", hook: name, script, issues, isRoot: true });
  }

  // Check node_modules if --all
  if (values.all) {
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
            for (const s of scoped) pkgDirs.push(path.join(scopeDir, s.name));
          } catch {}
        } else {
          pkgDirs.push(path.join(nmPath, e.name));
        }
      }
    } catch {}

    const BATCH = 20;
    for (let i = 0; i < pkgDirs.length; i += BATCH) {
      const batch = pkgDirs.slice(i, i + BATCH);
      await Promise.all(batch.map(async (dir) => {
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
          const scripts = pkg.scripts || {};
          for (const [name, script] of Object.entries(scripts)) {
            if (!ALL_LIFECYCLE_HOOKS.has(name)) continue;
            const issues = auditScript(script);
            if (issues.length > 0) {
              allResults.push({ package: pkg.name, version: pkg.version, source: "node_modules", hook: name, script, issues, isRoot: false });
            }
          }
        } catch {}
      }));
    }
  }

  const suspicious = allResults.filter(r => r.issues.length > 0);
  const ok = suspicious.filter(r => !r.isRoot).length === 0;

  if (values.json) {
    printJson({ ok, kind: "better.hooks-audit", total: allResults.length, suspicious: suspicious.length, results: allResults });
    if (!ok) process.exitCode = 1;
    return;
  }

  if (allResults.length === 0 && !values.all) {
    printText(`  \x1b[90mNo lifecycle hooks in root package.json.\x1b[0m`);
    printText(`  Use --all to check node_modules packages too.\n`);
    return;
  }

  // Show root hooks
  const rootHooks = allResults.filter(r => r.isRoot);
  if (rootHooks.length > 0) {
    printText(`\x1b[1mRoot package hooks:\x1b[0m`);
    for (const r of rootHooks) {
      const icon = r.issues.length > 0 ? "\x1b[33m⚠\x1b[0m" : "\x1b[32m✔\x1b[0m";
      const short = r.script.length > 60 ? r.script.slice(0, 60) + "..." : r.script;
      printText(`  ${icon}  ${r.hook}: \x1b[90m${short}\x1b[0m`);
      if (r.issues.length > 0) printText(`       \x1b[33m[${r.issues.join(", ")}]\x1b[0m`);
    }
    printText("");
  }

  // Show suspicious node_modules hooks
  const nmSuspicious = suspicious.filter(r => !r.isRoot);
  if (nmSuspicious.length > 0) {
    printText(`\x1b[1mSuspicious hooks in node_modules:\x1b[0m`);
    for (const r of nmSuspicious) {
      printText(`  \x1b[31m✘\x1b[0m  \x1b[1m${r.package}@${r.version || "?"}\x1b[0m  \x1b[31m[${r.issues.join(", ")}]\x1b[0m`);
      const short = r.script.length > 80 ? r.script.slice(0, 80) + "..." : r.script;
      printText(`       \x1b[90m${r.hook}: ${short}\x1b[0m`);
    }
    process.exitCode = 1;
  } else if (values.all) {
    printText(`\x1b[32m✔ No suspicious hooks found in node_modules.\x1b[0m`);
  }
  printText("");
}
