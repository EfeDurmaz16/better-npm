import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

/**
 * `better ci` — Full CI pipeline: install --frozen, verify, audit, policy, sbom, receipt
 *
 * Pipeline (each step on failure aborts unless --no-fail-fast):
 *   1. better install --frozen --strict  (fail if lockfile missing or out of sync)
 *   2. better provenance verify          (optional, skip with --no-provenance)
 *   3. better audit                      (skip with --no-audit)
 *   4. better policy check               (skip with --no-policy)
 *   5. better sbom-gen                   (skip with --no-sbom)
 *   6. better receipt generate           (always, records the install)
 */
export async function cmdCi(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better ci [options]

Full CI pipeline: install → verify → audit → policy → sbom → receipt.

Steps:
  1. install --frozen --strict   Fails if lockfile missing or out of sync
  2. provenance verify           Verify package attestations (--no-provenance to skip)
  3. audit                       Security audit via OSV.dev (--no-audit to skip)
  4. policy check                License/firewall policy (--no-policy to skip)
  5. sbom-gen                    Generate SBOM (--no-sbom to skip)
  6. receipt                     Record install receipt (always)

Options:
  --no-provenance      Skip provenance verification
  --no-audit           Skip security audit
  --no-policy          Skip policy check
  --no-sbom            Skip SBOM generation
  --no-fail-fast       Continue on step failure instead of aborting
  --sbom-format FMT    SBOM format: cyclonedx|spdx (default: cyclonedx)
  --audit-severity LVL Min severity to fail: low|moderate|high|critical (default: high)
  --json               Machine-readable output with step-by-step results
  --project-root PATH  Override project root
  -h, --help           Show this help

Exit code:
  0   All steps passed
  1   One or more steps failed
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:              { type: "boolean", default: runtime.json === true },
      "project-root":    { type: "string" },
      "no-provenance":   { type: "boolean", default: false },
      "no-audit":        { type: "boolean", default: false },
      "no-policy":       { type: "boolean", default: false },
      "no-sbom":         { type: "boolean", default: false },
      "no-fail-fast":    { type: "boolean", default: false },
      "sbom-format":     { type: "string", default: "cyclonedx" },
      "audit-severity":  { type: "string", default: "high" },
    },
    strict: false,
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;
  const corePath = await findBetterCore();
  const startMs = Date.now();

  const steps = [];

  function runStep(name, coreArgs, skip = false) {
    if (skip) {
      steps.push({ name, status: "skipped", duration_ms: 0, details: {} });
      return true; // success (skipped)
    }
    const t0 = Date.now();
    let result;
    if (corePath) {
      result = spawnSync(corePath, [...coreArgs, "--json", "--project-root", projectRoot], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
    } else {
      // Fallback: no Rust binary
      result = { status: 1, stdout: "", stderr: "better-core not found" };
    }
    const duration_ms = Date.now() - t0;
    const passed = (result.status ?? 0) === 0;
    let details = {};
    if (result.stdout) {
      try { details = JSON.parse(result.stdout.trim()); } catch {}
    }
    if (!passed && result.stderr) details.stderr = result.stderr.trim();
    steps.push({ name, status: passed ? "passed" : "failed", duration_ms, details });
    return passed;
  }

  // ── Step 1: install --frozen --strict ─────────────────────────────────────
  if (!values.json) printText("better ci: step 1/6 — install --frozen");
  const installOk = runStep("install --frozen", ["install", "--frozen", "--strict"]);
  if (!installOk && !values["no-fail-fast"]) {
    return finalize(steps, startMs, values.json, false);
  }

  // ── Step 2: provenance verify ────────────────────────────────────────────
  if (!values.json) printText("better ci: step 2/6 — provenance verify");
  const provenanceOk = runStep(
    "provenance verify",
    ["provenance", "verify"],
    values["no-provenance"]
  );
  if (!provenanceOk && !values["no-fail-fast"]) {
    return finalize(steps, startMs, values.json, false);
  }

  // ── Step 3: audit ────────────────────────────────────────────────────────
  if (!values.json) printText("better ci: step 3/6 — audit");
  const auditOk = runStep(
    "audit",
    ["audit", "--severity", values["audit-severity"]],
    values["no-audit"]
  );
  if (!auditOk && !values["no-fail-fast"]) {
    return finalize(steps, startMs, values.json, false);
  }

  // ── Step 4: policy check ─────────────────────────────────────────────────
  if (!values.json) printText("better ci: step 4/6 — policy check");
  const policyOk = runStep(
    "policy check",
    ["policy", "check"],
    values["no-policy"]
  );
  if (!policyOk && !values["no-fail-fast"]) {
    return finalize(steps, startMs, values.json, false);
  }

  // ── Step 5: sbom-gen ─────────────────────────────────────────────────────
  if (!values.json) printText("better ci: step 5/6 — sbom-gen");
  runStep(
    "sbom-gen",
    ["sbom-gen", "--format", values["sbom-format"]],
    values["no-sbom"]
  );

  // ── Step 6: receipt ──────────────────────────────────────────────────────
  if (!values.json) printText("better ci: step 6/6 — receipt");
  runStep("receipt", ["receipt", "generate"]);

  const allPassed = steps.every(s => s.status === "passed" || s.status === "skipped");
  return finalize(steps, startMs, values.json, allPassed);
}

function finalize(steps, startMs, useJson, allPassed) {
  const total_duration_ms = Date.now() - startMs;
  const result = {
    ok: allPassed,
    kind: "better.ci",
    schemaVersion: 1,
    all_passed: allPassed,
    total_duration_ms,
    steps,
  };

  if (useJson) {
    printJson(result);
  } else {
    const passed = steps.filter(s => s.status === "passed").length;
    const failed = steps.filter(s => s.status === "failed").length;
    const skipped = steps.filter(s => s.status === "skipped").length;
    const summary = allPassed
      ? `✓ CI passed — ${passed} passed, ${skipped} skipped (${total_duration_ms}ms)`
      : `✗ CI failed — ${passed} passed, ${failed} failed, ${skipped} skipped (${total_duration_ms}ms)`;
    printText(summary);
    if (!allPassed) {
      for (const s of steps.filter(st => st.status === "failed")) {
        printText(`  ✗ ${s.name}`);
        if (s.details?.stderr) printText(`    ${s.details.stderr}`);
      }
    }
  }

  if (!allPassed) process.exitCode = 1;
}
