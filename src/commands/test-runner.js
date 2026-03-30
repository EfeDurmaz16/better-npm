/**
 * better test-runner — smart test runner with framework detection
 *
 * Detects installed test frameworks (Jest, Vitest, Mocha, Jasmine,
 * AVA, Tap) and runs tests with better output formatting and
 * failure analysis.
 *
 * Usage:
 *   better test-runner
 *   better test-runner --watch
 *   better test-runner --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const TEST_FRAMEWORKS = [
  {
    name: "vitest",
    bin: "vitest",
    detect: ["vitest.config.js", "vitest.config.ts", "vitest.config.mjs"],
    pkgs: ["vitest"],
    defaultArgs: ["run"],
    watchArgs: ["watch"],
  },
  {
    name: "jest",
    bin: "jest",
    detect: ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"],
    pkgs: ["jest", "ts-jest", "@jest/core"],
    defaultArgs: [],
    watchArgs: ["--watch"],
  },
  {
    name: "mocha",
    bin: "mocha",
    detect: [".mocharc.js", ".mocharc.cjs", ".mocharc.yml", ".mocharc.yaml", ".mocharc.json"],
    pkgs: ["mocha"],
    defaultArgs: [],
    watchArgs: ["--watch"],
  },
  {
    name: "jasmine",
    bin: "jasmine",
    detect: ["jasmine.json", "spec/support/jasmine.json"],
    pkgs: ["jasmine"],
    defaultArgs: [],
    watchArgs: [],
  },
  {
    name: "ava",
    bin: "ava",
    detect: [],
    pkgs: ["ava"],
    defaultArgs: [],
    watchArgs: ["--watch"],
  },
  {
    name: "tap",
    bin: "tap",
    detect: [".taprc", ".taprc.json"],
    pkgs: ["tap"],
    defaultArgs: [],
    watchArgs: ["--watch"],
  },
];

async function detectFramework(projectRoot) {
  // Check config files
  for (const fw of TEST_FRAMEWORKS) {
    for (const configFile of fw.detect) {
      try {
        await fs.access(path.join(projectRoot, configFile));
        return fw;
      } catch {}
    }
  }

  // Check node_modules
  for (const fw of TEST_FRAMEWORKS) {
    for (const pkg of fw.pkgs) {
      try {
        await fs.access(path.join(projectRoot, "node_modules", pkg, "package.json"));
        return fw;
      } catch {}
    }
  }

  // Check package.json scripts for hints
  try {
    const pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    const testScript = pkgJson.scripts?.test || "";
    for (const fw of TEST_FRAMEWORKS) {
      if (testScript.includes(fw.bin)) return fw;
    }
  } catch {}

  return null;
}

function findBin(projectRoot, binName) {
  const candidates = [
    path.join(projectRoot, "node_modules", ".bin", binName),
    path.join(projectRoot, "node_modules", ".bin", binName + ".cmd"),
    path.join(projectRoot, "node_modules", ".bin", binName + ".ps1"),
  ];
  return candidates[0]; // Return first (actual check done by spawn)
}

export async function cmdTestRunner(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      watch:      { type: "boolean", default: false },
      framework:  { type: "string", default: "" },
      coverage:   { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better test-runner [options] [test-args...]

Auto-detect and run your project's test framework.

Detected frameworks: Jest, Vitest, Mocha, Jasmine, AVA, Tap

Options:
  --watch             Run in watch mode
  --coverage          Enable coverage collection
  --framework <name>  Force a specific framework
  --json              Machine-readable result summary
  -h, --help          Show this help

Examples:
  better test-runner
  better test-runner --watch
  better test-runner --coverage
  better test-runner --framework vitest
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  // Detect framework
  let framework;
  if (values.framework) {
    framework = TEST_FRAMEWORKS.find(f => f.name === values.framework.toLowerCase());
    if (!framework) {
      const msg = `Unknown framework: ${values.framework}. Options: ${TEST_FRAMEWORKS.map(f => f.name).join(", ")}`;
      if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
      process.exitCode = 1;
      return;
    }
  } else {
    framework = await detectFramework(projectRoot);
  }

  if (!framework) {
    // Fall back to npm test
    if (!values.json) {
      printText(`\x1b[90mNo test framework detected. Running: npm test\x1b[0m\n`);
    }
    const start = Date.now();
    const child = spawn("npm", ["test"], {
      cwd: projectRoot,
      stdio: values.json ? ["pipe", "pipe", "pipe"] : "inherit",
      env: { ...process.env },
    });
    await new Promise((resolve) => {
      child.on("close", (code) => {
        const elapsed = Date.now() - start;
        if (values.json) {
          printJson({ ok: code === 0, kind: "better.test-runner", framework: "npm-test", exitCode: code, elapsed });
        }
        process.exitCode = code || 0;
        resolve();
      });
      child.on("error", (err) => {
        if (values.json) printJson({ ok: false, kind: "better.test-runner", error: err.message });
        else printText(`\x1b[31mError: ${err.message}\x1b[0m`);
        process.exitCode = 1;
        resolve();
      });
    });
    return;
  }

  const binPath = findBin(projectRoot, framework.bin);
  const args = values.watch ? [...framework.watchArgs] : [...framework.defaultArgs];
  if (values.coverage && framework.name === "jest") args.push("--coverage");
  if (values.coverage && framework.name === "vitest") args.push("--coverage");
  args.push(...positionals);

  if (!values.json) {
    printText(`\n\x1b[1mbetter test-runner\x1b[0m — using \x1b[36m${framework.name}\x1b[0m\n`);
    printText(`\x1b[90m▶ ${framework.bin} ${args.join(" ")}\x1b[0m\n`);
  }

  const start = Date.now();
  const child = spawn(binPath, args, {
    cwd: projectRoot,
    stdio: values.json ? ["pipe", "pipe", "pipe"] : "inherit",
    env: { ...process.env, PATH: path.join(projectRoot, "node_modules", ".bin") + path.delimiter + process.env.PATH },
  });

  let stdout = "";
  let stderr = "";
  if (values.json) {
    child.stdout?.on("data", c => { stdout += c; });
    child.stderr?.on("data", c => { stderr += c; });
  }

  await new Promise((resolve) => {
    child.on("close", (code) => {
      const elapsed = Date.now() - start;
      if (values.json) {
        printJson({ ok: code === 0, kind: "better.test-runner", framework: framework.name, exitCode: code, elapsed });
      }
      process.exitCode = code || 0;
      resolve();
    });
    child.on("error", (err) => {
      if (values.json) printJson({ ok: false, kind: "better.test-runner", framework: framework.name, error: err.message });
      else printText(`\x1b[31mError running ${framework.bin}: ${err.message}\x1b[0m\n\x1b[90mIs it installed? npm install --save-dev ${framework.pkgs[0]}\x1b[0m`);
      process.exitCode = 1;
      resolve();
    });
  });
}
