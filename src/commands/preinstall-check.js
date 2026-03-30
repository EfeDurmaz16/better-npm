/**
 * better preinstall-check — scan install scripts for safety
 *
 * Inspects preinstall/postinstall/install scripts across all
 * packages before running npm install. Flags suspicious patterns
 * like network calls, file writes outside node_modules, etc.
 *
 * Usage:
 *   better preinstall-check
 *   better preinstall-check --strict
 *   better preinstall-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Patterns that warrant a warning or error
const WARN_PATTERNS = [
  { re: /curl\s+/i,           label: "network fetch (curl)",          severity: "warn" },
  { re: /wget\s+/i,           label: "network fetch (wget)",          severity: "warn" },
  { re: /fetch\s+https?:\/\//i, label: "network fetch (fetch)",       severity: "warn" },
  { re: /http\.get\s*\(/i,    label: "network fetch (http.get)",      severity: "warn" },
  { re: /require\s*\(\s*["']https?:\/\//i, label: "remote require",  severity: "error" },
  { re: /eval\s*\(/i,         label: "eval()",                        severity: "error" },
  { re: /new\s+Function\s*\(/i, label: "new Function()",             severity: "error" },
  { re: /child_process/i,     label: "spawns child processes",        severity: "warn" },
  { re: /exec\s*\(/i,         label: "exec() call",                   severity: "warn" },
  { re: /rm\s+-rf/i,          label: "rm -rf (destructive delete)",   severity: "error" },
  { re: /process\.env\.\w+\s*=/i, label: "modifies process.env",     severity: "warn" },
  { re: /fs\.write/i,         label: "writes to filesystem",          severity: "warn" },
  { re: /__dirname.*\.\.\//i, label: "writes outside package dir",    severity: "warn" },
  { re: /sudo\s+/i,           label: "requires sudo",                 severity: "error" },
  { re: /chmod\s+/i,          label: "changes file permissions",      severity: "warn" },
  { re: /base64/i,            label: "base64 (possible obfuscation)",  severity: "warn" },
];

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

async function readPackageJson(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

async function scanPackage(nmPath, name) {
  const pkg = await readPackageJson(path.join(nmPath, name));
  if (!pkg) return null;

  const scripts = pkg.scripts || {};
  const findings = [];

  for (const scriptName of INSTALL_SCRIPTS) {
    const script = scripts[scriptName];
    if (!script) continue;

    const scriptFindings = [];
    for (const { re, label, severity } of WARN_PATTERNS) {
      if (re.test(script)) {
        scriptFindings.push({ label, severity });
      }
    }

    if (scriptFindings.length > 0) {
      findings.push({
        script: scriptName,
        command: script.slice(0, 120) + (script.length > 120 ? "…" : ""),
        issues: scriptFindings,
      });
    }
  }

  if (findings.length === 0) return null;

  const maxSeverity = findings.some(f => f.issues.some(i => i.severity === "error"))
    ? "error" : "warn";

  return {
    name,
    version: pkg.version || "?",
    findings,
    severity: maxSeverity,
  };
}

export async function cmdPreinstallCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      strict: { type: "boolean", default: false },
      all:    { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better preinstall-check [packages...] [options]

Scan package install scripts for suspicious patterns.

Options:
  --strict     Exit 1 on warnings (not just errors)
  --all        Scan all transitive deps (slower)
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better preinstall-check
  better preinstall-check --strict
  better preinstall-check lodash express
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

  const nmPath = path.join(projectRoot, "node_modules");
  const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };

  let targets;
  if (positionals.length > 0) {
    targets = positionals;
  } else if (values.all) {
    // scan all node_modules
    try {
      const entries = await fs.readdir(nmPath, { withFileTypes: true });
      targets = [];
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory() && e.name.startsWith("@")) {
          const scoped = await fs.readdir(path.join(nmPath, e.name), { withFileTypes: true });
          for (const s of scoped) {
            if (s.isDirectory()) targets.push(`${e.name}/${s.name}`);
          }
        } else if (e.isDirectory()) {
          targets.push(e.name);
        }
      }
    } catch { targets = Object.keys(allDeps); }
  } else {
    targets = Object.keys(allDeps);
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mScanning ${targets.length} package(s) for install scripts…\x1b[0m\n`);
  }

  const BATCH = 20;
  const results = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(name => scanPackage(nmPath, name)));
    results.push(...batchResults.filter(Boolean));
  }

  results.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const errors = results.filter(r => r.severity === "error");
  const warnings = results.filter(r => r.severity === "warn");
  const allOk = errors.length === 0 && (!values.strict || warnings.length === 0);

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.preinstall-check",
      totalScanned: targets.length,
      flagged: results.length,
      errors: errors.length,
      warnings: warnings.length,
      packages: results,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter preinstall-check\x1b[0m — ${targets.length} packages scanned\n`);

  if (results.length === 0) {
    printText(`\x1b[32m✔ No suspicious install scripts found.\x1b[0m`);
    return;
  }

  for (const r of results) {
    const icon = r.severity === "error" ? "\x1b[31m✖\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    printText(`  ${icon}  \x1b[1m${r.name}\x1b[0m@${r.version}`);

    for (const f of r.findings) {
      printText(`       \x1b[90mscript: ${f.script}\x1b[0m`);
      printText(`       \x1b[90mcmd: ${f.command}\x1b[0m`);
      for (const issue of f.issues) {
        const col = issue.severity === "error" ? "\x1b[31m" : "\x1b[33m";
        printText(`       ${col}→ ${issue.label}\x1b[0m`);
      }
    }
    printText("");
  }

  if (allOk) {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s). Run with --strict to fail on warnings.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} error(s) found. Review install scripts before proceeding.\x1b[0m`);
    process.exitCode = 1;
  }
}
