import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runPredictMaintenanceNapi } from "../lib/core.js";

export async function cmdPredict(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better predict <package> [--ecosystem npm|pypi|cargo] [--version VERSION]
  better predict --all [--project-root PATH]

Predict future maintenance health for a package or all project dependencies.
Uses Rust-native signal collection and trend analysis to forecast 6-month status.

Options:
  --all              Predict for all direct dependencies in package.json
  --ecosystem E      Ecosystem (default: npm)
  --version V        Package version (default: latest)
  --project-root P   Override project root (used with --all)
  --json             Machine-readable JSON output
  -h, --help         Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      all: { type: "boolean", default: false },
      ecosystem: { type: "string", default: "npm" },
      version: { type: "string", default: "latest" },
      "project-root": { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  const ecosystem = values.ecosystem ?? "npm";

  if (values.all) {
    const resolvedRoot = values["project-root"]
      ? { root: path.resolve(values["project-root"]) }
      : await resolveInstallProjectRoot(process.cwd());
    const projectRoot = resolvedRoot.root;

    let pkg;
    try {
      pkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    } catch {
      const err = { ok: false, kind: "better.predict", error: "package.json not found" };
      if (values.json) printJson(err); else printText("Error: package.json not found");
      process.exitCode = 1;
      return;
    }

    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const depNames = Object.keys(allDeps);

    if (depNames.length === 0) {
      const out = { ok: true, kind: "better.predict", predictions: [] };
      if (values.json) printJson(out); else printText("No dependencies to analyze.");
      return;
    }

    if (!values.json) printText(`Predicting maintenance for ${depNames.length} packages...`);

    const predictions = depNames.map(name => runOnePrediction(name, ecosystem, "latest"));
    const atRisk = predictions.filter(p => p.risk_score > 0.3).sort((a, b) => b.risk_score - a.risk_score);

    const out = {
      ok: true,
      kind: "better.predict",
      schemaVersion: 1,
      analyzed: depNames.length,
      at_risk: atRisk.length,
      predictions: atRisk
    };
    if (values.json) { printJson(out); return; }

    if (atRisk.length === 0) {
      printText("All dependencies look healthy — no maintenance concerns predicted.");
      return;
    }
    printText(formatPredictions(atRisk));
    return;
  }

  const packageName = positionals[0];
  if (!packageName) {
    const err = { ok: false, kind: "better.predict", error: "missing_package_name" };
    if (values.json) printJson(err);
    else printText("Error: provide a package name or --all (e.g. better predict moment)");
    process.exitCode = 1;
    return;
  }

  const prediction = runOnePrediction(packageName, ecosystem, values.version ?? "latest");

  if (values.json) {
    printJson({ ok: true, kind: "better.predict", schemaVersion: 1, ...prediction });
    return;
  }

  printText(formatOnePrediction(prediction));
}

function runOnePrediction(packageName, ecosystem, version) {
  const result = runPredictMaintenanceNapi(packageName, ecosystem, version);
  if (result === null || !result.ok) {
    return {
      package: packageName, version, ecosystem,
      current_status: "unknown", predicted_status_6mo: "unknown",
      confidence: 0, risk_score: 0, signals: [], recommended_action: { type: "no_action" },
      alternatives: [], error: result?.error ?? "napi_unavailable"
    };
  }
  const d = result.data ?? result;
  return {
    package: d.package ?? packageName,
    version: d.version ?? version,
    current_status: d.current_status,
    predicted_status_6mo: d.predicted_status_6mo,
    confidence: d.confidence,
    risk_score: d.risk_score,
    signals: d.signals ?? [],
    recommended_action: d.recommended_action ?? { type: "no_action" },
    alternatives: d.alternatives ?? []
  };
}

function formatOnePrediction(p) {
  const statusIcon = statusSymbol(p.predicted_status_6mo);
  const lines = [
    `Maintenance Prediction: ${p.package}@${p.version}`,
    `Current:  ${p.current_status}`,
    `6-month:  ${statusIcon} ${p.predicted_status_6mo}  (confidence: ${(p.confidence * 100).toFixed(0)}%)`,
    `Risk:     ${(p.risk_score * 100).toFixed(0)}%`,
    ""
  ];
  if (p.signals.length) {
    lines.push("Signals:");
    for (const s of p.signals) lines.push(`  - ${s.signal} [${s.trend}]`);
    lines.push("");
  }
  const action = p.recommended_action;
  if (action) {
    if (action.type === "migrate_now") lines.push(`Action: Migrate now → ${action.to} (${action.reason})`);
    else if (action.type === "plan_migration") lines.push(`Action: Plan migration → ${action.to} (effort: ${action.effort})`);
    else if (action.type === "monitor") lines.push("Action: Monitor — watch for further decline");
    else lines.push("Action: No action needed");
  }
  if (p.alternatives.length) {
    lines.push(`Alternatives: ${p.alternatives.map(a => a.name).slice(0, 3).join(", ")}`);
  }
  return lines.join("\n");
}

function formatPredictions(predictions) {
  const lines = [`Maintenance Risk: ${predictions.length} packages flagged\n`];
  for (const p of predictions) {
    const icon = p.risk_score > 0.7 ? "!!" : p.risk_score > 0.5 ? "!" : "~";
    lines.push(`[${icon}] ${p.package} — ${p.predicted_status_6mo} (${(p.risk_score * 100).toFixed(0)}% risk)`);
    for (const s of (p.signals ?? []).slice(0, 2)) lines.push(`    ${s.signal}`);
    if (p.recommended_action?.type === "migrate_now" || p.recommended_action?.type === "plan_migration") {
      lines.push(`    → Consider: ${p.recommended_action.to}`);
    }
  }
  return lines.join("\n");
}

function statusSymbol(status) {
  switch (status) {
    case "active": return "✓";
    case "slowing_down": return "~";
    case "at_risk": return "!";
    case "unmaintained": return "!!";
    case "deprecated": return "✗";
    default: return "?";
  }
}
