import { parseArgs } from "node:util";
import { cmdInstall } from "./commands/install.js";
import { cmdAnalyze } from "./commands/analyze.js";
import { cmdCache } from "./commands/cache.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdServe } from "./commands/serve.js";
import { cmdBenchmark } from "./commands/benchmark.js";
import { cmdRun } from "./commands/run.js";
import { cmdLock } from "./commands/lock.js";
import { cmdPolicy } from "./commands/policy.js";
import { cmdWorkspace } from "./commands/workspace.js";
import { cmdAudit } from "./commands/audit.js";
import { cmdDashboard } from "./commands/dashboard.js";
import { printJson, printText, toErrorJson } from "./lib/output.js";
import { resolveRuntimeConfig, setRuntimeConfig } from "./lib/config.js";
import { configureLogger, logger } from "./lib/log.js";
import { VERSION } from "./version.js";

const HELP = `better - dependency toolkit for Node.js

Usage:
  better <command> [options]

Commands:
  install            Wrap your package manager install
  analyze            Analyze node_modules sizes and duplication
  cache <subcmd>     Inspect/manage Better cache (stats, gc, explain)
  doctor             Dependency health checks and score
  serve              Start web UI server for dependency visualization
  benchmark          Run comparative cold/warm install benchmark
  lock               Generate/verify Better lock metadata
  policy <subcmd>    Dependency policy enforcement (check, init)
  workspace <subcmd> Workspace management (list, info, graph, changed, run)
  audit              Scan dependencies for known vulnerabilities (OSV.dev)
  dashboard          Interactive TUI dashboard for project health
  run <script>       Run package.json scripts via npm/pnpm/yarn
  lint|test|dev|build  Script aliases for better run

Global options:
  --json             Machine-readable output (JSON)
  --cache-root PATH  Override Better cache root
  --log-level LEVEL  debug|info|warn|error|silent
  --config PATH      Load config from file
  -v, --version      Show version
  -h, --help         Show help
`;

export async function runCli(argv) {
  const first = argv[0];
  if (argv.length === 0 || first === "help" || first === "-h" || first === "--help") {
    printText(HELP);
    return;
  }

  if (first === "-v" || first === "--version" || first === "version") {
    printText(`better v${VERSION}`);
    return;
  }

  if (first?.startsWith("-")) {
    printText(HELP);
    process.exitCode = 2;
    return;
  }

  const command = first;
  const rest = argv.slice(1);

  const globals = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean" },
      "cache-root": { type: "string" },
      "log-level": { type: "string" },
      config: { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });
  const runtimeConfig = await resolveRuntimeConfig({
    cwd: process.cwd(),
    configPath: globals.values.config,
    cli: {
      json: globals.values.json === true ? true : undefined,
      cacheRoot: globals.values["cache-root"],
      logLevel: globals.values["log-level"]
    }
  });
  setRuntimeConfig(runtimeConfig);
  configureLogger({
    level: runtimeConfig.logLevel,
    context: { command, cwd: process.cwd() }
  });

  try {
    logger.info("command.start", { argv: rest });
    switch (command) {
      case "install":
        await cmdInstall(rest);
        break;
      case "analyze":
        await cmdAnalyze(rest);
        break;
      case "cache":
        await cmdCache(rest);
        break;
      case "doctor":
        await cmdDoctor(rest);
        break;
      case "serve":
        await cmdServe(rest);
        break;
      case "benchmark":
        await cmdBenchmark(rest);
        break;
      case "lock":
        await cmdLock(rest);
        break;
      case "policy":
        await cmdPolicy(rest);
        break;
      case "workspace":
        await cmdWorkspace(rest);
        break;
      case "audit":
        await cmdAudit(rest);
        break;
      case "dashboard":
        await cmdDashboard(rest);
        break;
      case "run":
        await cmdRun(rest);
        break;
      case "lint":
      case "test":
      case "dev":
      case "build":
        await cmdRun(rest, { aliasScript: command });
        break;
      case "help":
      default:
        printText(HELP);
        process.exitCode = command === "help" ? 0 : 2;
        return;
    }
    logger.info("command.end", { exitCode: process.exitCode ?? 0 });
  } catch (err) {
    logger.error("command.error", {
      errorName: err?.name ?? "Error",
      errorMessage: err?.message ?? String(err)
    });
    if (runtimeConfig.json) {
      printJson(toErrorJson(err));
    } else {
      // eslint-disable-next-line no-console
      console.error(err?.stack || String(err));
    }
    const hintedExitCode = Number(
      err?.exitCode ??
      err?.install?.exitCode ??
      err?.code
    );
    process.exitCode = Number.isInteger(hintedExitCode) && hintedExitCode >= 0
      ? hintedExitCode
      : 1;
  }
}
