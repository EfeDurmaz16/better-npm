/**
 * better npm-token — manage and audit npm authentication tokens
 *
 * Lists, validates, and audits npm auth tokens in .npmrc files.
 * Detects exposed tokens, checks registry connectivity, and
 * provides token rotation guidance.
 *
 * Usage:
 *   better npm-token
 *   better npm-token --check
 *   better npm-token --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const TOKEN_PATTERNS = [
  { re: /^\/\/([^/:]+)\/:_authToken\s*=\s*(.+)$/, label: "authToken" },
  { re: /^\/\/([^/:]+)\/:_auth\s*=\s*(.+)$/, label: "auth (base64)" },
  { re: /^\/\/([^/:]+)\/:username\s*=\s*(.+)$/, label: "username" },
  { re: /^\/\/([^/:]+)\/:_password\s*=\s*(.+)$/, label: "password" },
];

function maskToken(token) {
  if (!token || token.length < 8) return "***";
  return token.slice(0, 4) + "…" + token.slice(-4);
}

function isPlaceholder(token) {
  return /\$\{|%[A-Z]|<[A-Z]|YOUR_|REPLACE|TODO|xxx/i.test(token);
}

async function readNpmrc(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.split("\n");
  } catch {
    return null;
  }
}

function parseNpmrc(lines, filePath) {
  const tokens = [];
  if (!lines) return tokens;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;
    for (const { re, label } of TOKEN_PATTERNS) {
      const m = trimmed.match(re);
      if (m) {
        tokens.push({
          registry: m[1],
          type: label,
          value: m[2].trim(),
          masked: maskToken(m[2].trim()),
          placeholder: isPlaceholder(m[2].trim()),
          source: filePath,
        });
      }
    }
  }
  return tokens;
}

export async function cmdNpmToken(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      check: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better npm-token [options]

Audit npm authentication tokens in .npmrc files.

Options:
  --check      Verify token validity against registry (npm whoami)
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Project .npmrc tokens
  • Global ~/.npmrc tokens
  • Detects plaintext vs environment variable tokens
  • Optionally verifies token validity
`);
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter npm-token\x1b[0m\n`);
  }

  const cwd = process.cwd();
  const projectNpmrc = path.join(cwd, ".npmrc");
  const globalNpmrc = path.join(os.homedir(), ".npmrc");

  const projectLines = await readNpmrc(projectNpmrc);
  const globalLines = await readNpmrc(globalNpmrc);

  const projectTokens = parseNpmrc(projectLines, ".npmrc");
  const globalTokens = parseNpmrc(globalLines, "~/.npmrc");
  const allTokens = [...projectTokens, ...globalTokens];

  const issues = [];

  // Check for real tokens in project .npmrc (should use env vars)
  for (const tok of projectTokens) {
    if (!tok.placeholder && tok.type === "authToken") {
      issues.push({
        severity: "warning",
        message: `Real token in project .npmrc for ${tok.registry}`,
        hint: "Use environment variable: //registry.npmjs.org/:_authToken=${NPM_TOKEN}",
        source: tok.source,
      });
    }
  }

  // Check for .npmrc being tracked in git
  try {
    const gitResult = spawnSync("git", ["ls-files", "--error-unmatch", ".npmrc"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (gitResult.status === 0 && projectTokens.length > 0) {
      issues.push({
        severity: "error",
        message: ".npmrc with tokens is tracked by git — tokens may be exposed",
        hint: "Add .npmrc to .gitignore and remove from git history",
      });
    }
  } catch {}

  // Optional: check token validity
  let whoami = null;
  if (values.check) {
    const result = spawnSync("npm", ["whoami"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    whoami = result.status === 0 ? result.stdout?.trim() : null;
    if (!whoami && allTokens.filter(t => !t.placeholder).length > 0) {
      issues.push({
        severity: "warning",
        message: "Token found but npm whoami failed — token may be invalid or expired",
        hint: "Run: npm login to refresh token",
      });
    }
  }

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.npm-token",
      tokens: allTokens.map(t => ({ registry: t.registry, type: t.type, masked: t.masked, placeholder: t.placeholder, source: t.source })),
      whoami,
      issues,
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  if (allTokens.length === 0) {
    printText(`  \x1b[90mNo tokens found in .npmrc files.\x1b[0m\n`);
  } else {
    printText(`  \x1b[90mTokens found:\x1b[0m`);
    for (const tok of allTokens) {
      const pl = tok.placeholder ? " \x1b[90m(env var)\x1b[0m" : ` \x1b[33m${tok.masked}\x1b[0m`;
      printText(`    ${tok.source}  \x1b[90m${tok.registry}\x1b[0m  ${tok.type}${pl}`);
    }
  }

  if (whoami !== null) {
    printText(`\n  npm whoami: ${whoami ? `\x1b[32m${whoami}\x1b[0m` : "\x1b[31mnot logged in\x1b[0m"}`);
  }

  if (issues.length > 0) {
    printText("");
    for (const iss of issues) {
      const icon = iss.severity === "error" ? "\x1b[31m✖\x1b[0m" : "\x1b[33m⚠\x1b[0m";
      printText(`  ${icon}  ${iss.message}`);
      if (iss.hint) printText(`       \x1b[90m→ ${iss.hint}\x1b[0m`);
    }
  }

  printText("");
  if (allOk && warnings.length === 0) {
    printText(`\x1b[32m✔ Token configuration looks safe.\x1b[0m`);
  } else if (allOk) {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s).\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} security issue(s) found.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
