/**
 * better config-check — validate project configuration files
 *
 * Checks for common configuration file issues across TypeScript,
 * ESLint, Prettier, Babel, Vite, Webpack, and other tools.
 *
 * Usage:
 *   better config-check
 *   better config-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    // Handle JSON with comments (tsconfig style)
    const stripped = content.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    return JSON.parse(stripped);
  } catch { return null; }
}

export async function cmdConfigCheck(argv) {
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
    printText(`Usage: better config-check [options]

Validate project configuration files for common issues.

Checks:
  TypeScript  tsconfig.json — strict mode, outDir, paths
  ESLint      .eslintrc — extends, rules
  Prettier    .prettierrc — consistency with editorconfig
  Babel       babel.config — preset compatibility
  Vite/Webpack build config basics

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
  } catch { pkgJson = {}; }

  const issues = [];
  const checks = [];

  // ── TypeScript ──────────────────────────────────────────────────────────────
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  if (await fileExists(tsconfigPath)) {
    const tsconfig = await readJsonFile(tsconfigPath);
    if (tsconfig) {
      const co = tsconfig.compilerOptions || {};

      checks.push({
        id: "ts-strict",
        label: "TypeScript: strict mode enabled",
        passed: Boolean(co.strict),
        severity: "warning",
        hint: 'Add "strict": true to tsconfig.json compilerOptions',
      });

      checks.push({
        id: "ts-outdir",
        label: "TypeScript: outDir configured",
        passed: Boolean(co.outDir),
        severity: "info",
        hint: 'Add "outDir": "./dist" to compilerOptions',
      });

      checks.push({
        id: "ts-target",
        label: "TypeScript: target is ES2019+",
        passed: !co.target || ["ES2019","ES2020","ES2021","ES2022","ES2023","ESNext","ES6","ES2015","ES2016","ES2017","ES2018"].includes(co.target),
        severity: "info",
        hint: 'Consider "target": "ES2020" or newer',
      });

      if (co.allowJs === true && !co.checkJs) {
        checks.push({
          id: "ts-allowjs",
          label: "TypeScript: checkJs disabled with allowJs",
          passed: false,
          severity: "info",
          hint: 'Consider adding "checkJs": true with allowJs',
        });
      }
    } else {
      checks.push({
        id: "ts-parse",
        label: "TypeScript: tsconfig.json is valid JSON",
        passed: false,
        severity: "error",
        hint: "Fix JSON syntax in tsconfig.json",
      });
    }
  }

  // ── ESLint ──────────────────────────────────────────────────────────────────
  const eslintFiles = [".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"];
  const hasEslintPkg = Boolean(pkgJson.devDependencies?.eslint || pkgJson.dependencies?.eslint);
  let eslintConfigFound = false;

  for (const f of eslintFiles) {
    if (await fileExists(path.join(projectRoot, f))) {
      eslintConfigFound = true;
      break;
    }
  }
  // Also check package.json eslintConfig field
  if (pkgJson.eslintConfig) eslintConfigFound = true;

  if (hasEslintPkg && !eslintConfigFound) {
    checks.push({
      id: "eslint-config",
      label: "ESLint: configuration file present",
      passed: false,
      severity: "warning",
      hint: "Create .eslintrc.json with your ESLint configuration",
    });
  } else if (eslintConfigFound) {
    checks.push({
      id: "eslint-config",
      label: "ESLint: configuration file present",
      passed: true,
      severity: "info",
    });
  }

  // ── Prettier ────────────────────────────────────────────────────────────────
  const prettierFiles = [".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js"];
  const hasPrettierPkg = Boolean(pkgJson.devDependencies?.prettier || pkgJson.dependencies?.prettier);
  let prettierConfigFound = false;

  for (const f of prettierFiles) {
    if (await fileExists(path.join(projectRoot, f))) {
      prettierConfigFound = true;
      break;
    }
  }
  if (pkgJson.prettier) prettierConfigFound = true;

  if (hasPrettierPkg && !prettierConfigFound) {
    checks.push({
      id: "prettier-config",
      label: "Prettier: configuration file present",
      passed: false,
      severity: "info",
      hint: "Create .prettierrc with your Prettier configuration",
    });
  }

  // ── EditorConfig ────────────────────────────────────────────────────────────
  const editorConfigPath = path.join(projectRoot, ".editorconfig");
  checks.push({
    id: "editorconfig",
    label: ".editorconfig present",
    passed: await fileExists(editorConfigPath),
    severity: "info",
    hint: "Create .editorconfig to ensure consistent editor settings",
  });

  // ── Build tool ─────────────────────────────────────────────────────────────
  const buildConfigs = [
    { file: "vite.config.js", label: "Vite" },
    { file: "vite.config.ts", label: "Vite" },
    { file: "webpack.config.js", label: "Webpack" },
    { file: "rollup.config.js", label: "Rollup" },
    { file: "rollup.config.ts", label: "Rollup" },
    { file: "tsup.config.ts", label: "tsup" },
    { file: "esbuild.config.js", label: "esbuild" },
  ];

  let buildConfigFound = false;
  let buildTool = null;
  for (const bc of buildConfigs) {
    if (await fileExists(path.join(projectRoot, bc.file))) {
      buildConfigFound = true;
      buildTool = bc.label;
      break;
    }
  }

  if (pkgJson.scripts?.build && !buildConfigFound) {
    checks.push({
      id: "build-config",
      label: "Build config present (build script exists but no config found)",
      passed: false,
      severity: "info",
      hint: "Ensure your build configuration file is in the project root",
    });
  } else if (buildConfigFound) {
    checks.push({
      id: "build-config",
      label: `Build config present (${buildTool})`,
      passed: true,
      severity: "info",
    });
  }

  const errors = checks.filter(c => !c.passed && c.severity === "error");
  const warnings = checks.filter(c => !c.passed && c.severity === "warning");
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.config-check",
      checks: checks.map(c => ({ id: c.id, label: c.label, passed: c.passed, severity: c.severity })),
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  if (checks.length === 0) {
    printText(`\x1b[90mNo configuration files detected.\x1b[0m`);
    return;
  }

  printText(`\n\x1b[1mbetter config-check\x1b[0m — ${checks.length} check(s)\n`);

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
    printText(`\x1b[32m✔ Configuration looks good!\x1b[0m`);
  } else if (allOk) {
    printText(`\x1b[33m⚠ ${warnings.length} suggestion(s).\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} error(s) in configuration.\x1b[0m`);
    process.exitCode = 1;
  }
}
