#!/usr/bin/env node
/**
 * generate-docs.mjs — Generate command reference MDX from better's --help output.
 *
 * Usage:
 *   node scripts/generate-docs.mjs
 *   node scripts/generate-docs.mjs --dry-run
 *
 * For each command listed in COMMANDS, runs `better <cmd> --help` and converts
 * the help text into a basic MDX file under docs/site/src/content/docs/commands/.
 * Existing hand-authored files are NOT overwritten unless --force is passed.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const OUT_DIR = join(REPO_ROOT, "docs/site/src/content/docs/commands");

const COMMANDS = [
  "install", "add", "remove", "update", "upgrade",
  "audit", "outdated", "why", "doctor",
  "search", "suggest", "context", "mcp", "ai",
  "license", "sbom", "provenance",
  "lock", "scripts", "run", "exec", "shell",
  "init", "workspace", "registry",
  "policy", "firewall", "sandbox",
  "cache", "telemetry", "version",
];

const isDryRun = process.argv.includes("--dry-run");
const isForce  = process.argv.includes("--force");

mkdirSync(OUT_DIR, { recursive: true });

let generated = 0;
let skipped   = 0;

for (const cmd of COMMANDS) {
  const outPath = join(OUT_DIR, `${cmd}.mdx`);

  if (!isForce && existsSync(outPath)) {
    skipped++;
    continue;
  }

  let helpText = "";
  try {
    helpText = execFileSync("node", [join(REPO_ROOT, "src/cli.js"), cmd, "--help"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    helpText = err.stdout || err.message || "";
  }

  if (!helpText.trim()) {
    console.warn(`warn: no help text for '${cmd}', skipping`);
    continue;
  }

  const mdx = helpTextToMdx(cmd, helpText);

  if (isDryRun) {
    console.log(`[dry-run] would write ${outPath} (${mdx.length} bytes)`);
  } else {
    writeFileSync(outPath, mdx, "utf8");
    console.log(`generated: ${outPath}`);
  }
  generated++;
}

console.log(`\nDone. Generated: ${generated}, Skipped (existing): ${skipped}`);

// ---------------------------------------------------------------------------

function helpTextToMdx(cmd, helpText) {
  const lines = helpText.trim().split("\n");
  const title = `better ${cmd}`;

  // Try to extract a description from the first non-empty line after "Usage:"
  let description = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("Usage") && !trimmed.startsWith("better")) {
      description = trimmed.replace(/^[-–•]\s*/, "");
      break;
    }
  }

  // Escape backtick fences in help text
  const escaped = helpText.replace(/`/g, "\\`").replace(/\$/g, "\\$");

  return `---
title: ${title}
description: ${description || `Reference for the ${cmd} command`}
---

## Synopsis

\`\`\`bash
better ${cmd} --help
\`\`\`

## Help

\`\`\`
${helpText.trim()}
\`\`\`

## See Also

- [Command Index](/commands/)
- [better install](/commands/install/)
`;
}
