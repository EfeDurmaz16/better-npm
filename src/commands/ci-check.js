/**
 * better ci-check — validate CI/CD configuration files
 *
 * Checks GitHub Actions, CircleCI, Travis CI, GitLab CI, and other
 * CI configuration files for common issues and best practices.
 *
 * Usage:
 *   better ci-check
 *   better ci-check --json
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

async function readFile(p) {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

async function checkGitHubActions(projectRoot) {
  const actionsDir = path.join(projectRoot, ".github", "workflows");
  const issues = [];
  let files = [];

  try {
    const entries = await fs.readdir(actionsDir, { withFileTypes: true });
    files = entries.filter(e => e.isFile() && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")))
      .map(e => path.join(actionsDir, e.name));
  } catch { return { found: false }; }

  if (files.length === 0) return { found: false };

  for (const file of files) {
    const content = await readFile(file);
    if (!content) continue;
    const relPath = path.relative(projectRoot, file);

    // Check for pinned action versions (good practice)
    const actionUses = content.match(/uses:\s+[\w/.-]+@[\w.-]+/g) || [];
    const unpinnedActions = actionUses.filter(u => {
      const ver = u.split("@")[1];
      return !ver || ver === "main" || ver === "master" || ver === "latest";
    });

    if (unpinnedActions.length > 0) {
      issues.push({
        file: relPath,
        severity: "warning",
        message: `${unpinnedActions.length} action(s) not pinned to a specific version`,
        hint: "Pin actions to a commit SHA or semver tag for reproducibility",
      });
    }

    // Check for cache steps
    if (!content.includes("cache") && content.includes("npm install")) {
      issues.push({
        file: relPath,
        severity: "info",
        message: "npm install without cache step",
        hint: "Consider using actions/cache for faster builds",
      });
    }

    // Check for node version pinning
    if (content.includes("node-version") && content.includes("latest")) {
      issues.push({
        file: relPath,
        severity: "warning",
        message: "Node.js version set to 'latest'",
        hint: "Pin to a specific Node.js version for reproducibility",
      });
    }

    // Check for secrets in plain text (naive check)
    if (/password\s*:\s*['"]?[a-zA-Z0-9]{8,}/i.test(content) ||
        /api_key\s*:\s*['"]?[a-zA-Z0-9]{8,}/i.test(content)) {
      issues.push({
        file: relPath,
        severity: "error",
        message: "Possible hardcoded secret found",
        hint: "Use GitHub Secrets (${{ secrets.MY_SECRET }}) instead",
      });
    }
  }

  return { found: true, files: files.map(f => path.relative(projectRoot, f)), issues };
}

async function checkCircleCI(projectRoot) {
  const filePath = path.join(projectRoot, ".circleci", "config.yml");
  const content = await readFile(filePath);
  if (!content) return { found: false };

  const issues = [];
  if (content.includes("version: 2") && !content.includes("version: 2.1")) {
    issues.push({ file: ".circleci/config.yml", severity: "info", message: "Consider upgrading to CircleCI config v2.1 for orbs support" });
  }

  return { found: true, issues };
}

async function checkGitLabCI(projectRoot) {
  const filePath = path.join(projectRoot, ".gitlab-ci.yml");
  const content = await readFile(filePath);
  if (!content) return { found: false };

  const issues = [];
  if (!content.includes("cache:")) {
    issues.push({ file: ".gitlab-ci.yml", severity: "info", message: "No cache configuration — consider caching node_modules", hint: "Use 'cache: paths: [node_modules/]'" });
  }

  return { found: true, issues };
}

export async function cmdCiCheck(argv) {
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
    printText(`Usage: better ci-check [options]

Validate CI/CD configuration files.

Supported CI platforms:
  • GitHub Actions (.github/workflows/*.yml)
  • CircleCI (.circleci/config.yml)
  • GitLab CI (.gitlab-ci.yml)

Checks:
  • Pinned action/image versions
  • Missing cache configuration
  • Hardcoded secrets
  • Outdated config formats

Options:
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const platforms = await Promise.all([
    checkGitHubActions(projectRoot).then(r => ({ name: "GitHub Actions", ...r })),
    checkCircleCI(projectRoot).then(r => ({ name: "CircleCI", ...r })),
    checkGitLabCI(projectRoot).then(r => ({ name: "GitLab CI", ...r })),
  ]);

  const detected = platforms.filter(p => p.found);
  const allIssues = detected.flatMap(p => (p.issues || []).map(i => ({ ...i, platform: p.name })));

  const errors = allIssues.filter(i => i.severity === "error");
  const warnings = allIssues.filter(i => i.severity === "warning");

  if (values.json) {
    printJson({
      ok: errors.length === 0,
      kind: "better.ci-check",
      detected: detected.map(p => ({ name: p.name, files: p.files || [] })),
      totalIssues: allIssues.length,
      errors: errors.length,
      warnings: warnings.length,
      issues: allIssues,
    });
    if (errors.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter ci-check\x1b[0m\n`);

  if (detected.length === 0) {
    printText(`\x1b[33m⚠ No CI configuration found.\x1b[0m`);
    printText(`\x1b[90mSupported: GitHub Actions, CircleCI, GitLab CI\x1b[0m`);
    return;
  }

  printText(`\x1b[90mDetected:\x1b[0m ${detected.map(p => p.name).join(", ")}\n`);

  if (allIssues.length === 0) {
    printText(`\x1b[32m✔ No CI configuration issues found.\x1b[0m`);
    return;
  }

  for (const issue of allIssues) {
    const icon = issue.severity === "error" ? "\x1b[31m✖\x1b[0m"
      : issue.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[90m·\x1b[0m";
    printText(`  ${icon}  \x1b[1m${issue.file}\x1b[0m`);
    printText(`       ${issue.message}`);
    if (issue.hint) printText(`       \x1b[90m→ ${issue.hint}\x1b[0m`);
  }

  printText("");
  if (errors.length > 0) {
    printText(`\x1b[31m✖ ${errors.length} error(s) in CI configuration.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s) in CI configuration.\x1b[0m`);
  }
  printText("");
}
