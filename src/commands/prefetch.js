/**
 * better prefetch — pre-warm the resolver cache (#23)
 *
 * Reads package.json scripts / source imports to identify likely next
 * installs, then hits the npm registry to warm the resolver cache.
 *
 * Usage:
 *   better prefetch                  # warm cache for all direct deps + script tools
 *   better prefetch --watch          # re-prefetch when package.json changes
 *   better prefetch --json           # output what was prefetched
 */
import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { collectHints, prefetchToResolver } from "../lib/prefetchHints.js";
import { ParallelResolver } from "../engine/resolver.js";

const HELP = `better prefetch — pre-warm registry cache

Usage:
  better prefetch          Warm cache for direct deps + inferred tools
  better prefetch --watch  Re-prefetch when package.json changes

Options:
  --watch          Watch package.json and re-prefetch on change
  --project-root   Override project root
  --concurrency N  Parallel registry requests (default: 32)
  --json           Machine-readable output
  -h, --help       Show help
`;

export async function cmdPrefetch(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      watch: { type: "boolean", default: false },
      "project-root": { type: "string" },
      concurrency: { type: "string", default: "32" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: false,
    strict: false
  });

  if (values.help) { printText(HELP); return; }

  const cwd = process.cwd();
  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const concurrency = Math.max(1, parseInt(values.concurrency, 10) || 32);

  async function runPrefetch() {
    const hints = await collectHints(projectRoot);

    if (hints.packages.length === 0) {
      if (!values.json) printText("No packages to prefetch.");
      return { packages: [], durationMs: 0 };
    }

    if (!values.json) {
      process.stderr.write(`\x1b[90mPrefetching ${hints.packages.length} packages (scripts: ${hints.sources.scripts.length}, imports: ${hints.sources.imports.length})…\x1b[0m\n`);
    }

    const resolver = new ParallelResolver({ concurrency });
    const result = await prefetchToResolver(hints.packages, resolver);

    if (values.json) {
      printJson({
        ok: true,
        prefetched: result.prefetched,
        durationMs: result.durationMs,
        packages: hints.packages,
        sources: hints.sources
      });
    } else {
      printText(`\x1b[32m✔ Prefetched ${result.prefetched} packages in ${result.durationMs}ms\x1b[0m`);
      if (hints.sources.scripts.length > 0) {
        printText(`  Script tools: ${hints.sources.scripts.join(", ")}`);
      }
      if (hints.sources.imports.length > 0) {
        printText(`  Source imports: ${hints.sources.imports.slice(0, 10).join(", ")}${hints.sources.imports.length > 10 ? ` +${hints.sources.imports.length - 10} more` : ""}`);
      }
    }

    return result;
  }

  await runPrefetch();

  if (values.watch) {
    if (!values.json) {
      printText(`\n\x1b[90mWatching ${path.join(projectRoot, "package.json")} for changes…\x1b[0m`);
    }

    const pkgJsonPath = path.join(projectRoot, "package.json");
    let debounceTimer = null;

    // Use fs.watch for file change detection
    const watcher = fs.watch ? (await import("node:fs")).watch : null;
    if (!watcher) {
      printText("--watch requires Node.js fs.watch support.");
      return;
    }

    const { watch } = await import("node:fs");
    watch(pkgJsonPath, { persistent: true }, (_event) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        if (!values.json) printText("\n\x1b[90mpackage.json changed — re-prefetching…\x1b[0m");
        await runPrefetch();
      }, 500);
    });

    // Keep process alive
    await new Promise(() => {}); // intentional hang for watch mode
  }
}
