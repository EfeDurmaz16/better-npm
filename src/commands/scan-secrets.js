/**
 * better scan-secrets — scan source files for potential secret leaks
 *
 * Detects API keys, tokens, passwords, and other credentials
 * that might have been accidentally committed to source code.
 *
 * Usage:
 *   better scan-secrets
 *   better scan-secrets src/
 *   better scan-secrets --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Secret detection patterns
const SECRET_PATTERNS = [
  { id: "aws-key",         re: /(?:^|[^a-zA-Z0-9])(AKIA[0-9A-Z]{16})(?:[^a-zA-Z0-9]|$)/,       label: "AWS Access Key ID",      severity: "error" },
  { id: "aws-secret",      re: /aws.{0,20}(?:secret|key).{0,10}['"]([a-zA-Z0-9/+]{40})['"]/i,    label: "AWS Secret Key",          severity: "error" },
  { id: "github-token",    re: /(?:github|gh)[_-]?(?:token|pat|key).{0,5}['"]([a-zA-Z0-9_]{36,})['"]/i, label: "GitHub Token",     severity: "error" },
  { id: "private-key",     re: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,                   label: "Private Key",             severity: "error" },
  { id: "npm-token",       re: /(?:^|[^a-zA-Z0-9])(npm_[a-zA-Z0-9]{36})(?:[^a-zA-Z0-9]|$)/,     label: "npm Token",               severity: "error" },
  { id: "stripe-key",      re: /(?:sk_live_|pk_live_)[a-zA-Z0-9]{24,}/,                           label: "Stripe Live Key",         severity: "error" },
  { id: "twilio-token",    re: /AC[a-zA-Z0-9]{32}/,                                               label: "Twilio Account SID",      severity: "warning" },
  { id: "sendgrid-key",    re: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/,                       label: "SendGrid API Key",        severity: "error" },
  { id: "slack-token",     re: /xox[baprs]-[a-zA-Z0-9-]{10,}/,                                    label: "Slack Token",             severity: "error" },
  { id: "generic-secret",  re: /(?:password|passwd|secret|api_key|apikey|auth_token)\s*[:=]\s*['"]([^'"]{8,})['"]/i, label: "Generic Secret", severity: "warning" },
  { id: "jwt",             re: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/,          label: "JWT Token",               severity: "warning" },
  { id: "connection-str",  re: /(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@[^\s"']+/i,      label: "Database Connection String", severity: "error" },
  { id: "hex-secret",      re: /(?:secret|token|key)\s*[:=]\s*['"]([0-9a-f]{32,64})['"]/i,       label: "Hex Secret/Key",          severity: "warning" },
];

const SAFE_PATTERNS = [
  /\$\{[^}]+\}/,    // template variables
  /process\.env\./,  // env var references
  /placeholder/i,
  /your[-_]?(?:api[-_]?key|secret|token)/i,
  /example/i,
  /TODO/i,
  /<[A-Z_]+>/,      // <YOUR_KEY> style
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache"]);
const TEXT_EXT = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".json", ".env", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".go",
  ".txt", ".md", ".html", ".css",
]);

async function collectFiles(dir) {
  const files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      // Skip .env files unless explicitly looking for secrets
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        files.push(...(await collectFiles(full)));
      } else if (e.isFile() && (TEXT_EXT.has(path.extname(e.name)) || e.name.startsWith(".env"))) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}

function isSafeLine(line) {
  return SAFE_PATTERNS.some(p => p.test(line));
}

export async function cmdScanSecrets(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      strict: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better scan-secrets [dirs...] [options]

Scan source files for accidentally committed secrets.

Detects:
  AWS keys, GitHub tokens, npm tokens, Stripe keys
  Private keys, JWTs, connection strings
  Generic password/secret/api_key patterns

Options:
  --strict     Also report warnings (not just errors)
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better scan-secrets
  better scan-secrets src/ config/
  better scan-secrets --strict
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const searchDirs = positionals.length > 0
    ? positionals.map(d => path.isAbsolute(d) ? d : path.join(cwd, d))
    : [projectRoot];

  if (!values.json) {
    process.stderr.write(`\x1b[90mScanning for secrets…\x1b[0m\n`);
  }

  let allFiles = [];
  for (const dir of searchDirs) {
    allFiles.push(...(await collectFiles(dir)));
  }
  allFiles = [...new Set(allFiles)];

  const findings = [];

  for (const file of allFiles) {
    let content;
    try { content = await fs.readFile(file, "utf8"); } catch { continue; }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip comment lines
      const stripped = line.trim();
      if (stripped.startsWith("//") || stripped.startsWith("#") || stripped.startsWith("*")) continue;
      if (isSafeLine(line)) continue;

      for (const pattern of SECRET_PATTERNS) {
        if (!values.strict && pattern.severity === "warning") continue;
        if (pattern.re.test(line)) {
          findings.push({
            file: path.relative(projectRoot, file),
            line: i + 1,
            pattern: pattern.id,
            label: pattern.label,
            severity: pattern.severity,
            // Redact the actual value
            snippet: line.slice(0, 80).replace(/['"][^'"]{6,}['"]/g, (m) => {
              const inner = m.slice(1, -1);
              if (inner.length > 8) return `'${inner.slice(0, 4)}***${inner.slice(-2)}'`;
              return "'***'";
            }).trim(),
          });
          break; // Only report first match per line
        }
      }
    }
  }

  const errors = findings.filter(f => f.severity === "error");
  const warnings = findings.filter(f => f.severity === "warning");
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.scan-secrets",
      filesScanned: allFiles.length,
      findings: findings.length,
      errors: errors.length,
      warnings: warnings.length,
      results: findings,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter scan-secrets\x1b[0m — ${allFiles.length} files scanned\n`);

  if (findings.length === 0) {
    printText(`\x1b[32m✔ No secrets found.\x1b[0m\n`);
    return;
  }

  // Group by file
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  for (const [file, items] of byFile) {
    printText(`  \x1b[1m${file}\x1b[0m`);
    for (const item of items) {
      const col = item.severity === "error" ? "\x1b[31m" : "\x1b[33m";
      printText(`    ${col}→ Line ${item.line}: ${item.label}\x1b[0m`);
      printText(`      \x1b[90m${item.snippet}\x1b[0m`);
    }
  }

  printText("");
  if (errors.length > 0) {
    printText(`\x1b[31m✖ ${errors.length} potential secret(s) found! Review and rotate affected credentials.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\x1b[33m⚠ ${warnings.length} potential secret(s) found (low confidence). Review them.\x1b[0m`);
  }
  printText("");
}
