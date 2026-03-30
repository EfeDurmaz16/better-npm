/**
 * better files-check — audit the "files" field in package.json
 *
 * Checks which files would be included in an npm publish based on
 * the "files" field, .npmignore, and .gitignore. Reports what would
 * be published and warns about accidental inclusions.
 *
 * Usage:
 *   better files-check
 *   better files-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const SENSITIVE_PATTERNS = [
  /\.env$/,
  /\.env\.\w+$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa/,
  /id_ed25519/,
  /secrets?\./i,
  /credentials?\./i,
  /password/i,
  /private[-_]?key/i,
];

async function walk(dir, rel = "", results = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walk(path.join(dir, e.name), relPath, results);
    } else {
      results.push(relPath);
    }
  }
  return results;
}

function matchesPattern(filePath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some(p => {
    const normalized = p.replace(/^\//, "").replace(/\/$/, "");
    if (filePath === normalized) return true;
    if (filePath.startsWith(normalized + "/")) return true;
    const parts = filePath.split("/");
    return parts.some(part => part === normalized);
  });
}

function fmtBytes(b) {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

export async function cmdFilesCheck(argv) {
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
    printText(`Usage: better files-check [options]

Audit the "files" field and publish surface of your package.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Whether a "files" allowlist exists
  • Sensitive files that might be accidentally published
  • Estimated publish size
  • .npmignore presence
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter files-check\x1b[0m\n`);
  }

  let pkgJson = {};
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const checks = [];
  const warnings = [];

  // Check files field
  const hasFilesField = Array.isArray(pkgJson.files) && pkgJson.files.length > 0;
  checks.push({
    name: "files-allowlist",
    ok: hasFilesField,
    message: hasFilesField
      ? `"files" field present: ${pkgJson.files.join(", ")}`
      : `No "files" field — entire package will be published (minus .npmignore)`,
  });

  // Check .npmignore
  let hasNpmIgnore = false;
  try { await fs.access(path.join(projectRoot, ".npmignore")); hasNpmIgnore = true; } catch {}
  checks.push({
    name: "npmignore",
    ok: hasFilesField || hasNpmIgnore,
    message: hasNpmIgnore
      ? ".npmignore found"
      : hasFilesField
        ? "No .npmignore (using files field instead)"
        : "No .npmignore and no files field",
  });

  // Walk project files (shallow, limited depth)
  const allFiles = await walk(projectRoot);
  const sensitiveFiles = allFiles.filter(f =>
    SENSITIVE_PATTERNS.some(pattern => pattern.test(path.basename(f)))
  );

  // Check if sensitive files would be published
  const wouldPublish = hasFilesField
    ? sensitiveFiles.filter(f => matchesPattern(f, pkgJson.files))
    : sensitiveFiles;

  if (wouldPublish.length > 0) {
    for (const f of wouldPublish) {
      warnings.push(`Sensitive file may be published: ${f}`);
    }
    checks.push({ name: "sensitive-files", ok: false, message: `${wouldPublish.length} sensitive file(s) might be published` });
  } else {
    checks.push({ name: "sensitive-files", ok: true, message: "No sensitive files detected in publish surface" });
  }

  // Estimate publish surface size
  let totalSize = 0;
  const filesToCount = hasFilesField
    ? allFiles.filter(f => matchesPattern(f, pkgJson.files))
    : allFiles.filter(f => !f.startsWith(".git/") && f !== ".git");
  const BATCH = 20;
  for (let i = 0; i < filesToCount.length; i += BATCH) {
    await Promise.all(filesToCount.slice(i, i + BATCH).map(async (f) => {
      try {
        const stat = await fs.stat(path.join(projectRoot, f));
        totalSize += stat.size;
      } catch {}
    }));
  }

  const ok = checks.every(c => c.ok);

  if (values.json) {
    printJson({
      ok,
      kind: "better.files-check",
      package: pkgJson.name,
      hasFilesField,
      hasNpmIgnore,
      estimatedFiles: filesToCount.length,
      estimatedSize: totalSize,
      warnings,
      checks,
    });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const c of checks) {
    const icon = c.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    printText(`  ${icon}  ${c.message}`);
  }

  if (warnings.length > 0) {
    printText("");
    for (const w of warnings) {
      printText(`  \x1b[33m⚠  ${w}\x1b[0m`);
    }
  }

  printText(`\n  Estimated publish surface: \x1b[1m${filesToCount.length} files\x1b[0m, ~${fmtBytes(totalSize)}`);
  printText("");

  if (!ok) {
    process.exitCode = 1;
  }
}
