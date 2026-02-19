import { parseArgs } from "node:util";
import path from "node:path";
import { resolveWorkspacePackages, detectWorkspaceConfig, workspaceSummary } from "../lib/workspaces.js";
import { topoSort, executionPlan, affectedPackages } from "../lib/topoSort.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { runCommand } from "../lib/spawn.js";
import { childLogger } from "../lib/log.js";

/**
 * Format a table row with aligned columns.
 */
function formatTable(rows, headers) {
  if (rows.length === 0) return "";

  const allRows = [headers, ...rows];
  const colWidths = headers.map((_, i) =>
    Math.max(...allRows.map(row => String(row[i] ?? "").length))
  );

  const formatRow = (row) =>
    row.map((cell, i) => String(cell ?? "").padEnd(colWidths[i])).join("  ");

  const lines = [
    formatRow(headers),
    colWidths.map(w => "-".repeat(w)).join("  "),
    ...rows.map(formatRow)
  ];

  return lines.join("\n");
}

/**
 * Draw an ASCII dependency graph.
 */
function drawGraph(packages) {
  const lines = [];
  const nameSet = new Set(packages.map(p => p.name));

  for (const pkg of packages) {
    lines.push(`${pkg.name}@${pkg.version}`);

    const workspaceDeps = pkg.workspaceDeps.filter(d => nameSet.has(d));
    if (workspaceDeps.length > 0) {
      for (let i = 0; i < workspaceDeps.length; i++) {
        const isLast = i === workspaceDeps.length - 1;
        const prefix = isLast ? "└─" : "├─";
        lines.push(`  ${prefix}> ${workspaceDeps[i]}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Get changed files from git diff.
 */
async function getChangedFiles(projectRoot, sinceRef) {
  const res = await runCommand("git", ["diff", "--name-only", sinceRef], {
    cwd: projectRoot,
    passthroughStdio: false
  });

  if (res.exitCode !== 0) {
    throw new Error(`Failed to get git diff: ${res.stderr}`);
  }

  return res.stdout.trim().split("\n").filter(Boolean);
}

/**
 * Map changed files to workspace packages.
 */
function mapFilesToPackages(changedFiles, packages, projectRoot) {
  const changedPackages = new Set();

  for (const file of changedFiles) {
    const filePath = path.resolve(projectRoot, file);

    for (const pkg of packages) {
      const pkgPath = path.resolve(pkg.dir);
      if (filePath.startsWith(pkgPath + path.sep) || filePath === pkgPath) {
        changedPackages.add(pkg.name);
      }
    }
  }

  return [...changedPackages];
}

/**
 * Run command in workspace packages in topological order.
 */
async function runInWorkspaces(packages, command, concurrency) {
  const plan = executionPlan(packages);

  if (!plan.ok) {
    throw new Error(`Cannot execute: ${plan.reason}`);
  }

  const results = [];
  let totalSuccess = 0;
  let totalFailure = 0;

  for (const level of plan.plan) {
    const levelPackages = level.parallel.map(name =>
      packages.find(p => p.name === name)
    ).filter(Boolean);

    if (concurrency === 1 || level.parallel.length === 1) {
      // Sequential execution
      for (const pkg of levelPackages) {
        const startTime = Date.now();
        try {
          const res = await runCommand("sh", ["-c", command], {
            cwd: pkg.dir,
            passthroughStdio: true
          });

          const success = res.exitCode === 0;
          results.push({
            package: pkg.name,
            exitCode: res.exitCode,
            durationMs: Date.now() - startTime,
            success
          });

          if (success) totalSuccess++;
          else totalFailure++;

          if (!success) {
            throw new Error(`Command failed in ${pkg.name} with exit code ${res.exitCode}`);
          }
        } catch (err) {
          totalFailure++;
          throw err;
        }
      }
    } else {
      // Parallel execution (up to concurrency limit)
      const batches = [];
      for (let i = 0; i < levelPackages.length; i += concurrency) {
        batches.push(levelPackages.slice(i, i + concurrency));
      }

      for (const batch of batches) {
        const promises = batch.map(async (pkg) => {
          const startTime = Date.now();
          const res = await runCommand("sh", ["-c", command], {
            cwd: pkg.dir,
            passthroughStdio: false
          });

          const success = res.exitCode === 0;
          return {
            package: pkg.name,
            exitCode: res.exitCode,
            durationMs: Date.now() - startTime,
            success,
            stdout: res.stdout,
            stderr: res.stderr
          };
        });

        const batchResults = await Promise.all(promises);
        results.push(...batchResults);

        for (const r of batchResults) {
          if (r.success) totalSuccess++;
          else totalFailure++;
        }

        const failures = batchResults.filter(r => !r.success);
        if (failures.length > 0) {
          const failedNames = failures.map(f => f.package).join(", ");
          throw new Error(`Command failed in: ${failedNames}`);
        }
      }
    }
  }

  return { results, totalSuccess, totalFailure };
}

export async function cmdWorkspace(argv) {
  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "workspace" });
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printText(`Usage:
  better workspace list [--json] [--project-root PATH]
  better workspace info <name> [--json] [--project-root PATH]
  better workspace graph [--json] [--project-root PATH]
  better workspace changed [--since <ref>] [--json] [--project-root PATH]
  better workspace run <command> [--concurrency N] [--json] [--project-root PATH]
`);
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
      since: { type: "string", default: "HEAD" },
      concurrency: { type: "string", default: "1" }
    },
    allowPositionals: true,
    strict: false
  });

  const projectRootResolved = values["project-root"]
    ? { root: path.resolve(values["project-root"]), reason: "cli-flag" }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = projectRootResolved.root;

  commandLogger.info("workspace.subcommand", { subcommand: sub, projectRoot });

  if (sub === "list") {
    const config = await detectWorkspaceConfig(projectRoot);
    const resolved = await resolveWorkspacePackages(projectRoot, config);

    if (!resolved.ok) {
      const out = {
        ok: false,
        kind: "better.workspace.list",
        schemaVersion: 1,
        projectRoot,
        reason: resolved.reason
      };
      if (values.json) printJson(out);
      else printText(`better workspace list: ${resolved.reason}`);
      process.exitCode = 1;
      return;
    }

    const summary = workspaceSummary(resolved);

    if (values.json) {
      const out = {
        ok: true,
        kind: "better.workspace.list",
        schemaVersion: 1,
        projectRoot,
        type: resolved.type,
        packageCount: resolved.packages.length,
        packages: summary.packages
      };
      printJson(out);
    } else {
      const rows = resolved.packages.map(p => [
        p.name,
        p.version,
        p.relativeDir,
        Object.keys(p.dependencies).length,
        p.workspaceDeps.length
      ]);

      const table = formatTable(
        rows,
        ["Name", "Version", "Path", "Deps", "Workspace Deps"]
      );

      printText(`better workspace list (${resolved.type})\n\n${table}\n\nTotal: ${resolved.packages.length} packages`);
    }
    return;
  }

  if (sub === "info") {
    const packageName = positionals[0];
    if (!packageName) {
      throw new Error("better workspace info requires a package name argument");
    }

    const config = await detectWorkspaceConfig(projectRoot);
    const resolved = await resolveWorkspacePackages(projectRoot, config);

    if (!resolved.ok) {
      const out = {
        ok: false,
        kind: "better.workspace.info",
        schemaVersion: 1,
        projectRoot,
        reason: resolved.reason
      };
      if (values.json) printJson(out);
      else printText(`better workspace info: ${resolved.reason}`);
      process.exitCode = 1;
      return;
    }

    const pkg = resolved.packages.find(p => p.name === packageName);
    if (!pkg) {
      const out = {
        ok: false,
        kind: "better.workspace.info",
        schemaVersion: 1,
        projectRoot,
        packageName,
        reason: "package_not_found"
      };
      if (values.json) printJson(out);
      else printText(`better workspace info: package '${packageName}' not found`);
      process.exitCode = 1;
      return;
    }

    const out = {
      ok: true,
      kind: "better.workspace.info",
      schemaVersion: 1,
      projectRoot,
      package: {
        name: pkg.name,
        version: pkg.version,
        dir: pkg.dir,
        relativeDir: pkg.relativeDir,
        dependencies: pkg.dependencies,
        workspaceDeps: pkg.workspaceDeps,
        scripts: pkg.pkg.scripts ?? {}
      }
    };

    if (values.json) {
      printJson(out);
    } else {
      const lines = [
        `better workspace info: ${pkg.name}`,
        `- version: ${pkg.version}`,
        `- path: ${pkg.relativeDir}`,
        `- dependencies: ${Object.keys(pkg.dependencies).length}`,
        `- workspace deps: ${pkg.workspaceDeps.join(", ") || "none"}`,
        `- scripts: ${Object.keys(pkg.pkg.scripts ?? {}).join(", ") || "none"}`
      ];
      printText(lines.join("\n"));
    }
    return;
  }

  if (sub === "graph") {
    const config = await detectWorkspaceConfig(projectRoot);
    const resolved = await resolveWorkspacePackages(projectRoot, config);

    if (!resolved.ok) {
      const out = {
        ok: false,
        kind: "better.workspace.graph",
        schemaVersion: 1,
        projectRoot,
        reason: resolved.reason
      };
      if (values.json) printJson(out);
      else printText(`better workspace graph: ${resolved.reason}`);
      process.exitCode = 1;
      return;
    }

    const sorted = topoSort(resolved.packages);

    if (values.json) {
      const out = {
        ok: sorted.ok,
        kind: "better.workspace.graph",
        schemaVersion: 1,
        projectRoot,
        sorted: sorted.sorted,
        levels: sorted.levels,
        cycles: sorted.cycles,
        packages: resolved.packages.map(p => ({
          name: p.name,
          workspaceDeps: p.workspaceDeps
        }))
      };
      printJson(out);
    } else {
      const graph = drawGraph(resolved.packages);
      const status = sorted.ok ? "OK" : `CYCLES DETECTED: ${JSON.stringify(sorted.cycles)}`;
      printText(`better workspace graph\n\nStatus: ${status}\n\n${graph}\n\nTopological order: ${sorted.sorted.join(" → ")}`);
    }
    return;
  }

  if (sub === "changed") {
    const sinceRef = values.since;
    const config = await detectWorkspaceConfig(projectRoot);
    const resolved = await resolveWorkspacePackages(projectRoot, config);

    if (!resolved.ok) {
      const out = {
        ok: false,
        kind: "better.workspace.changed",
        schemaVersion: 1,
        projectRoot,
        reason: resolved.reason
      };
      if (values.json) printJson(out);
      else printText(`better workspace changed: ${resolved.reason}`);
      process.exitCode = 1;
      return;
    }

    const changedFiles = await getChangedFiles(projectRoot, sinceRef);
    const changedPackageNames = mapFilesToPackages(changedFiles, resolved.packages, projectRoot);
    const affected = affectedPackages(resolved.packages, changedPackageNames);

    const out = {
      ok: true,
      kind: "better.workspace.changed",
      schemaVersion: 1,
      projectRoot,
      sinceRef,
      changedFiles: changedFiles.length,
      changedPackages: changedPackageNames,
      affectedPackages: affected,
      affectedCount: affected.length
    };

    if (values.json) {
      printJson(out);
    } else {
      const lines = [
        `better workspace changed (since ${sinceRef})`,
        `- changed files: ${changedFiles.length}`,
        `- changed packages: ${changedPackageNames.join(", ") || "none"}`,
        `- affected packages: ${affected.join(", ") || "none"}`,
        `- total affected: ${affected.length}`
      ];
      printText(lines.join("\n"));
    }
    return;
  }

  if (sub === "run") {
    const command = positionals.join(" ");
    if (!command) {
      throw new Error("better workspace run requires a command argument");
    }

    const concurrency = Math.max(1, parseInt(values.concurrency, 10) || 1);
    const config = await detectWorkspaceConfig(projectRoot);
    const resolved = await resolveWorkspacePackages(projectRoot, config);

    if (!resolved.ok) {
      const out = {
        ok: false,
        kind: "better.workspace.run",
        schemaVersion: 1,
        projectRoot,
        reason: resolved.reason
      };
      if (values.json) printJson(out);
      else printText(`better workspace run: ${resolved.reason}`);
      process.exitCode = 1;
      return;
    }

    const startTime = Date.now();
    let runResults;
    try {
      runResults = await runInWorkspaces(resolved.packages, command, concurrency);
    } catch (err) {
      const out = {
        ok: false,
        kind: "better.workspace.run",
        schemaVersion: 1,
        projectRoot,
        command,
        reason: err.message
      };
      if (values.json) printJson(out);
      else printText(`better workspace run: ${err.message}`);
      process.exitCode = 1;
      return;
    }

    const out = {
      ok: true,
      kind: "better.workspace.run",
      schemaVersion: 1,
      projectRoot,
      command,
      concurrency,
      totalPackages: resolved.packages.length,
      totalSuccess: runResults.totalSuccess,
      totalFailure: runResults.totalFailure,
      durationMs: Date.now() - startTime,
      results: runResults.results
    };

    if (values.json) {
      printJson(out);
    } else {
      const lines = [
        `better workspace run: ${command}`,
        `- concurrency: ${concurrency}`,
        `- packages: ${resolved.packages.length}`,
        `- success: ${runResults.totalSuccess}`,
        `- failure: ${runResults.totalFailure}`,
        `- duration: ${out.durationMs}ms`
      ];
      printText(lines.join("\n"));
    }
    return;
  }

  throw new Error(`Unknown workspace subcommand '${sub}'. Expected list|info|graph|changed|run.`);
}
