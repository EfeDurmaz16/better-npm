import { parseArgs } from "node:util";
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
  merge-driver       Git merge driver for better.lock.json (install/uninstall/status)
  risk [pkg...]      Dependency risk scoring (A–F grade, staleness, CVEs, bus factor)
  upgrade            Self-update — download and install the latest version of better
  update [pkg...]    Auto-update intelligence — patch/minor/major with changelog snippets
  size [pkg...]      Install size impact — own + subtree disk footprint, % of total
  prefetch           Pre-warm registry cache from package.json scripts + source imports
  delta              Show lockfile delta (added/removed/changed) vs last install
  diff [r1] [r2]     Show dependency changes between two lockfile states (git refs or files)
  ci                 CI-optimized frozen install (strict, clean node_modules)
  policy <subcmd>    Dependency policy enforcement (check, init)
  workspace <subcmd> Workspace management (list, info, graph, changed, run)
  audit              Scan dependencies for known vulnerabilities (OSV.dev)
  audit fix          Auto-fix vulnerabilities with semver-safe upgrades
  maintenance        Predictive maintenance — risk-score packages needing attention
  dashboard          Interactive TUI dashboard for project health
  run <script>       Run package.json scripts via npm/pnpm/yarn
  why <package>      Show why a package is installed (dependency paths)
  dedupe             Detect duplicate packages in node_modules
  license            Scan node_modules for package licenses
  outdated           Check for newer versions of installed packages
  scripts            Manage install script sandboxing (list, allow, block)
  suggest            Suggest missing deps and flag unused ones from imports
  deploy [options]   Deploy with OSP auto-provisioning (--platform, --env, --provision, --dry-run)
  context <package>   Generate LLM-friendly context for a package
  context --all        Generate context for all installed dependencies
  context gc           Clean stale context cache entries
  mcp                  Start MCP server for AI agent integration
  search <query>       Search packages across npm and PyPI
  completions <shell>  Generate shell completions (bash, zsh, fish, powershell)
  lint|test|dev|build  Script aliases for better run
  agent <command>      Agent mode: --json --no-color, semantic exit codes
  watch                Watch package.json for changes and auto-react
  changelog <pkg>      Show recent changelog entries for a package
  notify               Proactive update notifications (shell integration)
  graph                Dependency graph (ASCII tree, DOT, Mermaid)
  pin [pkg...]         Pin deps to exact versions (or --unpin)
  clean                Remove node_modules, dist, build artifacts
  env-check            Validate .env against .env.example schema
  trace <package>      Trace dependency resolution paths to a package
  repro                Verify install matches lockfile exactly
  stats                Project dependency statistics overview
  format               Normalize and format package.json
  check                Run all health checks (pre-commit / CI)
  report               Generate shareable dependency report (Markdown/HTML)
  unused               Detect packages not imported in source code
  import-map           Generate ESM import map (CDN or local)
  licenses-report      Full license compliance report (CSV/table)
  bundle-check         Bundle size impact analysis per package
  workspace-graph      Monorepo workspace dependency graph
  bump <type>          Bump semver version (patch/minor/major/prerelease)
  release <type>       Full release workflow (test, bump, tag, publish)
  compat               Check Node.js version compatibility of packages
  fix                  Auto-fix common project issues
  deprecations         Scan for deprecated packages with alternatives
  security             Comprehensive security check (audit+supply+licenses)
  perf                 Performance hints — lighter alternatives, duplicates
  contributors         Analyze package maintainers and bus factor risk
  snapshot <subcmd>    Lockfile snapshot management (save/restore/diff)
  score                Overall project health score (0-100, grade A-F)
  types-check          Check TypeScript type definitions availability
  exports-check        Validate package.json exports field paths
  publish-check        Pre-publish checklist for npm publishing
  changelog-gen        Generate CHANGELOG.md from git conventional commits
  lockfile-lint        Validate package-lock.json integrity and security
  init                 Initialize project with best-practice scaffolding
  deps-check           Audit dependency placement (prod vs dev)
  node-version         Check and manage Node.js version requirements
  pkg-info <pkg>       Detailed package information from npm registry
  circular             Detect circular imports in source code
  pack-size            Analyze what npm pack will include and sizes
  dep-age              Show the age of installed dependency versions
  env-diff <f1> <f2>   Diff two .env files
  license-compat       Check license compatibility between deps and project
  tree                 Display visual dependency tree
  module-check         Verify ESM/CJS module format consistency
  scripts-check        Validate package.json scripts
  registry-status      Check npm registry connectivity and latency
  peer-deps            Check for peer dependency issues
  overrides <subcmd>   Manage package.json overrides/resolutions
  doctor-fix           Auto-fix common project issues
  version-history <p>  Show published version history for a package
  namespace            Analyze package scopes and namespaces
  config-check         Validate project configuration files
  hooks                Manage git hooks (husky/lefthook detection)
  duplicates           Find duplicate packages with version conflicts
  missing              Find imports that are not in package.json
  find <package>       Reverse dependency lookup — who depends on X
  prune                Remove extraneous packages from node_modules
  summarize            Generate human-readable project summary
  install-check        Verify npm installation health and integrity
  patch <subcmd>       Create and apply node_modules patches
  workspace-run <s>    Run scripts across all workspace packages
  fund                 Show funding information for installed packages
  provenance           Check package provenance attestations
  interactive          Interactive TUI for dependency management
  telemetry <on|off|status>  Manage opt-in anonymous usage telemetry

Sardis / OSP commands:
  login [--sardis]                    Authenticate with Sardis or registry
  logout [--sardis]                   Remove saved credentials
  pay <package> [--all] [--budget N]  Pay for package access via Sardis
  publish [--monetize]                Publish package with optional monetisation
  earnings [--breakdown]              View your Sardis earnings
  sponsor <package> [--monthly N]     Sponsor a package with a recurring amount
  provision <domain/offering> [--tier] [--pay sardis]
                                      Provision an OSP service offering
  discover <domain>                   Discover available OSP offerings for a domain
  services [list|status]              List or check status of provisioned services
  deprovision <resource_id>           Remove a provisioned OSP resource
  env-gen [--output .env]             Generate .env file from provisioned services

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
    let coreVersion = "not installed";
    try {
      const { execFileSync } = await import("node:child_process");
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
      coreVersion = execFileSync(join(binDir, "better-core"), ["--version"], { encoding: "utf8" }).trim();
    } catch {}
    printText(`better v${VERSION} (core: ${coreVersion})`);
    return;
  }

  if (first?.startsWith("-")) {
    printText(HELP);
    process.exitCode = 2;
    return;
  }

  // Agent mode: `better agent <command>` = `better <command> --json --no-color`
  let agentMode = false;
  let command;
  let rest;
  if (first === "agent") {
    agentMode = true;
    command = argv[1];
    if (!command) {
      printJson({ error: true, code: "command_not_found", message: "agent mode requires a command (e.g., better agent install)" });
      process.exitCode = 1;
      return;
    }
    rest = ["--json", "--no-color", ...argv.slice(2)];
  } else {
    command = first;
    rest = argv.slice(1);
  }

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
        await (await import("./commands/install.js")).cmdInstall(rest);
        break;
      case "analyze":
        await (await import("./commands/analyze.js")).cmdAnalyze(rest);
        break;
      case "cache":
        await (await import("./commands/cache.js")).cmdCache(rest);
        break;
      case "doctor":
        await (await import("./commands/doctor.js")).cmdDoctor(rest);
        break;
      case "serve":
        await (await import("./commands/serve.js")).cmdServe(rest);
        break;
      case "benchmark":
        await (await import("./commands/benchmark.js")).cmdBenchmark(rest);
        break;
      case "lock":
        await (await import("./commands/lock.js")).cmdLock(rest);
        break;
      case "merge-driver":
        await (await import("./commands/mergeDriver.js")).runMergeDriver(rest);
        break;
      case "risk":
        await (await import("./commands/risk.js")).cmdRisk(rest);
        break;
      case "upgrade":
        await (await import("./commands/upgrade.js")).cmdUpgrade(rest);
        break;
      case "update":
      case "up":
        await (await import("./commands/update.js")).cmdUpdate(rest);
        break;
      case "size":
        await (await import("./commands/size.js")).cmdSize(rest);
        break;
      case "prefetch":
        await (await import("./commands/prefetch.js")).cmdPrefetch(rest);
        break;
      case "delta":
        await (await import("./commands/delta.js")).cmdDelta(rest);
        break;
      case "diff":
        await (await import("./commands/diff.js")).cmdDiff(rest);
        break;
      case "ci":
        await (await import("./commands/ci.js")).cmdCi(rest);
        break;
      case "policy":
        await (await import("./commands/policy.js")).cmdPolicy(rest);
        break;
      case "workspace":
        await (await import("./commands/workspace.js")).cmdWorkspace(rest);
        break;
      case "audit":
        // check if subcommand is 'fix'
        if (rest[0] === "fix") {
          await (await import("./commands/audit-fix.js")).cmdAuditFix(rest.slice(1));
        } else {
          await (await import("./commands/audit.js")).cmdAudit(rest);
        }
        break;
      case "maintenance":
        await (await import("./commands/maintenance.js")).cmdMaintenance(rest);
        break;
      case "dashboard":
        await (await import("./commands/dashboard.js")).cmdDashboard(rest);
        break;
      case "run":
        await (await import("./commands/run.js")).cmdRun(rest);
        break;
      case "why":
        await (await import("./commands/why.js")).cmdWhy(rest);
        break;
      case "license":
        await (await import("./commands/license.js")).cmdLicense(rest);
        break;
      case "dedupe":
        await (await import("./commands/dedupe.js")).cmdDedupe(rest);
        break;
      case "outdated":
        await (await import("./commands/outdated.js")).cmdOutdated(rest);
        break;
      case "scripts":
        await (await import("./commands/scripts.js")).cmdScripts(rest);
        break;
      case "suggest":
        await (await import("./commands/suggest.js")).cmdSuggest(rest);
        break;
      case "deploy":
        await (await import("./commands/deploy.js")).cmdDeploy(rest);
        break;
      case "env":
        await (await import("./commands/env.js")).cmdEnv(rest);
        break;
      case "cost":
        await (await import("./commands/cost.js")).cmdCost(rest);
        break;
      case "impact":
        await (await import("./commands/impact.js")).cmdImpact(rest);
        break;
      case "preview":
        await (await import("./commands/preview.js")).cmdPreview(rest);
        break;
      case "infra":
        await (await import("./commands/infra.js")).cmdInfra(rest);
        break;
      case "sign":
        await (await import("./commands/sign.js")).cmdSign(rest);
        break;
      case "plugin":
        await (await import("./commands/plugin.js")).cmdPlugin(rest);
        break;
      case "registry":
        await (await import("./commands/registry.js")).cmdRegistry(rest);
        break;
      case "pr-bot":
        await (await import("./commands/pr-bot.js")).cmdPrBot(rest);
        break;
      case "ai":
        await (await import("./commands/ai-advisor.js")).cmdAi(rest);
        break;
      case "semver":
        await (await import("./commands/semantic-version.js")).cmdSemver(rest);
        break;
      case "why-not":
        await (await import("./commands/why-not.js")).cmdWhyNot(rest);
        break;
      case "link":
        await (await import("./commands/link.js")).cmdLink(rest);
        break;
      case "heal":
        await (await import("./commands/heal.js")).cmdHeal(rest);
        break;
      case "orchestrate":
        await (await import("./commands/orchestrate.js")).cmdOrchestrate(rest);
        break;
      case "cross-project":
        await (await import("./commands/cross-project.js")).cmdCrossProject(rest);
        break;
      case "telemetry":
        await (await import("./commands/telemetry.js")).cmdTelemetry(rest);
        break;
      case "pipeline":
        await (await import("./commands/pipeline.js")).cmdPipeline(rest);
        break;
      case "insights":
        await (await import("./commands/insights.js")).cmdInsights(rest);
        break;
      case "sbom":
        await (await import("./commands/sbom.js")).cmdSbom(rest);
        break;
      case "config":
        await (await import("./commands/config.js")).cmdConfig(rest);
        break;
      case "watch":
        await (await import("./commands/watch.js")).cmdWatch(rest);
        break;
      case "changelog":
        await (await import("./commands/changelog.js")).cmdChangelog(rest);
        break;
      case "notify":
        await (await import("./commands/notify.js")).cmdNotify(rest);
        break;
      case "graph":
        await (await import("./commands/graph.js")).cmdGraph(rest);
        break;
      case "pin":
        await (await import("./commands/pin.js")).cmdPin(rest);
        break;
      case "clean":
        await (await import("./commands/clean.js")).cmdClean(rest);
        break;
      case "env-check":
        await (await import("./commands/env-check.js")).cmdEnvCheck(rest);
        break;
      case "trace":
        await (await import("./commands/trace.js")).cmdTrace(rest);
        break;
      case "repro":
        await (await import("./commands/repro.js")).cmdRepro(rest);
        break;
      case "stats":
        await (await import("./commands/stats.js")).cmdStats(rest);
        break;
      case "format":
        await (await import("./commands/format.js")).cmdFormat(rest);
        break;
      case "check":
        await (await import("./commands/check.js")).cmdCheck(rest);
        break;
      case "report":
        await (await import("./commands/report.js")).cmdReport(rest);
        break;
      case "unused":
        await (await import("./commands/unused.js")).cmdUnused(rest);
        break;
      case "import-map":
        await (await import("./commands/import-map.js")).cmdImportMap(rest);
        break;
      case "licenses-report":
        await (await import("./commands/licenses-report.js")).cmdLicensesReport(rest);
        break;
      case "bundle-check":
        await (await import("./commands/bundle-check.js")).cmdBundleCheck(rest);
        break;
      case "workspace-graph":
        await (await import("./commands/workspace-graph.js")).cmdWorkspaceGraph(rest);
        break;
      case "bump":
        await (await import("./commands/bump.js")).cmdBump(rest);
        break;
      case "release":
        await (await import("./commands/release.js")).cmdRelease(rest);
        break;
      case "compat":
        await (await import("./commands/compat.js")).cmdCompat(rest);
        break;
      case "fix":
        await (await import("./commands/fix.js")).cmdFix(rest);
        break;
      case "deprecations":
        await (await import("./commands/deprecations.js")).cmdDeprecations(rest);
        break;
      case "security":
        await (await import("./commands/security.js")).cmdSecurity(rest);
        break;
      case "perf":
        await (await import("./commands/perf.js")).cmdPerf(rest);
        break;
      case "contributors":
        await (await import("./commands/contributors.js")).cmdContributors(rest);
        break;
      case "snapshot":
        await (await import("./commands/snapshot.js")).cmdSnapshot(rest);
        break;
      case "score":
        await (await import("./commands/score.js")).cmdScore(rest);
        break;
      case "types-check":
        await (await import("./commands/types-check.js")).cmdTypesCheck(rest);
        break;
      case "exports-check":
        await (await import("./commands/exports-check.js")).cmdExportsCheck(rest);
        break;
      case "publish-check":
        await (await import("./commands/publish-check.js")).cmdPublishCheck(rest);
        break;
      case "changelog-gen":
        await (await import("./commands/changelog-gen.js")).cmdChangelogGen(rest);
        break;
      case "lockfile-lint":
        await (await import("./commands/lockfile-lint.js")).cmdLockfileLint(rest);
        break;
      case "init":
        await (await import("./commands/init.js")).cmdInit(rest);
        break;
      case "deps-check":
        await (await import("./commands/deps-check.js")).cmdDepsCheck(rest);
        break;
      case "node-version":
        await (await import("./commands/node-version.js")).cmdNodeVersion(rest);
        break;
      case "pkg-info":
        await (await import("./commands/pkg-info.js")).cmdPkgInfo(rest);
        break;
      case "circular":
        await (await import("./commands/circular.js")).cmdCircular(rest);
        break;
      case "pack-size":
        await (await import("./commands/pack-size.js")).cmdPackSize(rest);
        break;
      case "dep-age":
        await (await import("./commands/dep-age.js")).cmdDepAge(rest);
        break;
      case "env-diff":
        await (await import("./commands/env-diff.js")).cmdEnvDiff(rest);
        break;
      case "license-compat":
        await (await import("./commands/license-compat.js")).cmdLicenseCompat(rest);
        break;
      case "tree":
        await (await import("./commands/tree.js")).cmdTree(rest);
        break;
      case "module-check":
        await (await import("./commands/module-check.js")).cmdModuleCheck(rest);
        break;
      case "scripts-check":
        await (await import("./commands/scripts-check.js")).cmdScriptsCheck(rest);
        break;
      case "registry-status":
        await (await import("./commands/registry-status.js")).cmdRegistryStatus(rest);
        break;
      case "peer-deps":
        await (await import("./commands/peer-deps.js")).cmdPeerDeps(rest);
        break;
      case "overrides":
        await (await import("./commands/overrides.js")).cmdOverrides(rest);
        break;
      case "doctor-fix":
        await (await import("./commands/doctor-fix.js")).cmdDoctorFix(rest);
        break;
      case "version-history":
        await (await import("./commands/version-history.js")).cmdVersionHistory(rest);
        break;
      case "namespace":
        await (await import("./commands/namespace.js")).cmdNamespace(rest);
        break;
      case "config-check":
        await (await import("./commands/config-check.js")).cmdConfigCheck(rest);
        break;
      case "hooks":
        await (await import("./commands/hooks.js")).cmdHooks(rest);
        break;
      case "duplicates":
        await (await import("./commands/duplicates.js")).cmdDuplicates(rest);
        break;
      case "missing":
        await (await import("./commands/missing.js")).cmdMissing(rest);
        break;
      case "find":
        await (await import("./commands/find.js")).cmdFind(rest);
        break;
      case "prune":
        await (await import("./commands/prune.js")).cmdPrune(rest);
        break;
      case "summarize":
        await (await import("./commands/summarize.js")).cmdSummarize(rest);
        break;
      case "install-check":
        await (await import("./commands/install-check.js")).cmdInstallCheck(rest);
        break;
      case "patch":
        await (await import("./commands/patch.js")).cmdPatch(rest);
        break;
      case "workspace-run":
        await (await import("./commands/workspace-run.js")).cmdWorkspaceRun(rest);
        break;
      case "fund":
        await (await import("./commands/fund.js")).cmdFund(rest);
        break;
      case "provenance":
        await (await import("./commands/provenance.js")).cmdProvenance(rest);
        break;
      case "interactive":
        await (await import("./commands/interactive.js")).cmdInteractive(rest);
        break;
      case "completions": {
        const shell = rest[0] || "bash";
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync("better-core", ["completions", shell], { stdio: "inherit" });
        process.exitCode = result.status;
        break;
      }
      case "context": {
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync("better-core", ["context", ...rest], { stdio: "inherit" });
        process.exitCode = result.status;
        break;
      }
      case "mcp": {
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync("better-core", ["mcp", ...rest], { stdio: ["pipe", "pipe", "inherit"] });
        if (result.stdout) process.stdout.write(result.stdout);
        process.exitCode = result.status;
        break;
      }
      case "search": {
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync("better-core", ["search", ...rest], { stdio: "inherit" });
        process.exitCode = result.status;
        break;
      }
      case "reputation": {
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync("better-core", ["reputation", ...rest], { stdio: "inherit" });
        process.exitCode = result.status;
        break;
      }
      case "supply-chain":
        await (await import("./commands/supply-chain.js")).cmdSupplyChain(rest);
        break;
      case "login":
      case "logout":
      case "pay":
      case "publish":
      case "earnings":
      case "sponsor":
      case "provision":
      case "discover":
      case "services":
      case "deprovision":
      case "env-gen": {
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync("better-core", [command, ...rest], { stdio: "inherit" });
        process.exitCode = result.status;
        break;
      }
      case "lint":
      case "test":
      case "dev":
      case "build":
        await (await import("./commands/run.js")).cmdRun(rest, { aliasScript: command });
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
