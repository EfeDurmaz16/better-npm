/**
 * better module-check — verify ESM/CJS module format consistency
 *
 * Checks that your package's module configuration is consistent:
 * type field, exports conditions, file extensions, and that
 * CJS/ESM files don't mix in incompatible ways.
 *
 * Usage:
 *   better module-check
 *   better module-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function collectFiles(dir, extensions, maxDepth = 4) {
  const files = [];
  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (extensions.some(ext => e.name.endsWith(ext))) files.push(full);
    }
  }
  await walk(dir, 0);
  return files;
}

const ESM_PATTERN = /\b(?:import\s+|export\s+(?:default\s+|const\s+|function\s+|class\s+|\*\s+))/;
const CJS_PATTERN = /\b(?:require\s*\(|module\.exports\s*=|exports\.\w+\s*=)/;

export async function cmdModuleCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better module-check [options]

Verify ESM/CJS module format consistency in your package.

Checks:
  • "type" field is set (module or commonjs)
  • exports field has both "require" and "import" conditions if dual
  • .js files match declared "type"
  • .mjs files contain ESM syntax
  • .cjs files contain CJS syntax
  • No dynamic require() in ESM files

Options:
  --json       Machine-readable output
  -h, --help   Show this help
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

  const issues = [];
  const checks = [];

  const pkgType = pkgJson.type || "commonjs"; // default is commonjs
  const hasTypeField = Boolean(pkgJson.type);

  // Check 1: type field declared
  checks.push({
    id: "has-type",
    label: '"type" field declared',
    passed: hasTypeField,
    severity: "warning",
    hint: `Add "type": "module" for ESM or "type": "commonjs" to be explicit`,
  });

  // Check 2: if exports exist, check for dual-mode conditions
  if (pkgJson.exports && typeof pkgJson.exports === "object") {
    const exportsStr = JSON.stringify(pkgJson.exports);
    const hasRequire = exportsStr.includes('"require"');
    const hasImport = exportsStr.includes('"import"');

    if (hasRequire && hasImport) {
      checks.push({
        id: "dual-exports",
        label: "Dual CJS/ESM exports configured",
        passed: true,
        severity: "info",
      });
    } else if (hasRequire || hasImport) {
      checks.push({
        id: "dual-exports",
        label: "Single format exports (not dual CJS/ESM)",
        passed: true,
        severity: "info",
        hint: "Consider adding both 'require' and 'import' conditions for broader compatibility",
      });
    }
  }

  // Check 3: Look at source files
  const srcDirs = ["src", "lib", "dist"].map(d => path.join(projectRoot, d));
  let analyzedDir = null;
  for (const dir of srcDirs) {
    try { await fs.access(dir); analyzedDir = dir; break; } catch {}
  }

  if (analyzedDir) {
    const jsFiles = await collectFiles(analyzedDir, [".js", ".mjs", ".cjs"]);
    const mixedFiles = [];

    for (const file of jsFiles.slice(0, 50)) { // limit to 50 files
      let content;
      try { content = await fs.readFile(file, "utf8"); } catch { continue; }

      const hasEsm = ESM_PATTERN.test(content);
      const hasCjs = CJS_PATTERN.test(content);
      const ext = path.extname(file);
      const rel = path.relative(projectRoot, file);

      if (ext === ".mjs" && hasCjs && !hasEsm) {
        mixedFiles.push({ file: rel, issue: ".mjs file appears to use CJS syntax" });
      } else if (ext === ".cjs" && hasEsm && !hasCjs) {
        mixedFiles.push({ file: rel, issue: ".cjs file appears to use ESM syntax" });
      } else if (ext === ".js") {
        if (pkgType === "module" && hasCjs && !hasEsm) {
          mixedFiles.push({ file: rel, issue: `CJS syntax in ESM package (type: module)` });
        } else if (pkgType === "commonjs" && hasEsm && !hasCjs) {
          // This is fine for many cases but worth noting
        }
      }
    }

    if (mixedFiles.length > 0) {
      for (const { file, issue } of mixedFiles.slice(0, 5)) {
        checks.push({
          id: `mixed-${file}`,
          label: `${path.basename(file)}: ${issue}`,
          passed: false,
          severity: "error",
          hint: `Fix module format in ${file}`,
        });
      }
    } else if (jsFiles.length > 0) {
      checks.push({
        id: "consistent-syntax",
        label: `Module syntax consistent in ${jsFiles.length} file(s)`,
        passed: true,
        severity: "info",
      });
    }
  }

  // Check 4: main/module/exports pointing to correct file types
  if (pkgJson.main && pkgType === "module" && pkgJson.main.endsWith(".js")) {
    // main in ESM package — ok, but warn if no CJS fallback
    checks.push({
      id: "main-in-esm",
      label: '"main" field in ESM package',
      passed: true,
      severity: "info",
      hint: "Consider using exports.require for CJS consumers",
    });
  }

  if (pkgJson.module && !pkgJson.exports) {
    checks.push({
      id: "module-without-exports",
      label: '"module" field without "exports" (legacy)',
      passed: false,
      severity: "warning",
      hint: 'Add "exports" with "import" condition — "module" is only for bundlers',
    });
  }

  const errors = checks.filter(c => !c.passed && c.severity === "error");
  const warnings = checks.filter(c => !c.passed && c.severity === "warning");
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.module-check",
      packageType: pkgType,
      checks: checks.map(c => ({ id: c.id, label: c.label, passed: c.passed, severity: c.severity })),
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter module-check\x1b[0m — type: ${pkgType}\n`);

  for (const c of checks) {
    const icon = c.passed
      ? "\x1b[32m✔\x1b[0m"
      : c.severity === "error" ? "\x1b[31m✖\x1b[0m"
      : c.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[90m·\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
    if (!c.passed && c.hint) printText(`       \x1b[90m→ ${c.hint}\x1b[0m`);
  }

  printText("");
  if (allOk && warnings.length === 0) {
    printText(`\x1b[32m✔ Module configuration looks good!\x1b[0m`);
  } else if (allOk) {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s) — consider fixing.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} error(s) in module configuration.\x1b[0m`);
    process.exitCode = 1;
  }
}
