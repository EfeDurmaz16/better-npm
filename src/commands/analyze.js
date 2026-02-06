import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { analyzeWithBestEngine } from "../lib/analyzeFacade.js";
import { printJson, printText } from "../lib/output.js";
import { getCacheRoot, cacheLayout, ensureCacheDirs, loadState, saveState } from "../lib/cache.js";
import { nowIso } from "../lib/time.js";
import { shortHash } from "../lib/hash.js";
import { enrichPackagesWithManifest } from "../lib/packageMeta.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";

async function serveUi(analysis) {
  const html = await fs.readFile(new URL("../ui/index.html", import.meta.url), "utf8");
  const js = await fs.readFile(new URL("../ui/app.js", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../ui/style.css", import.meta.url), "utf8");

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.url === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(js);
      return;
    }
    if (req.url === "/style.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(css);
      return;
    }
    if (req.url === "/analysis.json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(`${JSON.stringify(analysis, null, 2)}\n`);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const url = `http://${addr.address}:${addr.port}/`;
  printText(`UI running at ${url} (Ctrl+C to stop)`);
}

async function readDirectDependencyNames(projectRoot) {
  const pkgPath = path.join(projectRoot, "package.json");
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    const names = new Set();
    for (const group of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      if (pkg?.[group] && typeof pkg[group] === "object") {
        for (const name of Object.keys(pkg[group])) names.add(name);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

function buildLongestChain(graph, directNames) {
  if (!graph?.edges || !graph?.nodes) return [];
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }

  const starts = [];
  for (const node of Object.values(graph.nodes)) {
    if (directNames.has(node.name)) {
      starts.push(node.key);
    }
  }
  if (starts.length === 0) {
    starts.push(...Object.keys(graph.nodes));
  }

  const memo = new Map();
  const visiting = new Set();
  const walk = (key) => {
    if (memo.has(key)) return memo.get(key);
    if (visiting.has(key)) return [key];
    visiting.add(key);
    let best = [key];
    const children = adjacency.get(key) ?? [];
    for (const child of children) {
      const candidate = [key, ...walk(child)];
      if (candidate.length > best.length) best = candidate;
    }
    visiting.delete(key);
    memo.set(key, best);
    return best;
  };

  let longest = [];
  for (const start of starts) {
    const candidate = walk(start);
    if (candidate.length > longest.length) longest = candidate;
  }
  return longest;
}

function buildDuplicateDetails(packages, duplicates) {
  const byNameVersion = new Map();
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (!byNameVersion.has(key)) byNameVersion.set(key, []);
    byNameVersion.get(key).push(...(pkg.paths ?? []));
  }

  return (duplicates ?? []).map((dup) => {
    const versions = (dup.versions ?? []).map((version) => {
      const key = `${dup.name}@${version}`;
      const paths = byNameVersion.get(key) ?? [];
      return {
        version,
        count: paths.length,
        paths
      };
    });
    return {
      name: dup.name,
      versions,
      totalVersions: versions.length,
      totalInstances: versions.reduce((sum, v) => sum + v.count, 0)
    };
  });
}

function buildLargestPackages(packages, limit = 20) {
  return [...packages]
    .filter((pkg) => pkg.sizes?.physicalBytes != null)
    .sort((a, b) => (b.sizes?.physicalBytes ?? 0) - (a.sizes?.physicalBytes ?? 0))
    .slice(0, limit)
    .map((pkg) => ({
      key: pkg.key,
      name: pkg.name,
      version: pkg.version,
      physicalBytes: pkg.sizes?.physicalBytes ?? 0,
      logicalBytes: pkg.sizes?.logicalBytes ?? 0,
      fileCount: pkg.sizes?.fileCount ?? 0
    }));
}

function buildDeprecatedPackages(packages) {
  const entries = [];
  for (const pkg of packages) {
    if (!pkg.deprecated) continue;
    entries.push({
      key: pkg.key,
      name: pkg.name,
      version: pkg.version,
      message: pkg.deprecated,
      paths: pkg.paths ?? []
    });
  }
  return entries;
}

async function buildReport(baseAnalysis, projectRoot) {
  if (!baseAnalysis?.ok) return baseAnalysis;

  const packages = await enrichPackagesWithManifest(baseAnalysis.packages ?? []);
  const directNames = await readDirectDependencyNames(projectRoot);
  const longestChain = buildLongestChain(baseAnalysis.graph, directNames);
  const duplicatesDetailed = buildDuplicateDetails(packages, baseAnalysis.duplicates ?? []);
  const deprecatedPackages = buildDeprecatedPackages(packages);
  const largestPackages = buildLargestPackages(packages, 20);

  const directPackagesInstalled = packages.filter((pkg) => directNames.has(pkg.name)).length;
  const logicalSizeBytes = baseAnalysis.nodeModules?.logicalBytes ?? 0;
  const physicalSizeBytes = baseAnalysis.nodeModules?.physicalBytes ?? 0;

  return {
    ...baseAnalysis,
    schemaVersion: 2,
    generatedAt: nowIso(),
    packages,
    summary: {
      totalPackages: packages.length,
      directDependencies: directNames.size,
      directPackagesInstalled,
      transitivePackages: Math.max(0, packages.length - directPackagesInstalled),
      logicalSizeBytes,
      physicalSizeBytes,
      maxDepth: baseAnalysis.depth?.maxDepth ?? 0,
      longestChain
    },
    duplicatesDetailed,
    deprecated: {
      totalDeprecated: deprecatedPackages.length,
      packages: deprecatedPackages
    },
    largestPackages
  };
}

export async function cmdAnalyze(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better analyze [--json] [--out FILE] [--serve] [--no-graph]
                 [--core|--no-core] [--cache-root PATH] [--no-save]
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "analyze" });
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      serve: { type: "boolean", default: false },
      ui: { type: "boolean", default: false },
      out: { type: "string" },
      "no-graph": { type: "boolean", default: false },
      core: { type: "boolean", default: false },
      "no-core": { type: "boolean", default: false },
      "cache-root": { type: "string", default: runtime.cacheRoot ?? undefined },
      save: { type: "boolean", default: true }
    },
    allowPositionals: true,
    strict: false
  });

  const projectRoot = process.cwd();
  const coreMode = values["no-core"] ? "off" : values.core ? "force" : "auto";
  commandLogger.info("analyze.start", { projectRoot, coreMode });

  const { analysis, engine } = await analyzeWithBestEngine(projectRoot, {
    includeGraph: !values["no-graph"],
    coreMode
  });
  const report = await buildReport(analysis, projectRoot);
  commandLogger.info("analyze.done", { engine, ok: report.ok });

  if (values.save) {
    const cacheRoot = getCacheRoot(values["cache-root"]);
    let layout = cacheLayout(cacheRoot);
    layout = await ensureCacheDirs(layout, { projectRootForFallback: projectRoot });
    const state = await loadState(layout);
    const projectId = shortHash(projectRoot);
    const analysisId = `${Date.now()}-${shortHash(`${projectRoot}:analysis`)}`;
    const savedPath = path.join(layout.analysesDir, `${analysisId}.json`);
    await fs.writeFile(savedPath, `${JSON.stringify({ ...report, savedAt: nowIso(), analysisId }, null, 2)}\n`);

    if (report.ok) {
      for (const p of report.packages) {
        const key = p.key;
        const entry = state.analysesIndex[key] ?? { lastSeenAt: null, projects: {} };
        entry.lastSeenAt = nowIso();
        entry.projects[projectId] = entry.lastSeenAt;
        state.analysesIndex[key] = entry;
      }
    }
    await saveState(layout, state);
  }

  if (values.out) {
    const outPath = path.resolve(values.out);
    await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const shouldServe = values.serve || values.ui;
  if (values.json || !shouldServe) {
    if (values.json) {
      printJson(report);
      return;
    }
    if (!report.ok) {
      printText(`better analyze: ${report.reason}`);
      process.exitCode = 1;
      return;
    }
    const top = [...report.largestPackages]
      .slice(0, 10);
    printText(
      [
        "better analyze",
        `- packages: ${report.summary.totalPackages}`,
        `- direct dependencies: ${report.summary.directDependencies}`,
        `- max depth: ${report.summary.maxDepth} (p95: ${report.depth?.p95Depth ?? 0})`,
        `- duplicates: ${report.duplicatesDetailed.length}`,
        `- deprecated: ${report.deprecated.totalDeprecated}`,
        `- node_modules (logical/physical): ${(report.summary.logicalSizeBytes / 1024 / 1024).toFixed(1)} MiB / ${(report.summary.physicalSizeBytes / 1024 / 1024).toFixed(1)} MiB`,
        "- top packages by (attributed) physical bytes:",
        ...top.map((p) => `  - ${p.key}: ${(p.physicalBytes / 1024 / 1024).toFixed(1)} MiB`)
      ].join("\n")
    );
    return;
  }

  await serveUi(report);
}
