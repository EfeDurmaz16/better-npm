import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { analyzeWithBestEngine } from "../lib/analyzeFacade.js";
import { enrichPackagesWithManifest } from "../lib/packageMeta.js";

const DEFAULT_POLICY = {
  threshold: 70,
  rules: [
    { id: "no-deprecated", severity: "error", description: "Fail on deprecated packages" },
    { id: "max-duplicates", severity: "warning", maxDuplicates: 3, description: "Warn on excessive duplicate versions" },
    { id: "max-depth", severity: "warning", maxDepth: 15, description: "Warn on deep dependency trees" },
    { id: "no-banned", severity: "error", packages: [], description: "Fail on banned packages" }
  ],
  waivers: []
};

function loadPolicyConfig(projectRoot, runtimeConfig) {
  // Priority: runtime config > local file > defaults
  const configPolicy = runtimeConfig?.policy ?? null;
  return {
    threshold: configPolicy?.threshold ?? DEFAULT_POLICY.threshold,
    rules: configPolicy?.rules ?? DEFAULT_POLICY.rules,
    waivers: configPolicy?.waivers ?? DEFAULT_POLICY.waivers
  };
}

function isWaived(ruleId, packageName, waivers) {
  return waivers.some(w => {
    if (w.rule && w.rule !== ruleId) return false;
    if (w.package && w.package !== packageName) return false;
    return true;
  });
}

function evaluateRules(analysis, packages, policy) {
  const violations = [];
  const passed = [];

  for (const rule of policy.rules) {
    switch (rule.id) {
      case "no-deprecated": {
        for (const pkg of packages) {
          if (!pkg.deprecated) continue;
          if (isWaived("no-deprecated", pkg.name, policy.waivers)) {
            passed.push({ rule: rule.id, package: `${pkg.name}@${pkg.version}`, reason: "waived" });
            continue;
          }
          violations.push({
            rule: rule.id,
            severity: rule.severity ?? "error",
            package: `${pkg.name}@${pkg.version}`,
            reason: `Package is deprecated: ${pkg.deprecated}`,
            remediation: `Replace ${pkg.name} with a maintained alternative.`
          });
        }
        if (!violations.some(v => v.rule === "no-deprecated")) {
          passed.push({ rule: rule.id, reason: "no_deprecated_packages" });
        }
        break;
      }
      case "max-duplicates": {
        const maxDuplicates = rule.maxDuplicates ?? 3;
        for (const dup of (analysis.duplicates ?? [])) {
          if ((dup.versions ?? []).length <= 1) continue;
          if (dup.versions.length > maxDuplicates) {
            if (isWaived("max-duplicates", dup.name, policy.waivers)) {
              passed.push({ rule: rule.id, package: dup.name, reason: "waived" });
              continue;
            }
            violations.push({
              rule: rule.id,
              severity: rule.severity ?? "warning",
              package: dup.name,
              reason: `${dup.versions.length} versions exceed max ${maxDuplicates}`,
              remediation: `Run dedupe or align version ranges for ${dup.name}.`,
              details: { versions: dup.versions, maxAllowed: maxDuplicates }
            });
          }
        }
        if (!violations.some(v => v.rule === "max-duplicates")) {
          passed.push({ rule: rule.id, reason: "within_limits" });
        }
        break;
      }
      case "max-depth": {
        const maxDepth = rule.maxDepth ?? 15;
        const actualDepth = analysis.depth?.maxDepth ?? 0;
        if (actualDepth > maxDepth) {
          violations.push({
            rule: rule.id,
            severity: rule.severity ?? "warning",
            reason: `Max depth ${actualDepth} exceeds limit ${maxDepth}`,
            remediation: "Investigate deep dependency chains and consolidate.",
            details: { actual: actualDepth, maxAllowed: maxDepth }
          });
        } else {
          passed.push({ rule: rule.id, reason: "within_limits", details: { actual: actualDepth, maxAllowed: maxDepth } });
        }
        break;
      }
      case "no-banned": {
        const banned = rule.packages ?? [];
        for (const pkg of packages) {
          const bannedEntry = banned.find(b => {
            if (typeof b === "string") return b === pkg.name;
            return b.name === pkg.name && (!b.version || b.version === pkg.version);
          });
          if (!bannedEntry) continue;
          if (isWaived("no-banned", pkg.name, policy.waivers)) {
            passed.push({ rule: rule.id, package: `${pkg.name}@${pkg.version}`, reason: "waived" });
            continue;
          }
          violations.push({
            rule: rule.id,
            severity: rule.severity ?? "error",
            package: `${pkg.name}@${pkg.version}`,
            reason: `Package ${pkg.name} is banned by policy`,
            remediation: `Remove ${pkg.name} and use an approved alternative.`
          });
        }
        if (!violations.some(v => v.rule === "no-banned")) {
          passed.push({ rule: rule.id, reason: "no_banned_packages" });
        }
        break;
      }
      default:
        passed.push({ rule: rule.id, reason: "unknown_rule_skipped" });
    }
  }

  return { violations, passed };
}

export async function cmdPolicy(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printText(`Usage:
  better policy check [--json] [--threshold N] [--project-root PATH]
  better policy init [--json] [--project-root PATH]
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "policy" });
  const { values } = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      threshold: { type: "string" },
      "project-root": { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  const projectRoot = values["project-root"] ? path.resolve(values["project-root"]) : process.cwd();

  if (sub === "init") {
    const configPath = path.join(projectRoot, ".betterrc.json");
    let existingConfig = {};
    try {
      const raw = await fs.readFile(configPath, "utf8");
      existingConfig = JSON.parse(raw);
    } catch { /* no existing config */ }

    const newConfig = {
      ...existingConfig,
      policy: {
        threshold: DEFAULT_POLICY.threshold,
        rules: DEFAULT_POLICY.rules,
        waivers: []
      }
    };

    await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2) + "\n");
    const out = {
      ok: true,
      kind: "better.policy.init",
      schemaVersion: 1,
      projectRoot,
      configPath,
      policy: newConfig.policy
    };
    if (values.json) printJson(out);
    else printText(`better policy init: wrote ${configPath}`);
    return;
  }

  if (sub === "check") {
    commandLogger.info("policy.check.start", { projectRoot });
    const res = await analyzeWithBestEngine(projectRoot, { includeGraph: false, coreMode: "auto" });
    const analysis = res.analysis;

    if (!analysis?.ok) {
      const out = { ok: false, kind: "better.policy.check", schemaVersion: 1, reason: analysis?.reason ?? "analysis_failed" };
      if (values.json) printJson(out);
      else printText(`better policy check: ${out.reason}`);
      process.exitCode = 1;
      return;
    }

    const packages = await enrichPackagesWithManifest(analysis.packages ?? []);
    const policy = loadPolicyConfig(projectRoot, runtime);
    if (values.threshold) {
      const t = Number(values.threshold);
      if (Number.isFinite(t)) policy.threshold = Math.max(0, Math.min(100, t));
    }

    const { violations, passed } = evaluateRules(analysis, packages, policy);
    const errors = violations.filter(v => v.severity === "error");
    const warnings = violations.filter(v => v.severity === "warning");

    // Compute score
    const deduction = violations.reduce((sum, v) => {
      if (v.severity === "error") return sum + 15;
      if (v.severity === "warning") return sum + 5;
      return sum + 2;
    }, 0);
    const score = Math.max(0, 100 - deduction);
    const pass = errors.length === 0 && score >= policy.threshold;

    const out = {
      ok: pass,
      kind: "better.policy.check",
      schemaVersion: 1,
      projectRoot,
      score,
      threshold: policy.threshold,
      pass,
      summary: {
        totalRules: policy.rules.length,
        violations: violations.length,
        errors: errors.length,
        warnings: warnings.length,
        passed: passed.length,
        waivedCount: passed.filter(p => p.reason === "waived").length
      },
      violations,
      passed,
      policy: {
        threshold: policy.threshold,
        rulesCount: policy.rules.length,
        waiversCount: policy.waivers.length
      }
    };

    if (values.json) printJson(out);
    else {
      const lines = [
        `better policy check: ${pass ? "PASS" : "FAIL"}`,
        `- score: ${score}/100 (threshold: ${policy.threshold})`,
        `- violations: ${violations.length} (${errors.length} errors, ${warnings.length} warnings)`,
        `- rules checked: ${policy.rules.length}, waivers: ${policy.waivers.length}`,
        ...violations.slice(0, 10).map(v => `  - [${v.severity}] ${v.rule}: ${v.reason}`)
      ];
      printText(lines.join("\n"));
    }

    process.exitCode = pass ? 0 : 1;
    commandLogger.info("policy.check.end", { pass, score, violations: violations.length });
    return;
  }

  throw new Error(`Unknown policy subcommand '${sub}'. Expected check|init.`);
}
