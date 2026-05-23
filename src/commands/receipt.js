import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runListReceiptsNapi, runVerifyReceiptNapi } from "../lib/core.js";
import path from "node:path";

export async function cmdReceipt(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better receipt list [--json] [--project-root PATH]
  better receipt verify [--json] [--project-root PATH]

View and verify install receipts (.better-receipt.json).

Subcommands:
  list     Show install receipts for the project
  verify   Verify the receipt matches the current lockfile and node_modules

Options:
  --json          Machine-readable output
  --project-root  Override project root
  -h, --help      Show this help
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
  const sub = positionals[0] ?? "list";

  if (sub === "list") {
    const napiResult = runListReceiptsNapi(projectRoot);
    if (napiResult?.ok) {
      if (values.json) {
        printJson({ ok: true, kind: "better.receipt.list", projectRoot, ...napiResult });
      } else {
        const receipts = napiResult.receipts ?? [];
        if (receipts.length === 0) {
          printText("No install receipts found. Run 'better install' to create one.");
        } else {
          printText(`Install receipts for ${projectRoot}:`);
          for (const r of receipts) {
            printText(`  - ${r.timestamp} — ${r.packagesInstalled} packages (better v${r.betterVersion})`);
          }
        }
      }
      return;
    }
    const out = { ok: false, kind: "better.receipt.list", reason: "napi_unavailable" };
    if (values.json) printJson(out);
    else printText("Receipt listing unavailable (NAPI not loaded).");
    return;
  }

  if (sub === "verify") {
    const napiResult = runVerifyReceiptNapi(projectRoot);
    if (napiResult !== null) {
      if (values.json) {
        printJson({ ok: napiResult.ok, kind: "better.receipt.verify", projectRoot, ...napiResult });
      } else {
        printText([
          `better receipt verify: ${napiResult.ok ? "PASS" : "FAIL"}`,
          `- receipt exists: ${napiResult.receiptExists}`,
          `- timestamp: ${napiResult.timestamp || "n/a"}`,
          `- packages installed: ${napiResult.packagesInstalled ?? 0}`,
          `- lockfile matches: ${napiResult.lockfileMatches}`,
          `- node_modules present: ${napiResult.nodeModulesPresent}`,
        ].join("\n"));
      }
      process.exitCode = napiResult.ok ? 0 : 1;
      return;
    }
    const out = { ok: false, kind: "better.receipt.verify", reason: napiResult?.error ?? "napi_unavailable" };
    if (values.json) printJson(out);
    else printText(`better receipt verify: ${out.reason}`);
    process.exitCode = 1;
    return;
  }

  printText(`Unknown subcommand '${sub}'. Run 'better receipt --help' for usage.`);
  process.exitCode = 1;
}
