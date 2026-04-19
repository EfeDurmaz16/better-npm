/**
 * better init — initialize a project with best practices
 *
 * Creates or updates package.json with canonical field ordering,
 * creates .gitignore, .nvmrc, and optionally a basic README.md
 * and GitHub Actions CI workflow.
 *
 * Usage:
 *   better init
 *   better init --ci
 *   better init --force
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const GITIGNORE_TEMPLATE = `# Dependencies
node_modules/

# Build output
dist/
build/
out/
.next/
.nuxt/

# Environment
.env
.env.local
.env.*.local

# Logs
*.log
npm-debug.log*
yarn-debug.log*
pnpm-debug.log*

# OS
.DS_Store
Thumbs.db

# Editor
.vscode/
.idea/
*.swp
*.swo

# Testing
coverage/
.nyc_output/

# Package manager caches
.npm/
.yarn/cache
.pnpm-store/
`;

const CI_TEMPLATE = (name) => `name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [18.x, 20.x, 22.x]

    steps:
      - uses: actions/checkout@v4
      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm test
`;

function getCurrentNodeVersion() {
  const result = spawnSync("node", ["--version"], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim().replace(/^v/, "");
  return "18.0.0";
}

function getGitUserName(cwd) {
  const result = spawnSync("git", ["config", "user.name"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function getGitUserEmail(cwd) {
  const result = spawnSync("git", ["config", "user.email"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function getGitRemoteUrl(cwd) {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  const url = result.stdout.trim();
  // Normalize git URL to https URL
  if (url.startsWith("git@github.com:")) {
    return "https://github.com/" + url.slice(15).replace(/\.git$/, "");
  }
  return url.replace(/\.git$/, "");
}

export async function cmdInit(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      force:    { type: "boolean", default: false },
      ci:       { type: "boolean", default: false },
      readme:   { type: "boolean", default: false },
      "dry-run":{ type: "boolean", default: false },
      // v0.6 scaffold additions
      security: { type: "boolean", default: false },
      npmrc:    { type: "boolean", default: false },
      policy:   { type: "boolean", default: false },
      hooks:    { type: "boolean", default: false },
      all:      { type: "boolean", default: false },
      // v0.7 context template
      "context-template": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better init [options]

Initialize or upgrade a project with best practices.

Actions:
  • Creates/updates package.json with best-practice fields
  • Creates .gitignore with common patterns
  • Creates .nvmrc pinned to current Node.js version
  • Optionally creates .github/workflows/ci.yml (--ci)
  • Optionally creates README.md (--readme)
  • Optionally creates SECURITY.md (--security)
  • Optionally creates .npmrc with safe defaults (--npmrc)
  • Optionally creates .better/policy.json scaffold (--policy)
  • Optionally creates .better/hooks.json scaffold (--hooks)
  • Optionally creates .better-context.md and better.context.json templates (--context-template)

Options:
  --ci                Create GitHub Actions CI workflow
  --readme            Create README.md if missing
  --security          Create SECURITY.md vulnerability disclosure template
  --npmrc             Create .npmrc with safe registry defaults
  --policy            Create .better/policy.json license + security policy scaffold
  --hooks             Create .better/hooks.json pre/post install hooks scaffold
  --context-template  Create .better-context.md and better.context.json for AI context authoring
  --all               Enable all optional scaffolds (ci + readme + security + npmrc + policy + hooks + context-template)
  --force      Overwrite existing files
  --dry-run    Preview without writing
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const isDryRun = values["dry-run"];

  const actions = []; // { file, action, content }

  // --- package.json ---
  let pkgJson;
  let pkgExists = false;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    pkgExists = true;
  } catch {
    pkgJson = {};
  }

  const nodeVersion = getCurrentNodeVersion();
  const gitName = getGitUserName(projectRoot);
  const gitEmail = getGitUserEmail(projectRoot);
  const gitRemote = getGitRemoteUrl(projectRoot);
  const dirName = path.basename(projectRoot);

  const updatedPkg = Object.assign({}, pkgJson);

  // Fill in missing best-practice fields
  if (!updatedPkg.name) updatedPkg.name = dirName;
  if (!updatedPkg.version) updatedPkg.version = "0.1.0";
  if (!updatedPkg.description) updatedPkg.description = "";
  if (!updatedPkg.license) updatedPkg.license = "MIT";
  if (!updatedPkg.engines) updatedPkg.engines = { node: `>=${nodeVersion.split(".")[0]}` };

  if (!updatedPkg.author && (gitName || gitEmail)) {
    updatedPkg.author = gitEmail ? `${gitName} <${gitEmail}>` : gitName;
  }

  if (!updatedPkg.repository && gitRemote) {
    updatedPkg.repository = { type: "git", url: gitRemote };
  }

  if (!updatedPkg.scripts) updatedPkg.scripts = {};
  if (!updatedPkg.scripts.test) updatedPkg.scripts.test = 'echo "Error: no test specified" && exit 1';

  // Canonical field ordering
  const FIELD_ORDER = [
    "name", "version", "description", "private",
    "type", "main", "module", "exports", "types", "typings",
    "bin", "files",
    "scripts", "engines",
    "dependencies", "devDependencies", "peerDependencies", "optionalDependencies",
    "keywords", "author", "license", "repository", "bugs", "homepage",
    "funding",
  ];

  const ordered = {};
  for (const key of FIELD_ORDER) {
    if (updatedPkg[key] !== undefined) ordered[key] = updatedPkg[key];
  }
  for (const key of Object.keys(updatedPkg)) {
    if (!FIELD_ORDER.includes(key)) ordered[key] = updatedPkg[key];
  }

  const pkgContent = JSON.stringify(ordered, null, 2) + "\n";
  actions.push({
    file: "package.json",
    action: pkgExists ? "update" : "create",
    content: pkgContent,
  });

  // --- .gitignore ---
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignoreExists = await fs.access(gitignorePath).then(() => true).catch(() => false);
  if (!gitignoreExists || values.force) {
    actions.push({ file: ".gitignore", action: gitignoreExists ? "overwrite" : "create", content: GITIGNORE_TEMPLATE });
  } else {
    // Append missing entries
    const existing = await fs.readFile(gitignorePath, "utf8");
    const toAdd = [];
    if (!existing.includes("node_modules")) toAdd.push("node_modules/");
    if (!existing.includes(".env")) toAdd.push(".env");
    if (toAdd.length > 0) {
      actions.push({ file: ".gitignore", action: "append", content: "\n" + toAdd.join("\n") + "\n" });
    }
  }

  // --- .nvmrc ---
  const nvmrcPath = path.join(projectRoot, ".nvmrc");
  const nvmrcExists = await fs.access(nvmrcPath).then(() => true).catch(() => false);
  if (!nvmrcExists || values.force) {
    actions.push({ file: ".nvmrc", action: nvmrcExists ? "overwrite" : "create", content: `v${nodeVersion}\n` });
  }

  // --- .github/workflows/ci.yml ---
  if (values.ci) {
    const ciDir = path.join(projectRoot, ".github", "workflows");
    const ciPath = path.join(ciDir, "ci.yml");
    const ciExists = await fs.access(ciPath).then(() => true).catch(() => false);
    if (!ciExists || values.force) {
      actions.push({
        file: ".github/workflows/ci.yml",
        action: ciExists ? "overwrite" : "create",
        content: CI_TEMPLATE(updatedPkg.name),
      });
    }
  }

  // Resolve --all flag
  const wantSecurity         = values.security              || values.all;
  const wantNpmrc            = values.npmrc                 || values.all;
  const wantPolicy           = values.policy                || values.all;
  const wantHooks            = values.hooks                 || values.all;
  const wantContextTemplate  = values["context-template"]   || values.all;
  if (values.all) {
    values.ci     = true;
    values.readme = true;
  }

  // --- README.md ---
  if (values.readme) {
    const readmePath = path.join(projectRoot, "README.md");
    const readmeExists = await fs.access(readmePath).then(() => true).catch(() => false);
    if (!readmeExists || values.force) {
      const readmeContent = `# ${updatedPkg.name}

${updatedPkg.description || ""}

## Installation

\`\`\`bash
npm install ${updatedPkg.name}
\`\`\`

## Usage

\`\`\`js
// TODO
\`\`\`

## License

${updatedPkg.license}
`;
      actions.push({ file: "README.md", action: readmeExists ? "overwrite" : "create", content: readmeContent });
    }
  }

  // --- SECURITY.md ---
  if (wantSecurity) {
    const secPath = path.join(projectRoot, "SECURITY.md");
    const secExists = await fs.access(secPath).then(() => true).catch(() => false);
    if (!secExists || values.force) {
      const secContent = `# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue.
2. Email the maintainer at: [security@example.com](mailto:security@example.com)
   (update this address before publishing)
3. Include: affected version, reproduction steps, and potential impact.

We aim to respond within **72 hours** and release a patch within **7 days**
for confirmed critical issues.

## Security Best Practices

This project uses \`better\` for dependency management, which provides:
- Automatic vulnerability scanning via \`better audit\`
- License policy enforcement via \`better policy\`
- Install receipts for supply chain traceability
`;
      actions.push({ file: "SECURITY.md", action: secExists ? "overwrite" : "create", content: secContent });
    }
  }

  // --- .npmrc ---
  if (wantNpmrc) {
    const npmrcPath = path.join(projectRoot, ".npmrc");
    const npmrcExists = await fs.access(npmrcPath).then(() => true).catch(() => false);
    if (!npmrcExists || values.force) {
      const npmrcContent = `# .npmrc — generated by better init
# Registry (override with BETTER_REGISTRY env var)
registry=https://registry.npmjs.org

# Save exact versions by default
save-exact=true

# Audit level — fail on high or critical
audit-level=high

# No optional deps in CI
# optional=false

# Engine strict mode — respect "engines" in package.json
engine-strict=true

# Lockfile version
lockfile-version=3
`;
      actions.push({ file: ".npmrc", action: npmrcExists ? "overwrite" : "create", content: npmrcContent });
    }
  }

  // --- .better/policy.json ---
  if (wantPolicy) {
    const policyDir = path.join(projectRoot, ".better");
    const policyPath = path.join(policyDir, "policy.json");
    const policyExists = await fs.access(policyPath).then(() => true).catch(() => false);
    if (!policyExists || values.force) {
      const policyContent = JSON.stringify({
        "$schema": "https://better.sh/schema/v1/policy.json",
        "version": 1,
        "license": {
          "allow": ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense"],
          "deny": ["GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.1", "LGPL-3.0", "CDDL-1.0"],
          "unknown": "warn"
        },
        "audit": {
          "minSeverity": "high",
          "ignoreDevDeps": true,
          "fail": true
        },
        "firewall": {
          "blockTyposquats": true,
          "blockMaintainerlessPackages": false,
          "maxDepAge": 730
        }
      }, null, 2) + "\n";
      actions.push({ file: ".better/policy.json", action: policyExists ? "overwrite" : "create", content: policyContent });
    }
  }

  // --- .better/hooks.json ---
  if (wantHooks) {
    const hooksDir = path.join(projectRoot, ".better");
    const hooksPath = path.join(hooksDir, "hooks.json");
    const hooksExists = await fs.access(hooksPath).then(() => true).catch(() => false);
    if (!hooksExists || values.force) {
      const hooksContent = JSON.stringify({
        "$schema": "https://better.sh/schema/v1/hooks.json",
        "version": 1,
        "pre-install": [],
        "post-install": [
          {
            "name": "audit",
            "run": "better audit --min-severity high",
            "on": ["ci"],
            "failOnError": true
          }
        ],
        "pre-publish": [
          {
            "name": "build-check",
            "run": "npm run build",
            "failOnError": true
          }
        ]
      }, null, 2) + "\n";
      actions.push({ file: ".better/hooks.json", action: hooksExists ? "overwrite" : "create", content: hooksContent });
    }
  }

  // --- .better-context.md + better.context.json ---
  if (wantContextTemplate) {
    const pkgName = updatedPkg.name || dirName;

    const ctxMdPath = path.join(projectRoot, ".better-context.md");
    const ctxMdExists = await fs.access(ctxMdPath).then(() => true).catch(() => false);
    if (!ctxMdExists || values.force) {
      const ctxMdContent = `# ${pkgName} — AI Context

> This file is read by \`better context\` and AI coding assistants to understand your package.

## Overview

<!-- One-paragraph description of what this package does and its primary use case. -->

## Quick Start

\`\`\`js
// TODO: add a minimal working example
\`\`\`

## Key APIs

<!-- List your most important exports with brief descriptions. -->

| Export | Kind | Description |
|--------|------|-------------|
| \`example\` | function | Does something useful |

## Common Patterns

### Pattern 1: Basic usage

\`\`\`js
// TODO
\`\`\`

## Gotchas

- <!-- List known footguns, non-obvious behavior, or version-specific quirks -->

## Migration

<!-- If migrating from another package, describe the mapping here. -->

## See Also

- <!-- Links to related packages or documentation -->
`;
      actions.push({ file: ".better-context.md", action: ctxMdExists ? "overwrite" : "create", content: ctxMdContent });
    }

    const ctxJsonPath = path.join(projectRoot, "better.context.json");
    const ctxJsonExists = await fs.access(ctxJsonPath).then(() => true).catch(() => false);
    if (!ctxJsonExists || values.force) {
      const ctxJsonContent = JSON.stringify({
        "$schema": "https://better.sh/schema/v1/context.json",
        "schema": "1",
        "name": pkgName,
        "version": updatedPkg.version || "0.1.0",
        "description": updatedPkg.description || "",
        "exports": [],
        "quick_start": `import ${pkgName.replace(/[^a-zA-Z0-9_]/g, "_")} from '${pkgName}';`,
        "patterns": [],
        "gotchas": [],
        "migration": null,
        "see_also": [],
      }, null, 2) + "\n";
      actions.push({ file: "better.context.json", action: ctxJsonExists ? "overwrite" : "create", content: ctxJsonContent });
    }
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.init",
      dryRun: isDryRun,
      actions: actions.map(a => ({ file: a.file, action: a.action })),
    });
    if (!isDryRun) {
      for (const a of actions) {
        const fullPath = path.join(projectRoot, a.file);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        if (a.action === "append") {
          await fs.appendFile(fullPath, a.content, "utf8");
        } else {
          await fs.writeFile(fullPath, a.content, "utf8");
        }
      }
    }
    return;
  }

  printText(`\n\x1b[1mbetter init\x1b[0m — ${isDryRun ? "(dry-run) " : ""}${actions.length} action(s)\n`);

  for (const a of actions) {
    const actionLabel = {
      create: "\x1b[32m+ create\x1b[0m",
      update: "\x1b[34m~ update\x1b[0m",
      overwrite: "\x1b[33m! overwrite\x1b[0m",
      append: "\x1b[36m+ append\x1b[0m",
    }[a.action] || a.action;

    printText(`  ${actionLabel}  ${a.file}`);

    if (!isDryRun) {
      const fullPath = path.join(projectRoot, a.file);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      if (a.action === "append") {
        await fs.appendFile(fullPath, a.content, "utf8");
      } else {
        await fs.writeFile(fullPath, a.content, "utf8");
      }
    }
  }

  printText("");
  if (isDryRun) {
    printText(`\x1b[90mDry-run complete. Run without --dry-run to apply.\x1b[0m`);
  } else {
    printText(`\x1b[32m✔ Project initialized!\x1b[0m`);
    if (values.ci) printText(`\x1b[90mCI workflow written to .github/workflows/ci.yml\x1b[0m`);
    if (wantPolicy) printText(`\x1b[90mPolicy scaffold at .better/policy.json — edit to tune license/audit rules\x1b[0m`);
    if (wantHooks) printText(`\x1b[90mHooks scaffold at .better/hooks.json — edit to add pre/post install hooks\x1b[0m`);
    if (wantContextTemplate) printText(`\x1b[90mContext templates at .better-context.md + better.context.json — fill in to improve AI suggestions\x1b[0m`);
  }
}
