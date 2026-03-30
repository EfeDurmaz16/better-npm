import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { join } from "node:path";
import fs from "node:fs/promises";

export async function cmdTelemetry(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better telemetry <subcommand>

Manage anonymous opt-in telemetry.

Subcommands:
  status    Show current telemetry state
  on        Enable telemetry (opt-in)
  off       Disable telemetry

What is collected (when enabled):
  - Command name (e.g. "install", "audit")
  - Duration in milliseconds
  - Success/failure flag
  - OS and CPU architecture
  - better version number

What is NEVER collected:
  - Package names, project names, file paths
  - IP addresses, usernames, emails
  - Any personally identifiable information

Options:
  --json    Machine-readable JSON output
  -h, --help  Show this help
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

  const sub = positionals[0] || "status";
  const useJson = values.json || runtime.json === true;

  const configPath = join(process.env.HOME || "/tmp", ".better", "telemetry.json");

  async function getEnabled() {
    try {
      const content = await fs.readFile(configPath, "utf8");
      return JSON.parse(content)?.enabled === true;
    } catch {
      return false;
    }
  }

  async function setEnabled(enabled) {
    let existing = {};
    try {
      existing = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch {}
    existing.enabled = enabled;
    if (enabled && !existing.install_id) {
      existing.install_id = Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
    }
    await fs.mkdir(join(process.env.HOME || "/tmp", ".better"), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(existing, null, 2));
  }

  switch (sub) {
    case "status": {
      const enabled = await getEnabled();
      if (useJson) {
        printJson({ ok: true, kind: "better.telemetry.status", enabled });
      } else {
        printText(`Telemetry is currently: ${enabled ? "enabled" : "disabled"}`);
        if (!enabled) {
          printText("Run 'better telemetry on' to enable anonymous usage analytics.");
        }
      }
      break;
    }
    case "on": {
      await setEnabled(true);
      if (useJson) {
        printJson({ ok: true, kind: "better.telemetry.enabled", enabled: true });
      } else {
        printText("Telemetry enabled. Thank you for helping improve better!");
        printText("Run 'better telemetry off' to disable at any time.");
      }
      break;
    }
    case "off": {
      await setEnabled(false);
      if (useJson) {
        printJson({ ok: true, kind: "better.telemetry.enabled", enabled: false });
      } else {
        printText("Telemetry disabled.");
      }
      break;
    }
    default:
      printText(`Unknown subcommand: ${sub}. Use 'status', 'on', or 'off'.`);
      process.exitCode = 1;
  }
}
