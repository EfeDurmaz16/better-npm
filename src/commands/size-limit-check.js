/**
 * better size-limit-check — check bundle/install size limits
 *
 * Reads size limits from package.json or a config file and verifies
 * the actual install/pack size stays within defined thresholds.
 * Useful for CI to prevent accidental bloat.
 *
 * Usage:
 *   better size-limit-check
 *   better size-limit-check --limit 5mb
 *   better size-limit-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parseSize(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().trim();
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  if (s.endsWith("gb")) return num * 1024 * 1024 * 1024;
  if (s.endsWith("mb")) return num * 1024 * 1024;
  if (s.endsWith("kb")) return num * 1024;
  if (s.endsWith("b")) return num;
  return num; // assume bytes
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function getDirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await getDirSize(p);
      else if (e.isFile()) { try { total += (await fs.stat(p)).size; } catch {} }
    }
  } catch {}
  return total;
}

async function getPackSize(projectRoot) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.status !== 0) return null;

  try {
    const data = JSON.parse(result.stdout);
    const entry = Array.isArray(data) ? data[0] : data;
    return entry?.unpackedSize || null;
  } catch { return null; }
}

export async function cmdSizeLimitCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      limit:      { type: "string" },
      "pack-limit":     { type: "string" },
      "install-limit":  { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better size-limit-check [options]

Check that package and install sizes stay within limits.

Limits can be set via:
  - CLI options below
  - package.json "better" config: { "sizeLimit": { "pack": "5mb", "install": "50mb" } }

Options:
  --limit <size>          Combined limit (applies to pack size)
  --pack-limit <size>     Max packed size (npm pack output)
  --install-limit <size>  Max node_modules size
  --json                  Machine-readable output
  -h, --help              Show this help

Size formats: 5mb, 500kb, 1gb, 1024 (bytes)

Examples:
  better size-limit-check --limit 10mb
  better size-limit-check --pack-limit 2mb --install-limit 100mb
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

  // Read limits from config or CLI
  const betterConfig = pkgJson.better?.sizeLimit || {};
  const packLimitStr = values["pack-limit"] || values.limit || betterConfig.pack || null;
  const installLimitStr = values["install-limit"] || betterConfig.install || null;

  const packLimit = parseSize(packLimitStr);
  const installLimit = parseSize(installLimitStr);

  if (!packLimit && !installLimit) {
    printText(`\x1b[33m⚠ No size limits configured.\x1b[0m`);
    printText(`\nSet limits with --limit, --pack-limit, --install-limit, or in package.json:`);
    printText(`\x1b[90m{\n  "better": {\n    "sizeLimit": { "pack": "5mb", "install": "100mb" }\n  }\n}\x1b[0m`);
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mMeasuring package sizes…\x1b[0m\n`);
  }

  const checks = [];

  // Pack size check
  if (packLimit) {
    const packSize = await getPackSize(projectRoot);
    if (packSize !== null) {
      const passed = packSize <= packLimit;
      checks.push({
        id: "pack-size",
        label: `Pack size: ${fmtBytes(packSize)} (limit: ${fmtBytes(packLimit)})`,
        actualSize: packSize,
        limit: packLimit,
        passed,
        severity: passed ? "info" : "error",
        hint: passed ? "" : `Pack size exceeds limit by ${fmtBytes(packSize - packLimit)}`,
      });
    } else {
      checks.push({
        id: "pack-size",
        label: "Pack size: could not determine",
        passed: false,
        severity: "warning",
        hint: "Run in a project with a valid package.json",
      });
    }
  }

  // Install size check
  if (installLimit) {
    const nmPath = path.join(projectRoot, "node_modules");
    const nmSize = await getDirSize(nmPath);
    if (nmSize > 0) {
      const passed = nmSize <= installLimit;
      checks.push({
        id: "install-size",
        label: `Install size: ${fmtBytes(nmSize)} (limit: ${fmtBytes(installLimit)})`,
        actualSize: nmSize,
        limit: installLimit,
        passed,
        severity: passed ? "info" : "error",
        hint: passed ? "" : `Install size exceeds limit by ${fmtBytes(nmSize - installLimit)}`,
      });
    } else {
      checks.push({
        id: "install-size",
        label: "Install size: node_modules not found",
        passed: false,
        severity: "warning",
        hint: "Run npm install first",
      });
    }
  }

  const errors = checks.filter(c => !c.passed && c.severity === "error");
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.size-limit-check",
      checks: checks.map(c => ({ id: c.id, label: c.label, passed: c.passed, severity: c.severity, actualSize: c.actualSize, limit: c.limit })),
      errors: errors.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter size-limit-check\x1b[0m\n`);

  for (const c of checks) {
    const icon = c.passed ? "\x1b[32m✔\x1b[0m"
      : c.severity === "error" ? "\x1b[31m✖\x1b[0m"
      : "\x1b[33m⚠\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
    if (c.hint) printText(`       \x1b[90m→ ${c.hint}\x1b[0m`);
  }

  printText("");
  if (allOk) {
    printText(`\x1b[32m✔ All size limits met.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} size limit(s) exceeded.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
