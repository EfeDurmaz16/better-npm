import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import https from "node:https";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runPredictMaintenanceNapi } from "../lib/core.js";

const KNOWN_DEPRECATED = new Set(["request", "node-uuid", "tslint", "bower", "grunt-cli", "jade", "stylus", "inferno-compat"]);

function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "User-Agent": "better-npm/1.0" } }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function predictFromRegistry(packageName, version) {
  try {
    const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
    if (!meta || meta.error) return null;

    const latest = meta["dist-tags"]?.latest ?? version;
    const latestMeta = meta.versions?.[latest] ?? {};
    const isDeprecated = !!latestMeta.deprecated || KNOWN_DEPRECATED.has(packageName);
    const lastPublishedStr = meta.time?.[latest] ?? meta.time?.modified ?? null;
    const daysSince = lastPublishedStr
      ? (Date.now() - new Date(lastPublishedStr).getTime()) / (1000 * 60 * 60 * 24)
      : null;
    const versionCount = Object.keys(meta.versions ?? {}).length;
    const maintainerCount = (meta.maintainers ?? []).length;

    const signals = [];
    let riskScore = 0;
    let currentStatus = "active";
    let predicted = "active";

    if (isDeprecated) {
      riskScore = 0.95;
      currentStatus = "deprecated";
      predicted = "deprecated";
      signals.push({ signal: "Package is deprecated", trend: "declining" });
    } else if (daysSince !== null) {
      if (daysSince > 730) {
        riskScore = 0.75;
        currentStatus = "slowing_down";
        predicted = "unmaintained";
        signals.push({ signal: `No publish in ${Math.floor(daysSince)} days`, trend: "declining" });
      } else if (daysSince > 365) {
        riskScore = 0.5;
        currentStatus = "slowing_down";
        predicted = "at_risk";
        signals.push({ signal: `No publish in ${Math.floor(daysSince)} days`, trend: "slowing" });
      } else if (daysSince > 180) {
        riskScore = 0.3;
        currentStatus = "active";
        predicted = "slowing_down";
        signals.push({ signal: `Last publish ${Math.floor(daysSince)} days ago`, trend: "neutral" });
      } else {
        riskScore = 0.05;
        signals.push({ signal: "Recently published", trend: "stable" });
      }
    }

    if (maintainerCount === 1 && riskScore < 0.5) {
      riskScore = Math.min(0.9, riskScore + 0.1);
      signals.push({ signal: "Single maintainer (bus factor 1)", trend: "concern" });
    }
    if (versionCount < 3) {
      riskScore = Math.min(0.9, riskScore + 0.1);
      signals.push({ signal: "Few published versions", trend: "concern" });
    }

    let recommended_action = { type: "no_action" };
    if (riskScore > 0.7) {
      recommended_action = { type: "migrate_now", to: "alternative", reason: "High maintenance risk", effort: "medium" };
    } else if (riskScore > 0.4) {
      recommended_action = { type: "plan_migration", to: "alternative", effort: "low", reason: "Declining maintenance trend" };
    } else if (riskScore > 0.2) {
      recommended_action = { type: "monitor", reason: "Watch for further decline" };
    }

    return {
      package: packageName,
      version: latest,
      current_status: currentStatus,
      predicted_status_6mo: predicted,
      confidence: 0.65,
      risk_score: riskScore,
      signals,
      recommended_action,
      alternatives: [],
      source: "npm_registry"
    };
  } catch {
    return null;
  }
}

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

    const predictions = await Promise.all(depNames.map(name => runOnePrediction(name, ecosystem, "latest")));
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

  const prediction = await runOnePrediction(packageName, ecosystem, values.version ?? "latest");

  if (values.json) {
    printJson({ ok: true, kind: "better.predict", schemaVersion: 1, ...prediction });
    return;
  }

  printText(formatOnePrediction(prediction));
}

async function runOnePrediction(packageName, ecosystem, version) {
  const result = runPredictMaintenanceNapi(packageName, ecosystem, version);
  if (result !== null && result.ok) {
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

  // JS fallback: try npm registry for npm packages
  if (ecosystem === "npm") {
    const regResult = await predictFromRegistry(packageName, version);
    if (regResult) return regResult;
  }

  return {
    package: packageName, version, ecosystem,
    current_status: "unknown", predicted_status_6mo: "unknown",
    confidence: 0, risk_score: 0, signals: [], recommended_action: { type: "no_action" },
    alternatives: [], error: "signals_unavailable"
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
