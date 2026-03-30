/**
 * better changelog-gen — generate a CHANGELOG entry from git log
 *
 * Reads git commit messages since the last tag and generates a formatted
 * CHANGELOG.md entry following Keep a Changelog conventions.
 *
 * Usage:
 *   better changelog-gen
 *   better changelog-gen --since v1.0.0
 *   better changelog-gen --output CHANGELOG.md
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000, cwd });
  return r.status === 0 ? r.stdout.trim() : null;
}

function categorize(message) {
  const lower = message.toLowerCase();
  if (/^feat(\(.*\))?[!:]/.test(message) || lower.startsWith("add ") || lower.startsWith("new ")) return "Added";
  if (/^fix(\(.*\))?[!:]/.test(message) || lower.startsWith("fix")) return "Fixed";
  if (/^(refactor|perf|style)(\(.*\))?[!:]/.test(message)) return "Changed";
  if (/^(remove|revert|delete)(\(.*\))?[!:]/.test(message) || lower.startsWith("remov") || lower.startsWith("delet")) return "Removed";
  if (/^(docs|doc)(\(.*\))?[!:]/.test(message)) return "Changed";
  if (/^(test|ci|chore|build)(\(.*\))?[!:]/.test(message)) return null; // skip
  if (/breaking/i.test(message)) return "Breaking";
  return "Changed";
}

function cleanMessage(message) {
  // Remove conventional commit prefix
  return message.replace(/^(feat|fix|refactor|perf|style|docs|test|ci|chore|build|revert|remove)(\(.*?\))?!?:\s*/i, "");
}

export async function cmdChangelogGen(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      since:   { type: "string" },
      output:  { type: "string", short: "o" },
      version: { type: "string", short: "v" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better changelog-gen [options]

Generate a CHANGELOG entry from git commit history.

Options:
  --since <ref>    Start from this tag/commit (default: last tag)
  --version <v>    Version for the new entry (default: next minor bump)
  -o, --output <f> Append to this file (default: stdout)
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better changelog-gen
  better changelog-gen --since v1.2.0 --version 1.3.0
  better changelog-gen --output CHANGELOG.md
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter changelog-gen\x1b[0m\n`);
  }

  // Get last tag
  const lastTag = values.since || run("git", ["describe", "--tags", "--abbrev=0"], projectRoot);
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";

  // Get commits
  const logOutput = run("git", ["log", range, "--pretty=format:%H|%s|%an", "--no-merges"], projectRoot);
  if (!logOutput) {
    const msg = "No git commits found (or not a git repository)";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`  \x1b[90m${msg}\x1b[0m\n`); }
    return;
  }

  const commits = logOutput.split("\n").filter(Boolean).map(line => {
    const [hash, subject, author] = line.split("|");
    return { hash: hash?.slice(0, 7), subject, author };
  });

  // Categorize
  const categories = { Breaking: [], Added: [], Changed: [], Fixed: [], Removed: [] };
  let skipped = 0;
  for (const c of commits) {
    const cat = categorize(c.subject || "");
    if (!cat) { skipped++; continue; }
    const msg = cleanMessage(c.subject || "");
    if (msg) categories[cat].push({ message: msg, hash: c.hash, author: c.author });
  }

  // Determine version
  let version = values.version;
  if (!version) {
    let pkgJson = {};
    try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}
    const current = pkgJson.version || "0.0.0";
    const parts = current.split(".").map(Number);
    parts[1] = (parts[1] || 0) + 1;
    parts[2] = 0;
    version = parts.join(".");
  }

  const date = new Date().toISOString().slice(0, 10);
  const totalChanges = Object.values(categories).reduce((s, a) => s + a.length, 0);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.changelog-gen",
      version,
      date,
      since: lastTag || "(beginning)",
      totalCommits: commits.length,
      categorized: totalChanges,
      skipped,
      categories,
    });
    return;
  }

  // Generate markdown
  const lines = [];
  lines.push(`## [${version}] - ${date}`);
  lines.push("");

  if (lastTag) {
    lines.push(`> Changes since ${lastTag}`);
    lines.push("");
  }

  for (const [cat, items] of Object.entries(categories)) {
    if (items.length === 0) continue;
    lines.push(`### ${cat}`);
    lines.push("");
    for (const item of items) {
      lines.push(`- ${item.message} (${item.hash})`);
    }
    lines.push("");
  }

  if (totalChanges === 0) {
    lines.push("_No notable changes._");
    lines.push("");
  }

  const entry = lines.join("\n");

  if (values.output) {
    const outputPath = path.resolve(projectRoot, values.output);
    try {
      let existing = "";
      try { existing = await fs.readFile(outputPath, "utf8"); } catch {}
      // Insert after first line (# Changelog header) if exists
      const headerMatch = existing.match(/^(#[^\n]*\n\n?)/);
      const newContent = headerMatch
        ? existing.slice(0, headerMatch[0].length) + entry + "\n" + existing.slice(headerMatch[0].length)
        : entry + "\n\n" + existing;
      await fs.writeFile(outputPath, newContent);
      printText(`  \x1b[32m✔\x1b[0m  Wrote changelog entry to ${values.output}`);
    } catch (e) {
      printText(`  \x1b[31m✘\x1b[0m  Cannot write to ${values.output}: ${e.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    printText(entry);
  }

  printText(`  \x1b[90mSince: ${lastTag || "(beginning)"}  |  Changes: ${totalChanges}  |  Skipped: ${skipped}\x1b[0m\n`);
}
