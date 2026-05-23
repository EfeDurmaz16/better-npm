import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runGenerateBuildManifestNapi, runVerifyReproducibilityNapi } from "../lib/core.js";

/**
 * `better reproducible` — reproducible build manifest generation and verification
 *
 * Usage:
 *   better reproducible generate     Generate a build manifest (save as .better-manifest.json)
 *   better reproducible verify       Verify the current build matches the saved manifest
 */
export async function cmdReproducible(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better reproducible <subcommand> [options]

Ensure reproducible builds by capturing and verifying lockfile state.

Subcommands:
  generate    Generate a build manifest from the current lockfile
  verify      Verify current build matches the saved manifest

Options:
  --json              Machine-readable output
  --project-root PATH Override project root
  -h, --help          Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;
  const useJson = values.json;
  const sub = positionals[0] || "verify";

  switch (sub) {
    case "generate": {
      const napiResult = runGenerateBuildManifestNapi(projectRoot);
      if (napiResult?.ok && napiResult.data) {
        const manifestPath = path.join(projectRoot, ".better-build-manifest.json");
        await fs.writeFile(manifestPath, JSON.stringify(napiResult.data, null, 2) + "\n");
        const result = {
          ok: true, kind: "better.reproducible.generate",
          path: manifestPath,
          packages: napiResult.data.packages?.length ?? 0,
          lockfileHash: napiResult.data.lockfile_hash,
          createdAt: napiResult.data.created_at,
        };
        if (useJson) { printJson(result); }
        else {
          printText(`Generated build manifest: ${manifestPath}`);
          printText(`  Packages: ${result.packages} | Lockfile hash: ${result.lockfileHash?.substring(0, 16)}...`);
        }
      } else {
        const err = { ok: false, error: napiResult?.error ?? "Failed to generate manifest" };
        if (useJson) { printJson(err); } else { printText(`Error: ${err.error}`); }
        process.exitCode = 1;
      }
      break;
    }
    case "verify": {
      const napiResult = runVerifyReproducibilityNapi(projectRoot);
      if (napiResult?.ok && napiResult.data) {
        const r = napiResult.data;
        const result = {
          ok: true, kind: "better.reproducible.verify",
          reproducible: r.reproducible,
          differences: r.differences ?? [],
          summary: r.summary,
        };
        if (useJson) { printJson(result); }
        else {
          if (r.reproducible) {
            printText("Build is reproducible — no differences found.");
          } else {
            printText(`Build is NOT reproducible: ${r.summary}`);
            for (const diff of r.differences.slice(0, 10)) {
              printText(`  ${diff.package} ${diff.field}: ${diff.baseline} → ${diff.current}`);
            }
            process.exitCode = 1;
          }
        }
      } else {
        const err = { ok: false, error: napiResult?.error ?? "No manifest found. Run 'better reproducible generate' first." };
        if (useJson) { printJson(err); } else { printText(`Error: ${err.error}`); }
        process.exitCode = 1;
      }
      break;
    }
    default:
      printText(`Unknown subcommand: ${sub}. Use generate or verify.`);
      process.exitCode = 1;
  }
}
