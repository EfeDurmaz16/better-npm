import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { runReputationScoreNapi } from "../lib/core.js";

export async function cmdReputation(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better reputation <package> [options]

Score an npm (or other ecosystem) package's reputation.
Checks maintainer health, security posture, activity, and community trust.

Options:
  --ecosystem npm|pypi|cargo|go  Package ecosystem (default: npm)
  --version VERSION              Package version to score (default: latest)
  --json                         Machine-readable JSON output
  -h, --help                     Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      ecosystem: { type: "string", default: "npm" },
      version: { type: "string", default: "latest" }
    },
    allowPositionals: true,
    strict: false
  });

  const packageName = positionals[0];
  if (!packageName) {
    const err = { ok: false, kind: "better.reputation", error: "missing_package_name" };
    if (values.json) printJson(err);
    else printText("Error: package name required (e.g. better reputation lodash)");
    process.exitCode = 1;
    return;
  }

  const ecosystem = values.ecosystem ?? "npm";
  const version = values.version ?? "latest";

  // NAPI fast path — uses live signals from registry + OSV
  const result = runReputationScoreNapi(packageName, ecosystem, version);

  if (result !== null && result.ok) {
    const out = {
      ok: true,
      kind: "better.reputation",
      schemaVersion: 1,
      package: result.package,
      version: result.version,
      score: result.score,
      grade: result.grade,
      breakdown: result.breakdown,
      flags: result.flags,
      computed_at: result.computed_at
    };
    if (values.json) {
      printJson(out);
    } else {
      const gradeColor = result.grade === "A" ? "✓" : result.grade === "B" ? "+" : result.grade === "C" ? "~" : "✗";
      const lines = [
        `Reputation: ${packageName}@${result.version}`,
        `Score: ${gradeColor} ${result.score}/100 (${result.grade})`,
        "",
        "Breakdown:",
        `  Maintainer Health : ${result.breakdown.maintainer_health.toFixed(1)}/25`,
        `  Security Posture  : ${result.breakdown.security_posture.toFixed(1)}/25`,
        `  Activity Vitality : ${result.breakdown.activity_vitality.toFixed(1)}/25`,
        `  Community Trust   : ${result.breakdown.community_trust.toFixed(1)}/25`
      ];
      if (result.flags.length > 0) {
        lines.push("", "Flags:");
        for (const f of result.flags) {
          const icon = f.severity === "critical" ? "!!" : f.severity === "high" ? "!" : f.severity === "medium" ? "~" : "-";
          lines.push(`  [${icon}] ${f.message}`);
        }
      }
      printText(lines.join("\n"));
    }
    return;
  }

  // JS fallback: minimal scoring without live signals
  const fallback = scoreFallback(packageName, ecosystem, version);
  const out = {
    ok: true,
    kind: "better.reputation",
    schemaVersion: 1,
    package: packageName,
    version,
    score: fallback.score,
    grade: fallback.grade,
    breakdown: fallback.breakdown,
    flags: fallback.flags,
    note: "live_signals_unavailable"
  };
  if (values.json) {
    printJson(out);
  } else {
    printText([
      `Reputation: ${packageName}@${version}`,
      `Score: ${fallback.score}/100 (${fallback.grade}) [offline estimate]`,
      "",
      "Breakdown:",
      `  Maintainer Health : ${fallback.breakdown.maintainer_health.toFixed(1)}/25`,
      `  Security Posture  : ${fallback.breakdown.security_posture.toFixed(1)}/25`,
      `  Activity Vitality : ${fallback.breakdown.activity_vitality.toFixed(1)}/25`,
      `  Community Trust   : ${fallback.breakdown.community_trust.toFixed(1)}/25`,
      "",
      "Note: run with --napi for live signals"
    ].join("\n"));
  }
}

function scoreFallback(packageName, _ecosystem, _version) {
  // Minimal static scoring used when NAPI is unavailable.
  // Returns a neutral score with no flags since we have no live data.
  const breakdown = {
    maintainer_health: 12.5,
    security_posture: 12.5,
    activity_vitality: 12.5,
    community_trust: 12.5
  };
  const score = 50;
  return { score, grade: "C", breakdown, flags: [] };
}
