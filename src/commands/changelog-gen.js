/**
 * better changelog-gen — generate CHANGELOG.md from git commits
 *
 * Parses conventional commits (feat/fix/chore/docs/refactor/perf/test/ci)
 * and generates or updates CHANGELOG.md with grouped, versioned entries.
 *
 * Usage:
 *   better changelog-gen
 *   better changelog-gen --since v1.0.0
 *   better changelog-gen --version 1.2.0 --write
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const TYPES = {
  feat:     { label: "Features",          emoji: "✨" },
  fix:      { label: "Bug Fixes",         emoji: "🐛" },
  perf:     { label: "Performance",       emoji: "⚡" },
  refactor: { label: "Refactoring",       emoji: "♻️" },
  docs:     { label: "Documentation",     emoji: "📚" },
  test:     { label: "Tests",             emoji: "🧪" },
  ci:       { label: "CI/CD",             emoji: "🔧" },
  chore:    { label: "Chores",            emoji: "🔩" },
  build:    { label: "Build System",      emoji: "🏗️" },
  style:    { label: "Code Style",        emoji: "💅" },
  revert:   { label: "Reverts",           emoji: "⏪" },
};

const COMMIT_RE = /^([a-f0-9]{4,})\s+(\w+)(\(([^)]+)\))?(!)?:\s+(.+)$/;

function parseCommits(log) {
  const commits = [];
  for (const line of log.split("\n")) {
    const m = line.match(COMMIT_RE);
    if (!m) continue;
    const [, hash, type, , scope, breaking, subject] = m;
    commits.push({
      hash,
      type: type.toLowerCase(),
      scope: scope || null,
      breaking: Boolean(breaking),
      subject: subject.trim(),
    });
  }
  return commits;
}

function groupCommits(commits) {
  const groups = {};
  const breaking = [];

  for (const c of commits) {
    if (c.breaking) breaking.push(c);
    const group = groups[c.type] || (groups[c.type] = []);
    group.push(c);
  }

  return { groups, breaking };
}

function formatCommit(c) {
  const scope = c.scope ? `**${c.scope}:** ` : "";
  return `- ${scope}${c.subject} (\`${c.hash}\`)`;
}

function renderMarkdown(version, date, commits) {
  const { groups, breaking } = groupCommits(commits);
  const lines = [];

  lines.push(`## [${version}] — ${date}`);
  lines.push("");

  if (breaking.length > 0) {
    lines.push("### ⚠️ Breaking Changes");
    lines.push("");
    for (const c of breaking) lines.push(formatCommit(c));
    lines.push("");
  }

  const typeOrder = ["feat", "fix", "perf", "refactor", "docs", "test", "ci", "chore", "build", "style", "revert"];
  for (const type of typeOrder) {
    const entries = groups[type];
    if (!entries?.length) continue;
    const info = TYPES[type] || { label: type, emoji: "•" };
    lines.push(`### ${info.emoji} ${info.label}`);
    lines.push("");
    for (const c of entries) lines.push(formatCommit(c));
    lines.push("");
  }

  // Handle unknown types
  for (const [type, entries] of Object.entries(groups)) {
    if (typeOrder.includes(type)) continue;
    lines.push(`### ${type}`);
    lines.push("");
    for (const c of entries) lines.push(formatCommit(c));
    lines.push("");
  }

  return lines.join("\n");
}

function getGitTags(cwd) {
  const result = spawnSync("git", ["tag", "--sort=-version:refname"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.trim().split("\n").filter(Boolean);
}

function getGitLog(cwd, since) {
  const args = ["log", "--oneline", "--no-merges"];
  if (since) args.push(`${since}..HEAD`);
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function getLastTag(cwd) {
  const result = spawnSync("git", ["describe", "--tags", "--abbrev=0"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export async function cmdChangelogGen(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      since:    { type: "string" },
      version:  { type: "string" },
      write:    { type: "boolean", default: false },
      "dry-run":{ type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better changelog-gen [options]

Generate or update CHANGELOG.md from git conventional commits.

Options:
  --since <tag|sha>   Start from this ref (default: last git tag)
  --version <ver>     Version header to use (default: from package.json)
  --write             Write to CHANGELOG.md
  --dry-run           Preview without writing
  --json              Machine-readable output
  -h, --help          Show this help

Conventional commit types recognized:
  feat, fix, perf, refactor, docs, test, ci, chore, build, style, revert
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

  const version = values.version || pkgJson.version || "Unreleased";
  const since = values.since || getLastTag(projectRoot);
  const date = new Date().toISOString().slice(0, 10);

  const log = getGitLog(projectRoot, since);
  if (!log) {
    const msg = since
      ? `No commits found since ${since}`
      : "No commits found";
    if (values.json) {
      printJson({ ok: true, kind: "better.changelog-gen", version, since, commits: 0, markdown: "" });
    } else {
      printText(`\x1b[90m${msg}\x1b[0m`);
    }
    return;
  }

  const commits = parseCommits(log);
  const conventional = commits.filter(c => TYPES[c.type] || c.type);
  const markdown = renderMarkdown(version, date, conventional);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.changelog-gen",
      version,
      since: since || null,
      commits: conventional.length,
      breaking: conventional.filter(c => c.breaking).length,
      markdown,
    });
    return;
  }

  if (!values.write && !values["dry-run"]) {
    // Default: preview to stdout
    printText(`\n\x1b[1mbetter changelog-gen\x1b[0m — ${conventional.length} commit(s) since ${since || "beginning"}\n`);
    printText(markdown);
    printText(`\x1b[90mUse --write to update CHANGELOG.md\x1b[0m`);
    return;
  }

  if (values["dry-run"]) {
    printText(`\x1b[1m[dry-run] Would write to CHANGELOG.md:\x1b[0m\n`);
    printText(markdown);
    return;
  }

  // Write to CHANGELOG.md
  const changelogPath = path.join(projectRoot, "CHANGELOG.md");
  let existing = "";
  try { existing = await fs.readFile(changelogPath, "utf8"); } catch {}

  const header = existing.startsWith("# Changelog")
    ? existing.slice(0, existing.indexOf("\n## ") + 1) || "# Changelog\n\n"
    : "# Changelog\n\nAll notable changes are documented here.\n\n";

  const rest = existing.includes("\n## ")
    ? existing.slice(existing.indexOf("\n## ") + 1)
    : "";

  await fs.writeFile(changelogPath, `${header}${markdown}\n${rest}`, "utf8");
  printText(`\x1b[32m✔ CHANGELOG.md updated\x1b[0m — ${conventional.length} commit(s) added for v${version}`);
}
