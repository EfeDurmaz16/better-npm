/**
 * better module-type — detect and validate module system usage
 *
 * Analyzes your project to determine whether it uses CommonJS, ESM,
 * or mixed module formats, and validates consistency with package.json
 * "type" field and exports map.
 *
 * Usage:
 *   better module-type
 *   better module-type --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const ESM_PATTERNS = [
  /\bimport\s+(?:\*\s+as\s+\w+|\{[^}]*\}|\w+)\s+from\s+['"][^'"]+['"]/,
  /\bexport\s+(?:default|const|let|var|function|class|async|\{)/,
  /\bexport\s*\{[^}]*\}/,
];
const CJS_PATTERNS = [
  /\brequire\s*\(\s*['"][^'"]+['"]\s*\)/,
  /\bmodule\.exports\s*=/,
  /\bexports\.\w+\s*=/,
  /\b__dirname\b/,
  /\b__filename\b/,
];

function detectModuleType(content) {
  const hasESM = ESM_PATTERNS.some(p => p.test(content));
  const hasCJS = CJS_PATTERNS.some(p => p.test(content));
  if (hasESM && hasCJS) return "mixed";
  if (hasESM) return "esm";
  if (hasCJS) return "cjs";
  return "unknown";
}

async function scanSourceFiles(dir, exts, maxFiles = 50) {
  const results = { esm: 0, cjs: 0, mixed: 0, unknown: 0, files: [] };
  let count = 0;

  async function walk(d) {
    if (count >= maxFiles) return;
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count >= maxFiles) return;
      const full = path.join(d, e.name);
      if (e.isSymlink()) continue;
      if (e.isDirectory()) {
        if (["node_modules", ".git", "dist", "build", "coverage"].includes(e.name)) continue;
        await walk(full);
      } else if (e.isFile() && exts.some(ext => e.name.endsWith(ext))) {
        try {
          const content = await fs.readFile(full, "utf8");
          const type = detectModuleType(content);
          results[type]++;
          results.files.push({ path: full, type });
          count++;
        } catch {}
      }
    }
  }
  await walk(dir);
  return results;
}

export async function cmdModuleType(argv) {
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
    printText(`Usage: better module-type [options]

Detect and validate module system usage (CJS vs ESM).

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • package.json "type" field (commonjs/module)
  • Source file import/export patterns
  • Consistency between file extensions and module format
  • Mixed module usage warnings
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter module-type\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const declaredType = pkgJson.type || "commonjs";
  const hasExports = !!pkgJson.exports;
  const hasMain = !!pkgJson.main;
  const hasModule = !!pkgJson.module;

  const checks = [];
  checks.push({ ok: true, label: `Declared type: ${declaredType} (package.json "type": "${pkgJson.type || "unset (defaults to commonjs)"}")` });
  if (hasExports) checks.push({ ok: true, label: "exports map defined (modern resolution)" });
  if (hasMain && !hasExports) checks.push({ ok: null, label: `main field: ${pkgJson.main} (consider adding exports map)` });
  if (hasModule) checks.push({ ok: null, label: `module field: ${pkgJson.module} (bundler-only, not Node.js)` });

  // Scan source files
  const jsExts = [".js", ".mjs", ".cjs"];
  const scanResult = await scanSourceFiles(projectRoot, jsExts, 100);
  const totalFiles = scanResult.esm + scanResult.cjs + scanResult.mixed;

  if (totalFiles > 0) {
    const esmPct = Math.round(scanResult.esm / totalFiles * 100);
    const cjsPct = Math.round(scanResult.cjs / totalFiles * 100);
    const detectedType = scanResult.esm > scanResult.cjs ? "esm" : scanResult.cjs > scanResult.esm ? "commonjs" : "mixed";

    const typeMatch = detectedType === declaredType || (detectedType === "esm" && declaredType === "module");
    checks.push({
      ok: typeMatch || scanResult.mixed === 0,
      label: `Source analysis: ${esmPct}% ESM, ${cjsPct}% CJS${scanResult.mixed > 0 ? `, ${scanResult.mixed} mixed files` : ""}`,
    });

    if (scanResult.mixed > 0) {
      checks.push({ ok: false, label: `${scanResult.mixed} file(s) use both ESM and CJS syntax (potential issues)` });
    }

    // Check .mjs/.cjs consistency
    const hasMjsFiles = scanResult.files.some(f => f.path.endsWith(".mjs"));
    const hasCjsFiles = scanResult.files.some(f => f.path.endsWith(".cjs"));
    if (hasMjsFiles && hasCjsFiles) {
      checks.push({ ok: null, label: "Both .mjs and .cjs files present (intentional dual-format)" });
    }
  }

  const ok = checks.every(c => c.ok !== false);

  if (values.json) {
    printJson({ ok, kind: "better.module-type", declaredType, checks, scanResult: { ...scanResult, files: undefined } });
    return;
  }

  for (const c of checks) {
    const icon = c.ok === true ? "\x1b[32m✔\x1b[0m" : c.ok === false ? "\x1b[31m✘\x1b[0m" : "\x1b[33m·\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
  }
  printText("");
}
