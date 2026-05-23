import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { runAnalyzeOrgNapi } from "../lib/core.js";
import fs from "node:fs/promises";
import { join } from "node:path";

// Known consolidation patterns
const CONSOLIDATIONS = [
  { category: "http-client", packages: ["axios", "node-fetch", "got", "superagent", "ky"], recommendation: "Pick one HTTP client org-wide" },
  { category: "date-library", packages: ["moment", "date-fns", "dayjs", "luxon"], recommendation: "Use date-fns or dayjs everywhere" },
  { category: "test-framework", packages: ["jest", "mocha", "vitest", "jasmine"], recommendation: "Standardize on one test framework" },
  { category: "bundler", packages: ["webpack", "vite", "rollup", "parcel", "esbuild"], recommendation: "Standardize on one bundler" },
  { category: "logger", packages: ["winston", "pino", "bunyan", "log4js"], recommendation: "Standardize on one logger" },
  { category: "orm", packages: ["sequelize", "typeorm", "prisma", "drizzle-orm", "mongoose"], recommendation: "Standardize on one ORM" },
];

/**
 * `better insights [DIR]` — org-level cross-project dependency analysis
 */
export async function cmdInsights(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage: better insights [DIR] [options]

Org-level cross-project dependency analysis.
Analyzes all subdirectories with package.json files.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better insights           # analyze subdirs of current directory
  better insights ~/projects
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const useJson = values.json;
  const rootDir = positionals[0] ? path.resolve(positionals[0]) : process.cwd();

  // NAPI fast path: Rust analyze_org
  const napiResult = runAnalyzeOrgNapi(rootDir);
  if (napiResult?.ok && napiResult.data && napiResult.data.projects_analyzed > 0) {
    const r = napiResult.data;
    const result = {
      ok: true,
      kind: "better.insights",
      projects_analyzed: r.projects_analyzed,
      total_unique_deps: r.total_unique_deps,
      total_dep_instances: r.total_dep_instances,
      version_inconsistencies: r.version_inconsistencies ?? [],
      consolidation_opportunities: r.consolidation_opportunities ?? [],
      standardization_score: r.standardization_score,
    };
    if (useJson) { printJson(result); }
    else {
      printText(`\nbetter — Org Insights (${r.projects_analyzed} projects)\n`);
      printText(`Unique dependencies: ${r.total_unique_deps} (${r.total_dep_instances} total instances)`);
      printText(`Standardization score: ${r.standardization_score}/100\n`);
      if (r.version_inconsistencies?.length > 0) {
        printText(`Version inconsistencies (${r.version_inconsistencies.length}):`);
        for (const inc of r.version_inconsistencies.slice(0, 10)) {
          const versions = Object.keys(inc.versions).join(", ");
          printText(`  ${inc.package}: ${versions} → recommend ${inc.recommended}`);
        }
      }
      if (r.consolidation_opportunities?.length > 0) {
        printText(`\nConsolidation opportunities:`);
        for (const opp of r.consolidation_opportunities) {
          printText(`  ${opp.category}: ${opp.packages.join(" + ")} → ${opp.recommended}`);
          printText(`    ${opp.reason} (affects ${opp.projects.length} projects)`);
        }
      }
      if (!r.version_inconsistencies?.length && !r.consolidation_opportunities?.length) {
        printText("Dependencies are well-standardized across projects.");
      }
    }
    return;
  }

  // JS fallback: Discover projects
  const projects = [];
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const pkgPath = join(rootDir, entry.name, "package.json");
      try {
        const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        projects.push({ name: entry.name, path: join(rootDir, entry.name), deps });
      } catch {}
    }
  } catch (err) {
    const msg = `Cannot read directory: ${err.message}`;
    if (useJson) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  if (projects.length === 0) {
    if (useJson) { printJson({ ok: true, kind: "better.insights", projects_analyzed: 0, message: "No projects found" }); }
    else { printText("No projects with package.json found in subdirectories."); }
    return;
  }

  // Aggregate all dependencies
  const allDeps = new Map(); // pkg -> Map(version -> [projects])
  let totalInstances = 0;
  for (const project of projects) {
    for (const [dep, version] of Object.entries(project.deps || {})) {
      totalInstances++;
      if (!allDeps.has(dep)) allDeps.set(dep, new Map());
      const versions = allDeps.get(dep);
      if (!versions.has(version)) versions.set(version, []);
      versions.get(version).push(project.name);
    }
  }

  // Find version inconsistencies
  const inconsistencies = [];
  for (const [pkg, versions] of allDeps) {
    if (versions.size > 1) {
      const recommended = [...versions.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
      inconsistencies.push({ package: pkg, versions: Object.fromEntries(versions), recommended });
    }
  }
  inconsistencies.sort((a, b) => Object.keys(b.versions).length - Object.keys(a.versions).length);

  // Find consolidation opportunities
  const consolidationOpps = [];
  for (const { category, packages, recommendation } of CONSOLIDATIONS) {
    const found = packages.filter(p => allDeps.has(p));
    if (found.length > 1) {
      const projectsAffected = new Set();
      for (const pkg of found) {
        for (const projs of allDeps.get(pkg).values()) {
          for (const p of projs) projectsAffected.add(p);
        }
      }
      const mostUsed = found.reduce((a, b) => {
        const aCount = [...(allDeps.get(a)?.values() || [])].flat().length;
        const bCount = [...(allDeps.get(b)?.values() || [])].flat().length;
        return aCount >= bCount ? a : b;
      });
      consolidationOpps.push({ category, packages: found, projects: [...projectsAffected], recommended: mostUsed, reason: recommendation });
    }
  }

  const score = Math.max(0, 100 - inconsistencies.length * 5 - consolidationOpps.length * 10);

  const result = {
    ok: true,
    kind: "better.insights",
    projects_analyzed: projects.length,
    total_unique_deps: allDeps.size,
    total_dep_instances: totalInstances,
    version_inconsistencies: inconsistencies.slice(0, 20),
    consolidation_opportunities: consolidationOpps,
    standardization_score: score,
  };

  if (useJson) {
    printJson(result);
  } else {
    printText(`\nbetter — Org Insights (${projects.length} projects)\n`);
    printText(`Unique dependencies: ${allDeps.size} (${totalInstances} total instances)`);
    printText(`Standardization score: ${score}/100\n`);

    if (inconsistencies.length > 0) {
      printText(`Version inconsistencies (${inconsistencies.length}):`);
      for (const inc of inconsistencies.slice(0, 10)) {
        const versions = Object.keys(inc.versions).join(", ");
        printText(`  ${inc.package}: ${versions} → recommend ${inc.recommended}`);
      }
    }

    if (consolidationOpps.length > 0) {
      printText(`\nConsolidation opportunities:`);
      for (const opp of consolidationOpps) {
        printText(`  ${opp.category}: ${opp.packages.join(" + ")} → use ${opp.recommended}`);
        printText(`    ${opp.reason} (affects ${opp.projects.length} projects)`);
      }
    }

    if (inconsistencies.length === 0 && consolidationOpps.length === 0) {
      printText("Dependencies are well-standardized across projects.");
    }
  }
}
