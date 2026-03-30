/**
 * better git-check — validate git state before operations
 *
 * Checks git repository state: clean working tree, branch status,
 * uncommitted changes, unpushed commits, and tag status.
 * Useful before releases or deployments.
 *
 * Usage:
 *   better git-check
 *   better git-check --before-release
 *   better git-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function git(args, cwd) {
  const r = spawnSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], cwd });
  return { stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), status: r.status };
}

export async function cmdGitCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:            { type: "boolean", default: runtime.json === true },
      help:            { type: "boolean", short: "h", default: false },
      "before-release":{ type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better git-check [options]

Validate git repository state.

Options:
  --before-release   Strict checks for release readiness
  --json             Machine-readable output
  -h, --help         Show this help

Checks:
  • Is a git repository
  • Working tree is clean
  • No uncommitted changes
  • No untracked files (with --before-release)
  • Current branch name
  • Unpushed commits
  • Whether current commit is tagged
`);
    return;
  }

  const cwd = process.cwd();

  const checks = [];

  // Check if git repo
  const isRepo = git(["rev-parse", "--git-dir"], cwd);
  if (isRepo.status !== 0) {
    const msg = "Not a git repository";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  // Current branch
  const branchResult = git(["branch", "--show-current"], cwd);
  const branch = branchResult.stdout || "HEAD detached";
  checks.push({ id: "branch", label: `Branch: ${branch}`, passed: true, severity: "info" });

  // Uncommitted changes
  const statusResult = git(["status", "--porcelain"], cwd);
  const changedFiles = statusResult.stdout.split("\n").filter(Boolean);
  const uncommitted = changedFiles.filter(f => !f.startsWith("??"));
  const untracked = changedFiles.filter(f => f.startsWith("??"));

  if (uncommitted.length > 0) {
    checks.push({
      id: "uncommitted",
      label: `${uncommitted.length} uncommitted change(s)`,
      passed: false,
      severity: "error",
      hint: "Run: git add . && git commit",
      files: uncommitted.slice(0, 5),
    });
  } else {
    checks.push({ id: "uncommitted", label: "Working tree clean", passed: true, severity: "info" });
  }

  if (untracked.length > 0 && values["before-release"]) {
    checks.push({
      id: "untracked",
      label: `${untracked.length} untracked file(s)`,
      passed: false,
      severity: "warning",
      hint: "Consider adding to .gitignore or committing",
    });
  }

  // Unpushed commits
  const unpushedResult = git(["log", "@{u}..HEAD", "--oneline"], cwd);
  if (unpushedResult.status === 0) {
    const unpushed = unpushedResult.stdout.split("\n").filter(Boolean);
    if (unpushed.length > 0) {
      checks.push({
        id: "unpushed",
        label: `${unpushed.length} unpushed commit(s)`,
        passed: false,
        severity: values["before-release"] ? "error" : "warning",
        hint: "Run: git push",
        commits: unpushed.slice(0, 3),
      });
    } else {
      checks.push({ id: "unpushed", label: "No unpushed commits", passed: true, severity: "info" });
    }
  } else {
    checks.push({ id: "unpushed", label: "No upstream branch set", passed: false, severity: "warning", hint: "Run: git push -u origin " + branch });
  }

  // Current commit tag (for release check)
  if (values["before-release"]) {
    const tagResult = git(["describe", "--exact-match", "--tags", "HEAD"], cwd);
    if (tagResult.status === 0) {
      checks.push({ id: "tag", label: `Tagged: ${tagResult.stdout}`, passed: true, severity: "info" });
    } else {
      checks.push({ id: "tag", label: "Current commit is not tagged", passed: false, severity: "warning", hint: "Run: git tag v<version> && git push --tags" });
    }

    // Main/master branch check
    if (branch !== "main" && branch !== "master") {
      checks.push({
        id: "release-branch",
        label: `On branch "${branch}" (not main/master)`,
        passed: false,
        severity: "warning",
        hint: "Usually release from main or master branch",
      });
    }
  }

  const errors = checks.filter(c => !c.passed && c.severity === "error");
  const warnings = checks.filter(c => !c.passed && c.severity === "warning");
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.git-check",
      branch,
      checks: checks.map(c => ({ id: c.id, label: c.label, passed: c.passed, severity: c.severity })),
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter git-check\x1b[0m\n`);

  for (const c of checks) {
    const icon = c.passed ? "\x1b[32m✔\x1b[0m"
      : c.severity === "error" ? "\x1b[31m✖\x1b[0m"
      : c.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[90m·\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
    if (!c.passed && c.hint) printText(`       \x1b[90m→ ${c.hint}\x1b[0m`);
    if (c.files?.length) {
      for (const f of c.files) printText(`       \x1b[90m${f}\x1b[0m`);
    }
    if (c.commits?.length) {
      for (const cm of c.commits) printText(`       \x1b[90m${cm}\x1b[0m`);
    }
  }

  printText("");
  if (allOk && warnings.length === 0) {
    printText(`\x1b[32m✔ Git state is clean and ready.\x1b[0m`);
  } else if (allOk) {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s).\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} issue(s) need attention.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
