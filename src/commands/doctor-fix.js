/**
 * better doctor-fix — auto-fix common project issues
 *
 * Extends the base doctor command with automatic fixing capabilities.
 * Runs diagnostics and applies fixes for detected problems.
 *
 * Usage:
 *   better doctor-fix
 *   better doctor-fix --dry-run
 *   better doctor-fix --category security
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const FIXES = [
  {
    id: "add-engines-node",
    category: "maintenance",
    label: "Add engines.node field",
    check: async (pkg) => !pkg.engines?.node,
    fix: async (pkgPath, pkg) => {
      const nodeVer = process.version.replace(/^v/, "").split(".")[0];
      const updated = { ...pkg, engines: { ...(pkg.engines || {}), node: `>=${nodeVer}` } };
      await fs.writeFile(pkgPath, JSON.stringify(updated, null, 2) + "\n");
      return `Set engines.node to >=${nodeVer}`;
    },
  },
  {
    id: "add-license",
    category: "maintenance",
    label: 'Add "license" field',
    check: async (pkg) => !pkg.license,
    fix: async (pkgPath, pkg) => {
      const updated = { ...pkg, license: "MIT" };
      await fs.writeFile(pkgPath, JSON.stringify(updated, null, 2) + "\n");
      return 'Set license to "MIT" (update if needed)';
    },
  },
  {
    id: "gitignore-env",
    category: "security",
    label: "Add .env to .gitignore",
    check: async (pkg, root) => {
      try {
        const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
        return !gi.includes(".env");
      } catch { return false; } // No .gitignore — don't flag, let add-gitignore handle it
    },
    fix: async (pkgPath, pkg, root) => {
      const giPath = path.join(root, ".gitignore");
      await fs.appendFile(giPath, "\n# Environment\n.env\n.env.local\n.env.*\n");
      return "Appended .env patterns to .gitignore";
    },
  },
  {
    id: "add-gitignore",
    category: "maintenance",
    label: "Create .gitignore",
    check: async (pkg, root) => {
      try { await fs.access(path.join(root, ".gitignore")); return false; } catch { return true; }
    },
    fix: async (pkgPath, pkg, root) => {
      await fs.writeFile(path.join(root, ".gitignore"),
        "node_modules/\ndist/\nbuild/\n.env\n.env.local\n*.log\n.DS_Store\ncoverage/\n");
      return "Created .gitignore";
    },
  },
  {
    id: "fix-test-script",
    category: "maintenance",
    label: "Remove placeholder test script",
    check: async (pkg) => pkg.scripts?.test?.startsWith("echo"),
    fix: async (pkgPath, pkg) => {
      // Don't auto-fix this — just report it
      return null; // returning null means "suggest only"
    },
  },
  {
    id: "sort-dependencies",
    category: "best-practices",
    label: "Sort dependencies alphabetically",
    check: async (pkg) => {
      const deps = Object.keys(pkg.dependencies || {});
      const sorted = [...deps].sort();
      return JSON.stringify(deps) !== JSON.stringify(sorted);
    },
    fix: async (pkgPath, pkg) => {
      const updated = { ...pkg };
      if (updated.dependencies) {
        updated.dependencies = Object.fromEntries(
          Object.entries(updated.dependencies).sort(([a], [b]) => a.localeCompare(b))
        );
      }
      if (updated.devDependencies) {
        updated.devDependencies = Object.fromEntries(
          Object.entries(updated.devDependencies).sort(([a], [b]) => a.localeCompare(b))
        );
      }
      await fs.writeFile(pkgPath, JSON.stringify(updated, null, 2) + "\n");
      return "Sorted dependencies alphabetically";
    },
  },
  {
    id: "add-nvmrc",
    category: "maintenance",
    label: "Create .nvmrc",
    check: async (pkg, root) => {
      try { await fs.access(path.join(root, ".nvmrc")); return false; } catch { return true; }
    },
    fix: async (pkgPath, pkg, root) => {
      const ver = process.version;
      await fs.writeFile(path.join(root, ".nvmrc"), `${ver}\n`);
      return `Created .nvmrc with ${ver}`;
    },
  },
];

export async function cmdDoctorFix(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      "dry-run":{ type: "boolean", default: false },
      category: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better doctor-fix [options]

Auto-fix common project issues detected by diagnostics.

Fixes:
  maintenance  engines.node, license, test script, .nvmrc, .gitignore
  security     .env in .gitignore
  best-practices  Sort dependencies

Options:
  --dry-run          Preview fixes without applying
  --category <cat>   Only fix a specific category
  --json             Machine-readable output
  -h, --help         Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const pkgPath = path.join(projectRoot, "package.json");

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const categoryFilter = values.category?.toLowerCase();
  const isDryRun = values["dry-run"];

  const applicable = FIXES.filter(f => !categoryFilter || f.category === categoryFilter);
  const results = [];

  // Re-read pkg each time since fixes may modify it
  let currentPkg = pkgJson;

  for (const fix of applicable) {
    let needed = false;
    try { needed = await fix.check(currentPkg, projectRoot); } catch {}

    if (!needed) {
      results.push({ id: fix.id, category: fix.category, label: fix.label, needed: false, applied: false });
      continue;
    }

    let message = null;
    let applied = false;

    if (!isDryRun && fix.fix) {
      try {
        message = await fix.fix(pkgPath, currentPkg, projectRoot);
        if (message !== null) {
          applied = true;
          // Re-read pkg after fix
          try { currentPkg = JSON.parse(await fs.readFile(pkgPath, "utf8")); } catch {}
        }
      } catch (err) {
        message = `Failed: ${err.message}`;
      }
    }

    results.push({ id: fix.id, category: fix.category, label: fix.label, needed: true, applied, message, dryRun: isDryRun });
  }

  const needed = results.filter(r => r.needed);
  const applied = results.filter(r => r.applied);
  const suggestOnly = results.filter(r => r.needed && !r.applied && !isDryRun);

  if (values.json) {
    printJson({
      ok: needed.length === 0,
      kind: "better.doctor-fix",
      dryRun: isDryRun,
      issues: needed.length,
      fixed: applied.length,
      results,
    });
    return;
  }

  printText(`\n\x1b[1mbetter doctor-fix\x1b[0m${isDryRun ? " (dry-run)" : ""}\n`);

  if (needed.length === 0) {
    printText(`\x1b[32m✔ No issues found!\x1b[0m`);
    return;
  }

  for (const r of results) {
    if (!r.needed) continue;
    if (r.applied) {
      printText(`  \x1b[32m✔ fixed\x1b[0m  ${r.label}`);
      if (r.message) printText(`       \x1b[90m→ ${r.message}\x1b[0m`);
    } else if (isDryRun) {
      printText(`  \x1b[33m⚠ would fix\x1b[0m  ${r.label}`);
    } else {
      printText(`  \x1b[90m· suggest\x1b[0m  ${r.label} (manual fix required)`);
    }
  }

  printText("");
  if (applied.length > 0) {
    printText(`\x1b[32m✔ Applied ${applied.length} fix(es).\x1b[0m`);
  }
  if (isDryRun) {
    printText(`\x1b[90mRun without --dry-run to apply fixes.\x1b[0m`);
  }
}
