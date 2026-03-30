/**
 * better fix — auto-fix common project issues
 *
 * Detects and fixes common configuration problems, missing files,
 * and misconfigured settings in a Node.js project.
 *
 * Usage:
 *   better fix              # detect and fix all issues
 *   better fix --check      # detect only, no changes
 *   better fix --category   # fix specific category
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const FIXES = [
  {
    id: "missing-gitignore",
    description: "No .gitignore found",
    category: "git",
    check: async (root) => {
      try { await fs.access(path.join(root, ".gitignore")); return null; }
      catch { return "No .gitignore found"; }
    },
    fix: async (root) => {
      const defaultGitignore = `node_modules/
dist/
build/
.env
.env.local
.env.*.local
*.log
npm-debug.log*
.DS_Store
coverage/
.nyc_output/
*.tsbuildinfo
`;
      await fs.writeFile(path.join(root, ".gitignore"), defaultGitignore);
      return "Created .gitignore with common ignores";
    },
  },
  {
    id: "missing-env-example",
    description: "Has .env but no .env.example",
    category: "config",
    check: async (root) => {
      try {
        await fs.access(path.join(root, ".env"));
        try { await fs.access(path.join(root, ".env.example")); return null; }
        catch { return ".env exists but no .env.example for documentation"; }
      } catch { return null; }
    },
    fix: async (root) => {
      const envContent = await fs.readFile(path.join(root, ".env"), "utf8");
      // Redact values but keep keys
      const example = envContent.split("\n")
        .map(line => {
          if (!line.trim() || line.startsWith("#")) return line;
          const eq = line.indexOf("=");
          if (eq < 0) return line;
          return line.slice(0, eq + 1); // keep KEY= without value
        })
        .join("\n");
      await fs.writeFile(path.join(root, ".env.example"), example);
      return "Created .env.example from .env (values redacted)";
    },
  },
  {
    id: "gitignore-missing-env",
    description: ".env not ignored in .gitignore",
    category: "security",
    check: async (root) => {
      try {
        await fs.access(path.join(root, ".env"));
        const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
        if (!gi.includes(".env") && !gi.includes("*.env")) {
          return ".env file is not in .gitignore — may expose secrets";
        }
        return null;
      } catch { return null; }
    },
    fix: async (root) => {
      const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8").catch(() => "");
      await fs.writeFile(path.join(root, ".gitignore"), gi + "\n.env\n.env.local\n.env.*.local\n");
      return "Added .env patterns to .gitignore";
    },
  },
  {
    id: "missing-engines-field",
    description: "package.json missing engines.node",
    category: "compat",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      if (!pkg.engines?.node) return "No engines.node field in package.json";
      return null;
    },
    fix: async (root) => {
      const pkgPath = path.join(root, "package.json");
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      const curMaj = parseInt(process.version.replace(/^v/, "").split(".")[0]);
      pkg.engines = pkg.engines || {};
      pkg.engines.node = `>=${curMaj}.0.0`;
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      return `Set engines.node = ">=${curMaj}.0.0"`;
    },
  },
  {
    id: "missing-description",
    description: "package.json missing description",
    category: "metadata",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      if (!pkg.description) return "No description field in package.json";
      return null;
    },
    fix: null, // can't auto-fix — user must provide description
  },
  {
    id: "missing-license",
    description: "package.json missing license",
    category: "legal",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      if (!pkg.license) return "No license field in package.json";
      return null;
    },
    fix: async (root) => {
      const pkgPath = path.join(root, "package.json");
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      pkg.license = "MIT";
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      return 'Set license = "MIT" (change if needed)';
    },
  },
  {
    id: "private-flag-missing",
    description: "Non-publishable project missing private:true",
    category: "publishing",
    check: async (root) => {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      if (pkg.private === true) return null;
      // Heuristic: if no main/exports and no publishConfig → likely private
      if (!pkg.main && !pkg.exports && !pkg.publishConfig) {
        return "Consider adding private:true if this is not meant to be published";
      }
      return null;
    },
    fix: null, // requires user decision
  },
];

export async function cmdFix(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      check: { type: "boolean", default: false },
      category: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better fix [options]

Detect and auto-fix common project issues.

Categories: git | config | security | compat | metadata | legal | publishing

Options:
  --check              Detect issues without fixing
  --category <cat>     Only run fixes in this category
  --json               Machine-readable output
  -h, --help           Show this help

Examples:
  better fix               # fix all auto-fixable issues
  better fix --check       # report only
  better fix --category security
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const filteredFixes = values.category
    ? FIXES.filter(f => f.category === values.category)
    : FIXES;

  const results = [];

  for (const fixDef of filteredFixes) {
    let issue;
    try {
      issue = await fixDef.check(projectRoot);
    } catch (err) {
      issue = null; // can't check — skip
    }

    if (!issue) {
      results.push({ id: fixDef.id, status: "ok", description: fixDef.description });
      continue;
    }

    if (values.check || !fixDef.fix) {
      results.push({
        id: fixDef.id,
        status: "issue",
        description: fixDef.description,
        issue,
        fixable: Boolean(fixDef.fix),
      });
      continue;
    }

    try {
      const message = await fixDef.fix(projectRoot);
      results.push({ id: fixDef.id, status: "fixed", description: fixDef.description, message });
    } catch (err) {
      results.push({ id: fixDef.id, status: "error", description: fixDef.description, error: err.message });
    }
  }

  const issues = results.filter(r => r.status === "issue");
  const fixed = results.filter(r => r.status === "fixed");
  const errors = results.filter(r => r.status === "error");
  const ok = results.filter(r => r.status === "ok");

  if (values.json) {
    printJson({
      ok: issues.length === 0 && errors.length === 0,
      kind: "better.fix",
      check_only: values.check,
      fixed: fixed.length,
      issues: issues.length,
      errors: errors.length,
      results,
    });
    if (issues.length > 0 || errors.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter fix\x1b[0m${values.check ? " \x1b[90m(check only)\x1b[0m" : ""}\n`);

  for (const r of fixed) {
    printText(`  \x1b[32m✔\x1b[0m  \x1b[32m${r.id}\x1b[0m — ${r.message}`);
  }
  for (const r of ok) {
    printText(`  \x1b[32m✔\x1b[0m  ${r.id}`);
  }
  for (const r of issues) {
    const fixLabel = r.fixable ? " \x1b[90m(run without --check to fix)\x1b[0m" : " \x1b[90m(manual fix needed)\x1b[0m";
    printText(`  \x1b[33m⚠\x1b[0m  \x1b[33m${r.id}\x1b[0m — ${r.issue}${fixLabel}`);
  }
  for (const r of errors) {
    printText(`  \x1b[31m✖\x1b[0m  ${r.id} — ${r.error}`);
  }

  printText("");
  if (fixed.length > 0) printText(`\x1b[32mFixed ${fixed.length} issue(s)\x1b[0m`);
  if (issues.length > 0) {
    printText(`\x1b[33m${issues.length} issue(s) detected\x1b[0m`);
    process.exitCode = 1;
  }
  if (errors.length > 0) {
    printText(`\x1b[31m${errors.length} fix(es) failed\x1b[0m`);
    process.exitCode = 1;
  }
  if (fixed.length === 0 && issues.length === 0 && errors.length === 0) {
    printText(`\x1b[32m✔ No issues found.\x1b[0m`);
  }
}
