import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { getCacheRoot, cacheLayout } from "../lib/cache.js";
import { runDashboard } from "../tui/dashboard.js";

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function findLatestRun(runsDir) {
  try {
    const files = await fs.readdir(runsDir);
    const jsonFiles = files.filter(f => f.endsWith(".json")).sort().reverse();
    if (jsonFiles.length === 0) return null;
    return await readJsonFile(path.join(runsDir, jsonFiles[0]));
  } catch {
    return null;
  }
}

async function loadHealthReport(projectRoot) {
  // Try common locations for health report
  const candidates = [
    path.join(projectRoot, "health.json"),
    path.join(projectRoot, ".better", "health.json")
  ];

  for (const p of candidates) {
    const data = await readJsonFile(p);
    if (data) return data;
  }

  return null;
}

async function loadBenchmarkData(projectRoot) {
  const candidates = [
    path.join(projectRoot, "benchmark.json"),
    path.join(projectRoot, ".better", "benchmark.json")
  ];

  for (const p of candidates) {
    const data = await readJsonFile(p);
    if (data) return data;
  }

  return null;
}

async function loadAuditData(projectRoot) {
  const candidates = [
    path.join(projectRoot, "audit.json"),
    path.join(projectRoot, ".better", "audit.json")
  ];

  for (const p of candidates) {
    const data = await readJsonFile(p);
    if (data?.kind === "better.audit.report") return data;
  }

  return null;
}

function buildDepTree(lockData) {
  if (!lockData?.packages) return null;

  const root = { name: "project", version: "root", children: [] };
  const nodeMap = new Map();

  // Build direct dependencies first
  const rootPkg = lockData.packages[""];
  if (!rootPkg) return root;

  const directDeps = {
    ...(rootPkg.dependencies ?? {}),
    ...(rootPkg.devDependencies ?? {})
  };

  for (const [name, range] of Object.entries(directDeps)) {
    const pkgKey = `node_modules/${name}`;
    const info = lockData.packages[pkgKey];
    const version = info?.version ?? range;

    const node = {
      name,
      version,
      children: [],
      vulnerable: false
    };

    nodeMap.set(name, node);
    root.children.push(node);

    // Add sub-dependencies (one level deep for performance)
    if (info?.dependencies) {
      for (const [subName, subRange] of Object.entries(info.dependencies)) {
        const subKey = `node_modules/${name}/node_modules/${subName}`;
        const subInfo = lockData.packages[subKey] ?? lockData.packages[`node_modules/${subName}`];
        const subVersion = subInfo?.version ?? subRange;

        node.children.push({
          name: subName,
          version: subVersion,
          children: [],
          vulnerable: false
        });
      }
    }
  }

  return root;
}

async function loadCacheStats(layout) {
  try {
    const stateFile = path.join(layout.root, "state.json");
    const state = await readJsonFile(stateFile);
    if (!state) return null;

    const metrics = state.cacheMetrics ?? {};
    const entries = Object.keys(state.cacheEntries ?? {}).length;
    const hitRate = metrics.installRuns > 0
      ? Math.round((metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses)) * 100)
      : 0;

    // Build recent decisions from runs
    const recentDecisions = [];
    const projects = Object.values(state.projects ?? {});
    for (const p of projects.slice(-20)) {
      recentDecisions.push(p.lastCacheHit ? "hit" : "miss");
    }

    return {
      entries,
      totalSizeBytes: 0, // would need to scan
      hitRate,
      installRuns: metrics.installRuns ?? 0,
      cacheHits: metrics.cacheHits ?? 0,
      cacheMisses: metrics.cacheMisses ?? 0,
      recentDecisions,
      installTimes: [] // would need to read run reports
    };
  } catch {
    return null;
  }
}

export async function cmdDashboard(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better dashboard [options]

Options:
  --project-root PATH   Override project root
  --cache-root PATH     Override cache root

Interactive TUI dashboard showing:
  - Install summary and metrics
  - Dependency tree explorer (vim navigation)
  - Cache statistics and hit/miss heatmap
  - Health score and findings
  - Benchmark sparklines

Keyboard:
  1-5      Switch panels
  Tab      Next panel
  j/k      Navigate tree
  Enter    Expand/collapse
  q        Quit
  ?        Help
`);
    return;
  }

  // Check if stdout is a TTY
  if (!process.stdout.isTTY) {
    printText("Error: dashboard requires an interactive terminal (TTY).");
    process.exitCode = 1;
    return;
  }

  const runtime = getRuntimeConfig();
  const logger = childLogger({ command: "dashboard" });
  const { values } = parseArgs({
    args: argv,
    options: {
      "project-root": { type: "string" },
      "cache-root": { type: "string", default: runtime.cacheRoot ?? undefined }
    },
    allowPositionals: true,
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]), reason: "flag:--project-root" }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const cacheRoot = getCacheRoot(values["cache-root"]);
  const layout = cacheLayout(cacheRoot);

  logger.info("dashboard.start", { projectRoot });

  // Load project info
  const pkg = await readJsonFile(path.join(projectRoot, "package.json"));
  const projectInfo = {
    name: pkg?.name ?? path.basename(projectRoot),
    version: pkg?.version ?? "0.0.0",
    root: projectRoot,
    pm: "npm" // could detect
  };

  // Load data sources in parallel
  const [installReport, healthReport, benchmarkData, cacheStats, auditData] = await Promise.all([
    findLatestRun(layout.runsDir ?? path.join(layout.root, "runs")),
    loadHealthReport(projectRoot),
    loadBenchmarkData(projectRoot),
    loadCacheStats(layout),
    loadAuditData(projectRoot)
  ]);

  // Build dependency tree from lockfile
  const lockData = await readJsonFile(path.join(projectRoot, "package-lock.json"));
  const depTree = buildDepTree(lockData);

  // Launch dashboard
  await runDashboard({
    projectInfo,
    installReport,
    healthReport,
    cacheStats,
    benchmarkData,
    depTree,
    vulnData: auditData
  });

  logger.info("dashboard.end");
}
