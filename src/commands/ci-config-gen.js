/**
 * better ci-config-gen — generate CI/CD configuration snippets
 *
 * Generates CI configuration for GitHub Actions, GitLab CI, or
 * CircleCI optimized for npm projects with caching, testing, and
 * security checks.
 *
 * Usage:
 *   better ci-config-gen --platform github
 *   better ci-config-gen --platform gitlab
 *   better ci-config-gen --platform circle
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const GITHUB_ACTIONS_TEMPLATE = (pkgName, nodeVersion, hasTest, hasBuild, hasLint, hasTypecheck) => `name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  test:
    name: Test (Node.js \${{ matrix.node-version }})
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [${nodeVersion}, 'lts/*']

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

${hasLint ? `      - name: Lint
        run: npm run lint

` : ""}${hasTypecheck ? `      - name: Type check
        run: npm run typecheck

` : ""}${hasTest ? `      - name: Test
        run: npm test

` : ""}${hasBuild ? `      - name: Build
        run: npm run build

` : ""}  security:
    name: Security audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 'lts/*'
          cache: 'npm'
      - run: npm ci
      - run: npm audit --audit-level=high
`;

const GITLAB_CI_TEMPLATE = (nodeVersion, hasTest, hasBuild, hasLint) => `image: node:${nodeVersion}

cache:
  paths:
    - node_modules/

stages:
  - install
  - test
  - build

install:
  stage: install
  script:
    - npm ci
  artifacts:
    paths:
      - node_modules/
    expire_in: 1 hour

${hasLint ? `lint:
  stage: test
  script:
    - npm run lint
  needs: [install]

` : ""}${hasTest ? `test:
  stage: test
  script:
    - npm test
  needs: [install]
  coverage: '/Lines\\s*:\\s*(\\d+\\.?\\d*)%/'

` : ""}${hasBuild ? `build:
  stage: build
  script:
    - npm run build
  needs: [install]
  artifacts:
    paths:
      - dist/
    expire_in: 1 week

` : ""}security:
  stage: test
  script:
    - npm audit --audit-level=high
  needs: [install]
  allow_failure: true
`;

const CIRCLE_CI_TEMPLATE = (nodeVersion, hasTest, hasBuild) => `version: 2.1

orbs:
  node: circleci/node@5

jobs:
  test:
    docker:
      - image: cimg/node:${nodeVersion}
    steps:
      - checkout
      - node/install-packages:
          pkg-manager: npm
${hasTest ? `      - run:
          name: Run tests
          command: npm test
` : ""}${hasBuild ? `      - run:
          name: Build
          command: npm run build
` : ""}
workflows:
  build-test:
    jobs:
      - test
`;

export async function cmdCiConfigGen(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:      { type: "boolean", default: runtime.json === true },
      help:      { type: "boolean", short: "h", default: false },
      platform:  { type: "string", default: "github" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better ci-config-gen [options]

Generate CI/CD configuration for your npm project.

Options:
  --platform <p>   Target: github|gitlab|circle (default: github)
  --dry-run        Print config without writing files
  --json           Machine-readable output
  -h, --help       Show this help

Generated files:
  github  → .github/workflows/ci.yml
  gitlab  → .gitlab-ci.yml
  circle  → .circleci/config.yml
`);
    return;
  }

  const platform = values.platform.toLowerCase();
  const validPlatforms = ["github", "gitlab", "circle"];
  if (!validPlatforms.includes(platform)) {
    const msg = `Invalid platform: ${platform}. Options: ${validPlatforms.join(", ")}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch { pkgJson = {}; }

  const scripts = pkgJson.scripts || {};
  const nodeVersion = pkgJson.engines?.node?.replace(/[^0-9.]/g, "").split(".")[0] || "20";
  const hasTest = !!scripts.test && !scripts.test.includes("no test");
  const hasBuild = !!scripts.build;
  const hasLint = !!scripts.lint;
  const hasTypecheck = !!scripts.typecheck || !!scripts["type-check"];

  let config, outputPath;

  if (platform === "github") {
    config = GITHUB_ACTIONS_TEMPLATE(pkgJson.name, nodeVersion, hasTest, hasBuild, hasLint, hasTypecheck);
    outputPath = path.join(projectRoot, ".github", "workflows", "ci.yml");
  } else if (platform === "gitlab") {
    config = GITLAB_CI_TEMPLATE(nodeVersion, hasTest, hasBuild, hasLint);
    outputPath = path.join(projectRoot, ".gitlab-ci.yml");
  } else {
    config = CIRCLE_CI_TEMPLATE(nodeVersion, hasTest, hasBuild);
    outputPath = path.join(projectRoot, ".circleci", "config.yml");
  }

  if (values.json) {
    printJson({ ok: true, kind: "better.ci-config-gen", platform, outputPath, config, dryRun: values["dry-run"] });
    if (!values["dry-run"]) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, config, "utf8");
    }
    return;
  }

  printText(`\n\x1b[1mbetter ci-config-gen\x1b[0m — ${platform}\n`);

  if (values["dry-run"]) {
    printText(`  \x1b[90mWould write: ${path.relative(projectRoot, outputPath)}\x1b[0m\n`);
    printText(config);
    return;
  }

  // Check if file exists
  let exists = false;
  try { await fs.access(outputPath); exists = true; } catch {}

  if (exists) {
    printText(`  \x1b[33m⚠\x1b[0m  ${path.relative(projectRoot, outputPath)} already exists`);
    printText(`  Use --dry-run to preview the new config`);
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, config, "utf8");
  printText(`\x1b[32m✔ Created: ${path.relative(projectRoot, outputPath)}\x1b[0m`);
  if (!hasTest) printText(`  \x1b[90m⚠ No "test" script detected — add one to enable CI testing\x1b[0m`);
  printText("");
}
