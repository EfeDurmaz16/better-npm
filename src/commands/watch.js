import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { join } from "node:path";
import fs from "node:fs/promises";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `better watch [--heal] [--interval N] [--audit] [--outdated]`
 *
 * Real-time dependency monitoring:
 * - Watches package.json for changes, runs install on change
 * - With --audit: checks for new CVEs periodically
 * - With --heal: auto-fixes issues found
 * - With --interval N: check every N seconds (default: 300)
 */
export async function cmdWatch(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage: better watch [options]

Real-time dependency monitoring — watch for changes and vulnerabilities.

Options:
  --heal               Auto-fix vulnerabilities when found
  --audit              Check for CVEs periodically (implies --watch)
  --outdated           Check for outdated packages periodically
  --interval <secs>    Check interval in seconds (default: 300)
  --json               Machine-readable output
  -h, --help           Show this help

Examples:
  better watch                    # Watch package.json, auto-install on change
  better watch --audit            # Also check for CVEs every 5 minutes
  better watch --heal --interval 60  # Heal issues every 60 seconds
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      heal: { type: "boolean", default: false },
      audit: { type: "boolean", default: false },
      outdated: { type: "boolean", default: false },
      interval: { type: "string", default: "300" },
    },
    allowPositionals: false,
    strict: false,
  });

  const useJson = values.json;
  const interval = parseInt(values.interval) || 300;
  const cwd = process.cwd();
  const pkgPath = join(cwd, "package.json");

  if (!useJson) {
    printText(`better watch — monitoring ${cwd}`);
    printText(`Interval: ${interval}s | Heal: ${values.heal} | Audit: ${values.audit}`);
    printText("Press Ctrl+C to stop\n");
  }

  // Watch package.json for changes
  let lastMtime = 0;
  try {
    const stat = await fs.stat(pkgPath);
    lastMtime = stat.mtimeMs;
  } catch {}

  async function checkCycle() {
    const events = [];

    // Check package.json changes
    try {
      const stat = await fs.stat(pkgPath);
      if (stat.mtimeMs > lastMtime) {
        lastMtime = stat.mtimeMs;
        events.push({ type: "package_changed", action: "install" });
        if (!useJson) printText(`[${new Date().toISOString()}] package.json changed — running install...`);
        const result = spawnSync("node", [join(process.cwd(), "bin", "better.js"), "install"], {
          cwd,
          stdio: useJson ? "pipe" : "inherit",
        });
        events.push({ type: "install_done", ok: result.status === 0 });
      }
    } catch {}

    // Audit check
    if (values.audit) {
      try {
        const auditResult = await execFileAsync("node", [join(process.cwd(), "bin", "better.js"), "audit", "--json"], { cwd, timeout: 30000 }).catch(() => ({ stdout: "" }));
        const auditData = JSON.parse(auditResult.stdout || "{}");
        const vulnCount = auditData.vulnerabilities?.length || 0;
        if (vulnCount > 0) {
          events.push({ type: "vulnerabilities_found", count: vulnCount });
          if (!useJson) printText(`[${new Date().toISOString()}] ${vulnCount} vulnerabilities found`);
          if (values.heal) {
            spawnSync("node", [join(process.cwd(), "bin", "better.js"), "heal", "--json"], { cwd, stdio: useJson ? "pipe" : "inherit" });
            events.push({ type: "heal_attempted" });
          }
        }
      } catch {}
    }

    // Outdated check
    if (values.outdated) {
      try {
        const outdatedResult = await execFileAsync("node", [join(process.cwd(), "bin", "better.js"), "outdated", "--json"], { cwd, timeout: 30000 }).catch(() => ({ stdout: "" }));
        const outdatedData = JSON.parse(outdatedResult.stdout || "{}");
        const outdatedCount = outdatedData.outdated?.length || 0;
        if (outdatedCount > 0) {
          events.push({ type: "outdated_found", count: outdatedCount });
          if (!useJson) printText(`[${new Date().toISOString()}] ${outdatedCount} outdated packages`);
        }
      } catch {}
    }

    if (useJson && events.length > 0) {
      printJson({ ok: true, kind: "better.watch.cycle", timestamp: new Date().toISOString(), events });
    }
  }

  // Run first check immediately
  await checkCycle();

  // Set up interval
  setInterval(checkCycle, interval * 1000);

  // Keep process alive
  process.stdin.resume();
  process.on("SIGINT", () => {
    if (!useJson) printText("\nStopping watch...");
    process.exit(0);
  });
}
