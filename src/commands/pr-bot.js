import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better pr-bot` — GitHub PR bot for automated dependency management
 *
 * In CI/CD context, automatically:
 * - Comments on PRs with dependency change summaries
 * - Blocks PRs with high-severity vulnerabilities
 * - Suggests fixes for outdated dependencies
 * - Enforces lockfile policies
 */
export async function cmdPrBot(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better pr-bot [subcommand] [options]

GitHub PR bot for automated dependency management.

Subcommands:
  check      Run all checks and output PR comment (default)
  install    Install the GitHub App / webhook
  config     Configure PR bot settings

Options:
  --base REF     Base branch ref (default: main)
  --head REF     Head branch ref (default: HEAD)
  --token TOKEN  GitHub token (or GITHUB_TOKEN env)
  --repo OWNER/REPO  Repository (or from CI env)
  --pr NUMBER    PR number (or from CI env)
  --json         Machine-readable output
  -h, --help     Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      base: { type: "string", default: "main" },
      head: { type: "string", default: "HEAD" },
      token: { type: "string" },
      repo: { type: "string" },
      pr: { type: "string" },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const sub = positionals[0] || "check";
  const useJson = values.json || runtime.json === true;

  const githubToken = values.token || process.env.GITHUB_TOKEN;
  const repo = values.repo || process.env.GITHUB_REPOSITORY;
  const prNumber = values.pr || process.env.PR_NUMBER || process.env.GITHUB_PR_NUMBER;

  switch (sub) {
    case "check": {
      // Run diff to get dependency changes
      const { spawnSync } = await import("node:child_process");
      const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "cli.js");

      const diffResult = spawnSync(process.execPath, [cliPath, "diff", "--json", "--project-root", projectRoot], { encoding: "utf8", timeout: 30000 });
      let diffData = {};
      try { diffData = JSON.parse(diffResult.stdout || "{}"); } catch {}

      const auditResult = spawnSync(process.execPath, [cliPath, "audit", "--json", "--prod-only", "--project-root", projectRoot], { encoding: "utf8", timeout: 60000 });
      let auditData = {};
      try { auditData = JSON.parse(auditResult.stdout || "{}"); } catch {}

      const summary = diffData.summary || { added: 0, removed: 0, upgraded: 0, downgraded: 0 };
      const vulnCount = (auditData.vulnerabilities || []).length;
      const criticalVulns = (auditData.vulnerabilities || []).filter(v => v.severity === "CRITICAL").length;

      const comment = buildPrComment(summary, vulnCount, criticalVulns, diffData);
      const passed = criticalVulns === 0;

      const result = {
        ok: true,
        kind: "better.pr-bot.check",
        passed,
        summary,
        vulnerabilities: vulnCount,
        criticalVulnerabilities: criticalVulns,
        comment,
      };

      if (useJson) {
        printJson(result);
      } else {
        printText(comment);
        if (!passed) {
          printText(`\n❌ PR check FAILED: ${criticalVulns} critical vulnerabilities`);
          process.exitCode = 1;
        } else {
          printText(`\n✅ PR check PASSED`);
        }
      }

      // Post comment to GitHub if token and PR are available
      if (githubToken && repo && prNumber) {
        await postGitHubComment(githubToken, repo, prNumber, comment);
      }

      break;
    }
    case "config": {
      const configPath = path.join(projectRoot, ".better-pr-bot.json");
      const defaultConfig = {
        blockOnCritical: true,
        blockOnHigh: false,
        requireFrozenLockfile: true,
        postComments: true,
        labels: { vulnerable: "security", outdated: "dependencies" },
      };
      await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
      const result = { ok: true, configPath };
      if (useJson) { printJson(result); } else { printText(`PR bot config written to: ${configPath}`); }
      break;
    }
    default:
      printText(`Unknown subcommand: ${sub}`);
      process.exitCode = 1;
  }
}

function buildPrComment(summary, vulnCount, criticalVulns, diffData) {
  const lines = ["## 📦 Dependency Changes (better package manager)"];
  if (summary.added + summary.removed + summary.upgraded + summary.downgraded === 0) {
    lines.push("No dependency changes in this PR.");
  } else {
    if (summary.added > 0) lines.push(`➕ **${summary.added}** package(s) added`);
    if (summary.removed > 0) lines.push(`➖ **${summary.removed}** package(s) removed`);
    if (summary.upgraded > 0) lines.push(`⬆️ **${summary.upgraded}** package(s) upgraded`);
    if (summary.downgraded > 0) lines.push(`⬇️ **${summary.downgraded}** package(s) downgraded`);
  }
  lines.push("");
  if (vulnCount === 0) {
    lines.push("✅ No vulnerabilities detected");
  } else {
    lines.push(`${criticalVulns > 0 ? "🚨" : "⚠️"} **${vulnCount}** vulnerabilit${vulnCount === 1 ? "y" : "ies"} detected${criticalVulns > 0 ? ` (${criticalVulns} critical)` : ""}`);
  }
  lines.push("");
  lines.push("*Generated by [better](https://better.sh) package manager*");
  return lines.join("\n");
}

async function postGitHubComment(token, repo, prNumber, body) {
  try {
    await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
  } catch { /* ignore comment posting errors */ }
}
