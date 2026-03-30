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

Options:
  --ci         Create GitHub Actions CI workflow
  --readme     Create README.md if missing
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
  }
}
