import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better shell` — spawn an interactive shell with the project environment
 * activated (Python venv, node_modules/.bin on PATH, .env loaded, etc.).
 *
 * Usage:
 *   better shell                      Auto-detect ecosystem, activate env
 *   better shell --ecosystem python   Force Python venv activation
 *   better shell --ecosystem npm      Force npm script-env activation
 *   better shell --json               Print activation env as JSON (no shell)
 */
export async function cmdShell(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better shell [options]

Spawn an interactive shell with the project environment activated.

For Python projects (.venv present): activates the virtual environment by
setting VIRTUAL_ENV and prepending .venv/bin to PATH.
For npm projects: prepends node_modules/.bin to PATH.
In both cases .env is loaded into the shell's environment.

Options:
  --ecosystem <name>     Force ecosystem: "python" | "npm"
  --venv <path>          Override venv directory (default: .venv)
  --shell <cmd>          Shell to spawn (default: $SHELL or /bin/sh)
  --project-root <path>  Override project root
  --json                 Print environment as JSON instead of spawning shell
  -h, --help             Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      ecosystem: { type: "string" },
      venv: { type: "string", default: ".venv" },
      shell: { type: "string" },
      "project-root": { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  const projectRoot = values["project-root"]
    ? path.resolve(values["project-root"])
    : await resolveInstallProjectRoot();

  const venvDir = path.resolve(projectRoot, values.venv ?? ".venv");
  const nodeModulesBin = path.join(projectRoot, "node_modules", ".bin");

  // --- Detect ecosystem -------------------------------------------------------
  let ecosystem = values.ecosystem ?? null;
  if (!ecosystem) {
    const hasPyproject = await fileExists(path.join(projectRoot, "pyproject.toml"));
    const hasRequirements = await fileExists(path.join(projectRoot, "requirements.txt"));
    const hasPackageJson = await fileExists(path.join(projectRoot, "package.json"));
    if (hasPyproject || hasRequirements) {
      ecosystem = "python";
    } else if (hasPackageJson) {
      ecosystem = "npm";
    } else {
      ecosystem = "generic";
    }
  }

  // --- Build activation environment -------------------------------------------
  const extraEnv = {};

  if (ecosystem === "python") {
    const venvExists = await fileExists(path.join(venvDir, "pyvenv.cfg"));
    if (!venvExists) {
      printText(
        `better · no .venv found at ${venvDir}\n` +
        `  Run \`better install\` first to create the virtual environment.`
      );
      if (values.json) {
        printJson({ error: true, message: "no .venv found", venv: venvDir });
      }
      process.exitCode = 1;
      return;
    }

    const binDir = process.platform === "win32"
      ? path.join(venvDir, "Scripts")
      : path.join(venvDir, "bin");

    extraEnv["VIRTUAL_ENV"] = venvDir;
    extraEnv["PATH"] = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    // Unset PYTHONHOME if set — it confuses Python inside the venv
    extraEnv["PYTHONHOME"] = "";
  } else if (ecosystem === "npm") {
    const hasBin = await fileExists(nodeModulesBin);
    if (hasBin) {
      extraEnv["PATH"] = `${nodeModulesBin}${path.delimiter}${process.env.PATH ?? ""}`;
    }
  }

  // Mark the shell as better-managed
  extraEnv["BETTER_SHELL"] = "1";
  extraEnv["BETTER_ECOSYSTEM"] = ecosystem;
  extraEnv["BETTER_PROJECT_ROOT"] = projectRoot;

  // Load .env if present
  const dotenvVars = await loadDotenv(projectRoot);
  Object.assign(extraEnv, dotenvVars);

  // --- JSON mode: just print the env ------------------------------------------
  if (values.json) {
    printJson({
      kind: "shell",
      schemaVersion: 1,
      ecosystem,
      projectRoot,
      venv: ecosystem === "python" ? venvDir : null,
      extraEnv,
    });
    return;
  }

  // --- Spawn shell -------------------------------------------------------------
  const shellBin =
    values.shell ??
    process.env.SHELL ??
    (process.platform === "win32" ? "cmd.exe" : "/bin/sh");

  // Merge extra env with current process env
  const fullEnv = { ...process.env, ...extraEnv };
  // Remove empty-string PYTHONHOME (we want it absent, not empty)
  if (fullEnv["PYTHONHOME"] === "") {
    delete fullEnv["PYTHONHOME"];
  }

  printText(
    `better · activating ${ecosystem} environment in ${path.basename(shellBin)}\n` +
    (ecosystem === "python"
      ? `  venv: ${venvDir}`
      : ecosystem === "npm"
      ? `  node_modules/.bin on PATH`
      : `  generic shell`)
  );

  const result = spawnSync(shellBin, [], {
    cwd: projectRoot,
    env: fullEnv,
    stdio: "inherit",
    shell: false,
  });

  process.exitCode = result.status ?? 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse a .env file into a plain object. */
async function loadDotenv(projectRoot) {
  const dotenvPath = path.join(projectRoot, ".env");
  let content;
  try {
    content = await fs.readFile(dotenvPath, "utf8");
  } catch {
    return {};
  }

  const vars = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) vars[key] = val;
  }
  return vars;
}
