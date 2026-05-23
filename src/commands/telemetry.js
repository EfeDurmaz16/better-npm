import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { runGetTelemetryStatusNapi, runSetTelemetryEnabledNapi } from "../lib/core.js";
import { join } from "node:path";
import fs from "node:fs/promises";

const telemetryPath = () => join(process.env.HOME || "/tmp", ".better", "telemetry.json");

export async function cmdTelemetry(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage: better telemetry <on|off|status>

Manage opt-in anonymous telemetry.

Subcommands:
  on      Enable anonymous usage telemetry
  off     Disable telemetry
  status  Show current telemetry status

What is collected (anonymized):
  - Command name, duration, success/failure
  - OS and architecture
  - better version

What is NEVER collected:
  - Package names, project paths, file contents, IP addresses

Options:
  --json  Machine-readable output
  -h, --help  Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { positionals } = parseArgs({
    args: argv,
    options: {},
    allowPositionals: true,
    strict: false,
  });

  const sub = positionals[0] || "status";
  const useJson = runtime.json === true;
  const configPath = telemetryPath();

  let config = { enabled: false, session_id: "" };
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch { /* not configured yet */ }

  if (sub === "on") {
    const napiResult = runSetTelemetryEnabledNapi(true);
    if (napiResult?.ok) {
      if (useJson) { printJson({ ok: true, kind: "better.telemetry.set", enabled: true }); }
      else { printText("Telemetry enabled. Thank you for helping improve better!"); }
      return;
    }
    config.enabled = true;
    if (!config.session_id) {
      config.session_id = `tel-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    }
    await fs.mkdir(join(process.env.HOME || "/tmp", ".better"), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    if (useJson) {
      printJson({ ok: true, kind: "better.telemetry.set", enabled: true });
    } else {
      printText("Telemetry enabled. Thank you for helping improve better!");
    }
  } else if (sub === "off") {
    const napiResult = runSetTelemetryEnabledNapi(false);
    if (napiResult?.ok) {
      if (useJson) { printJson({ ok: true, kind: "better.telemetry.set", enabled: false }); }
      else { printText("Telemetry disabled."); }
      return;
    }
    config.enabled = false;
    await fs.mkdir(join(process.env.HOME || "/tmp", ".better"), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    if (useJson) {
      printJson({ ok: true, kind: "better.telemetry.set", enabled: false });
    } else {
      printText("Telemetry disabled.");
    }
  } else {
    const napiStatus = runGetTelemetryStatusNapi();
    if (napiStatus?.ok) {
      if (useJson) { printJson({ ok: true, kind: "better.telemetry.status", enabled: napiStatus.enabled, status: napiStatus.status }); }
      else {
        printText(`Telemetry is currently: ${napiStatus.status}`);
        if (!napiStatus.enabled) printText("Run 'better telemetry on' to enable opt-in anonymous usage reporting.");
      }
      return;
    }
    const status = config.enabled ? "enabled" : "disabled";
    if (useJson) {
      printJson({ ok: true, kind: "better.telemetry.status", enabled: config.enabled, status });
    } else {
      printText(`Telemetry is currently: ${status}`);
      if (!config.enabled) {
        printText("Run 'better telemetry on' to enable opt-in anonymous usage reporting.");
      }
    }
  }
}
