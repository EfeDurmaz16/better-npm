import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runListReceiptsNapi, runVerifyReceiptNapi } from "../lib/core.js";
import path from "node:path";

async function readReceiptFile(projectRoot) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, ".better-receipt.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

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
    // JS fallback: read .better-receipt.json
    const receipt = await readReceiptFile(projectRoot);
    if (receipt) {
      const receipts = [receipt];
      if (values.json) {
        printJson({ ok: true, kind: "better.receipt.list", projectRoot, receipts });
      } else {
        printText(`Install receipts for ${projectRoot}:`);
        printText(`  - ${receipt.timestamp} — ${receipt.packagesInstalled} installed / ${receipt.packagesTotal} total (${receipt.pm?.name ?? "?"}/${receipt.pm?.engine ?? "?"})`);
      }
    } else {
      const out = { ok: false, kind: "better.receipt.list", reason: "no_receipt_found" };
      if (values.json) printJson(out);
      else printText("No install receipts found. Run 'better install' to create one.");
    }
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
    // JS fallback: read .better-receipt.json and do basic verification
    const receipt = await readReceiptFile(projectRoot);
    let receiptExists = false;
    let nodeModulesPresent = false;
    try { await fs.access(path.join(projectRoot, "node_modules")); nodeModulesPresent = true; } catch { /* */ }
    if (receipt) {
      receiptExists = true;
      const ok = nodeModulesPresent;
      const out = {
        ok,
        kind: "better.receipt.verify",
        projectRoot,
        receiptExists,
        timestamp: receipt.timestamp,
        packagesInstalled: receipt.packagesInstalled,
        lockfileMatches: null,
        nodeModulesPresent
      };
      if (values.json) printJson(out);
      else printText([
        `better receipt verify: ${ok ? "PASS" : "FAIL"}`,
        `- receipt exists: ${receiptExists}`,
        `- timestamp: ${receipt.timestamp}`,
        `- packages installed: ${receipt.packagesInstalled ?? 0}`,
        `- lockfile matches: n/a (NAPI not available)`,
        `- node_modules present: ${nodeModulesPresent}`,
      ].join("\n"));
      process.exitCode = ok ? 0 : 1;
      return;
    }
    const out = { ok: false, kind: "better.receipt.verify", reason: "no_receipt_found", receiptExists: false, nodeModulesPresent };
    if (values.json) printJson(out);
    else printText("better receipt verify: FAIL (no receipt found)");
    process.exitCode = 1;
    return;
  }

  printText(`Unknown subcommand '${sub}'. Run 'better receipt --help' for usage.`);
  process.exitCode = 1;
}
