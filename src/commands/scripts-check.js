/**
 * better scripts-check — validate package.json scripts
 *
 * Checks scripts for common issues: missing required scripts,
 * shell compatibility, hardcoded paths, missing CI scripts,
 * and dangerous patterns.
 *
 * Usage:
 *   better scripts-check
 *   better scripts-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Scripts that most packages should have
const RECOMMENDED_SCRIPTS = [
  { name: "test", label: "test script", severity: "warning" },
  { name: "build", label: "build script", severity: "info" },
  { name: "lint", label: "lint script", severity: "info" },
];

// Dangerous patterns in scripts
const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+-rf\s+\/[^t]/, label: "Dangerous rm -rf (root path)", severity: "error" },
  { pattern: /curl\s+.*\s*\|\s*(?:bash|sh)/, label: "Pipe from curl to shell (supply chain risk)", severity: "error" },
  { pattern: /wget\s+.*\s*\|\s*(?:bash|sh)/, label: "Pipe from wget to shell (supply chain risk)", severity: "error" },
  { pattern: /npm\s+install\s+--global/, label: "npm install --global in script", severity: "warning" },
  { pattern: /sudo\s+/, label: "Script uses sudo", severity: "warning" },
  { pattern: /chmod\s+[0-9]*7[0-9]*\s+/, label: "Script makes files world-executable", severity: "warning" },
];

// Cross-platform issues
const PLATFORM_PATTERNS = [
  { pattern: /&&\s*/, check: (s) => s.includes("&&") && !s.includes("cross-env"), label: "Uses && (use npm-run-all or cross-env for Windows compat)", severity: "info" },
  { pattern: /\bcp\b|\bmv\b|\bmkdir\b|\brm\b/, check: (s) => /\b(cp|mv|mkdir|rm)\b/.test(s), label: "Unix-only commands (cp/mv/mkdir/rm) — may fail on Windows", severity: "info" },
  { pattern: /export\s+\w+=/, check: (s) => /\bexport\s+\w+=/.test(s), label: "Unix export command — use cross-env for cross-platform", severity: "info" },
];

export async function cmdScriptsCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better scripts-check [options]

Validate package.json scripts for common issues.

Checks:
  • Recommended scripts present (test, build, lint)
  • Dangerous patterns (rm -rf, curl|bash)
  • Cross-platform compatibility
  • Script lifecycle consistency

Options:
  --json       Machine-readable output
  -h, --help   Show this help
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
  const scriptNames = Object.keys(scripts);

  if (scriptNames.length === 0) {
    if (values.json) {
      printJson({ ok: true, kind: "better.scripts-check", message: "No scripts defined" });
    } else {
      printText(`\x1b[90mNo scripts defined in package.json.\x1b[0m`);
    }
    return;
  }

  const issues = [];

  // Check recommended scripts
  for (const rec of RECOMMENDED_SCRIPTS) {
    if (!scripts[rec.name]) {
      issues.push({
        id: `missing-${rec.name}`,
        severity: rec.severity,
        script: null,
        label: `Missing "${rec.name}" script`,
        hint: `Add a "${rec.name}" script to package.json`,
      });
    } else if (rec.name === "test" && scripts.test?.startsWith("echo")) {
      issues.push({
        id: "test-placeholder",
        severity: "warning",
        script: "test",
        label: `"test" script is a placeholder (echo)`,
        hint: "Add a real test runner (jest, vitest, node --test, etc.)",
      });
    }
  }

  // Check for dangerous patterns
  for (const [scriptName, scriptValue] of Object.entries(scripts)) {
    for (const danger of DANGEROUS_PATTERNS) {
      if (danger.pattern.test(scriptValue)) {
        issues.push({
          id: `danger-${scriptName}`,
          severity: danger.severity,
          script: scriptName,
          label: `"${scriptName}": ${danger.label}`,
          hint: `Review: ${scriptValue.slice(0, 80)}`,
        });
      }
    }

    // Platform issues (only report once per script)
    const platformIssueLabels = new Set();
    for (const platform of PLATFORM_PATTERNS) {
      if (platform.check(scriptValue) && !platformIssueLabels.has(platform.label)) {
        platformIssueLabels.add(platform.label);
        issues.push({
          id: `platform-${scriptName}`,
          severity: platform.severity,
          script: scriptName,
          label: `"${scriptName}": ${platform.label}`,
        });
      }
    }
  }

  // Check for pre/post lifecycle consistency
  for (const scriptName of scriptNames) {
    if (scriptName.startsWith("pre") || scriptName.startsWith("post")) {
      const base = scriptName.startsWith("pre")
        ? scriptName.slice(3)
        : scriptName.slice(4);
      if (!scripts[base]) {
        issues.push({
          id: `orphan-lifecycle-${scriptName}`,
          severity: "warning",
          script: scriptName,
          label: `"${scriptName}" lifecycle script has no corresponding "${base}" script`,
        });
      }
    }
  }

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.scripts-check",
      scripts: scriptNames.length,
      issues: issues.length,
      errors: errors.length,
      warnings: warnings.length,
      issueList: issues,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter scripts-check\x1b[0m — ${scriptNames.length} script(s)\n`);

  if (issues.length === 0) {
    printText(`\x1b[32m✔ Scripts look good!\x1b[0m`);
    return;
  }

  for (const issue of issues) {
    const icon = issue.severity === "error"
      ? "\x1b[31m✖\x1b[0m"
      : issue.severity === "warning"
      ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[90m·\x1b[0m";
    printText(`  ${icon}  ${issue.label}`);
    if (issue.hint) printText(`       \x1b[90m→ ${issue.hint}\x1b[0m`);
  }

  printText("");
  if (allOk) {
    printText(`\x1b[33m⚠ ${issues.length} suggestion(s) — scripts are usable.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} error(s) in scripts.\x1b[0m`);
    process.exitCode = 1;
  }
}
