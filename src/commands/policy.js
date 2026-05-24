import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { analyzeWithBestEngine } from "../lib/analyzeFacade.js";
import { enrichPackagesWithManifest } from "../lib/packageMeta.js";
import { runCheckApprovalsNapi } from "../lib/core.js";

const DEFAULT_POLICY = {
  threshold: 70,
  rules: [
    { id: "no-deprecated", severity: "error", description: "Fail on deprecated packages" },
    { id: "max-duplicates", severity: "warning", maxDuplicates: 3, description: "Warn on excessive duplicate versions" },
    { id: "max-depth", severity: "warning", maxDepth: 15, description: "Warn on deep dependency trees" },
    { id: "no-banned", severity: "error", packages: [], description: "Fail on banned packages" },
    { id: "max-install-size", severity: "warning", maxMiB: 500, description: "Warn when total node_modules exceeds size limit" },
    { id: "min-maintainers", severity: "warning", minMaintainers: 1, description: "Warn on packages with no maintainers listed" },
    { id: "min-publish-age", severity: "warning", minDays: 0, description: "Warn on packages published very recently (potential typosquatting)" }
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
      case "max-install-size": {
        const maxMiB = rule.maxMiB ?? 500;
        const totalMiB = Number(analysis.nodeModules?.logicalMiB ?? analysis.nodeModulesMiB ?? 0);
        if (totalMiB > 0 && totalMiB > maxMiB) {
          violations.push({
            rule: rule.id,
            severity: rule.severity ?? "warning",
            reason: `node_modules size ${totalMiB.toFixed(0)} MiB exceeds limit ${maxMiB} MiB`,
            remediation: "Run `better prune` or audit large packages with `better size`.",
            details: { actual: totalMiB, maxAllowed: maxMiB }
          });
        } else {
          passed.push({ rule: rule.id, reason: "within_limits", details: { actual: totalMiB, maxAllowed: maxMiB } });
        }
        break;
      }
      case "min-maintainers": {
        const minM = rule.minMaintainers ?? 1;
        for (const pkg of packages) {
          const maintainerCount = Array.isArray(pkg.maintainers) ? pkg.maintainers.length : (pkg.maintainerCount ?? null);
          if (maintainerCount === null) continue;
          if (maintainerCount < minM) {
            if (isWaived("min-maintainers", pkg.name, policy.waivers)) {
              passed.push({ rule: rule.id, package: `${pkg.name}@${pkg.version}`, reason: "waived" });
              continue;
            }
            violations.push({
              rule: rule.id,
              severity: rule.severity ?? "warning",
              package: `${pkg.name}@${pkg.version}`,
              reason: `Package has ${maintainerCount} maintainer(s), minimum is ${minM}`,
              remediation: `Consider alternatives to ${pkg.name} with more active maintainers.`,
              details: { maintainerCount, minMaintainers: minM }
            });
          }
        }
        if (!violations.some(v => v.rule === "min-maintainers")) {
          passed.push({ rule: rule.id, reason: "within_limits" });
        }
        break;
      }
      case "min-publish-age": {
        const minDays = rule.minDays ?? 0;
        if (minDays > 0) {
          const nowMs = Date.now();
          for (const pkg of packages) {
            const publishedAt = pkg.publishedAt ?? pkg.time ?? null;
            if (!publishedAt) continue;
            const publishedMs = new Date(publishedAt).getTime();
            if (!Number.isFinite(publishedMs)) continue;
            const ageDays = (nowMs - publishedMs) / 86400000;
            if (ageDays < minDays) {
              if (isWaived("min-publish-age", pkg.name, policy.waivers)) {
                passed.push({ rule: rule.id, package: `${pkg.name}@${pkg.version}`, reason: "waived" });
                continue;
              }
              violations.push({
                rule: rule.id,
                severity: rule.severity ?? "warning",
                package: `${pkg.name}@${pkg.version}`,
                reason: `Package was published ${ageDays.toFixed(0)} day(s) ago, minimum is ${minDays} day(s)`,
                remediation: `Verify ${pkg.name}@${pkg.version} is not a typosquat or malicious release.`,
                details: { ageDays, minDays }
              });
            }
          }
        }
        if (!violations.some(v => v.rule === "min-publish-age")) {
          passed.push({ rule: rule.id, reason: "within_limits" });
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
  better policy approve <package[@range]> [--reason TEXT] [--scope] [--json] [--project-root PATH]
  better policy revoke <package> [--json] [--project-root PATH]
  better policy pending [--json] [--project-root PATH]
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
      const policyEarly = loadPolicyConfig(projectRoot, runtime);
      if (values.threshold) { const t = Number(values.threshold); if (Number.isFinite(t)) policyEarly.threshold = Math.max(0, Math.min(100, t)); }
      const out = { ok: false, kind: "better.policy.check", schemaVersion: 1, reason: analysis?.reason ?? "analysis_failed", error: analysis?.reason ?? "analysis_failed", score: 0, threshold: policyEarly.threshold, pass: false };
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

    // NAPI: check package approvals
    const approvals = runCheckApprovalsNapi(projectRoot);
    const approvalFail = approvals?.ok && !approvals.all_approved && approvals.unapproved?.length > 0;
    const pass = errors.length === 0 && score >= policy.threshold && !approvalFail;

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

  if (sub === "approve") {
    const { values: approveValues, positionals: approvePositionals } = parseArgs({
      args: rest,
      options: {
        json: { type: "boolean", default: runtime.json === true },
        "project-root": { type: "string" },
        reason: { type: "string", default: "" },
        scope: { type: "boolean", default: false },
        "review-url": { type: "string" }
      },
      allowPositionals: true,
      strict: false
    });
    const projectRoot2 = approveValues["project-root"] ? path.resolve(approveValues["project-root"]) : process.cwd();
    const spec = approvePositionals[0];
    if (!spec) {
      printText("Usage: better policy approve <package[@range]> [--reason TEXT] [--scope]");
      process.exitCode = 1;
      return;
    }
    const approvedPath = path.join(projectRoot2, ".better-approved.json");
    let approved = { version: 1, mode: "allowlist", packages: {}, scopes: {}, settings: { allow_transitive_unapproved: true, require_reason: false } };
    try { approved = JSON.parse(await fs.readFile(approvedPath, "utf8")); } catch { /* new file */ }

    const author = process.env.USER || process.env.USERNAME || "unknown";
    const today = new Date().toISOString().split("T")[0];

    if (approveValues.scope || spec.startsWith("@") && !spec.includes("/")) {
      approved.scopes ??= {};
      approved.scopes[spec] = { auto_approve: true, reason: approveValues.reason || "Auto-approved scope" };
    } else {
      const atIdx = spec.lastIndexOf("@");
      const name = atIdx > 0 ? spec.slice(0, atIdx) : spec;
      const range = atIdx > 0 ? spec.slice(atIdx + 1) : "*";
      approved.packages ??= {};
      if (!approved.packages[name]) {
        approved.packages[name] = { approved_versions: [], approved_by: author, approved_at: today, reason: approveValues.reason || "" };
      }
      if (!approved.packages[name].approved_versions.includes(range)) {
        approved.packages[name].approved_versions.push(range);
      }
      if (approveValues.reason) approved.packages[name].reason = approveValues.reason;
      if (approveValues["review-url"]) approved.packages[name].review_url = approveValues["review-url"];
    }

    await fs.writeFile(approvedPath, JSON.stringify(approved, null, 2) + "\n");
    const out = { ok: true, kind: "better.policy.approve", schemaVersion: 1, spec, approvedPath };
    if (approveValues.json) printJson(out);
    else printText(`better policy approve: approved ${spec}`);
    return;
  }

  if (sub === "revoke") {
    const { values: revokeValues, positionals: revokePositionals } = parseArgs({
      args: rest,
      options: {
        json: { type: "boolean", default: runtime.json === true },
        "project-root": { type: "string" }
      },
      allowPositionals: true,
      strict: false
    });
    const projectRoot3 = revokeValues["project-root"] ? path.resolve(revokeValues["project-root"]) : process.cwd();
    const name = revokePositionals[0];
    if (!name) {
      printText("Usage: better policy revoke <package>");
      process.exitCode = 1;
      return;
    }
    const approvedPath2 = path.join(projectRoot3, ".better-approved.json");
    let approved2 = { version: 1, mode: "allowlist", packages: {}, scopes: {} };
    try { approved2 = JSON.parse(await fs.readFile(approvedPath2, "utf8")); } catch { /* no file */ }

    const wasPackage = name in (approved2.packages ?? {});
    const wasScope = name in (approved2.scopes ?? {});
    delete (approved2.packages ?? {})[name];
    delete (approved2.scopes ?? {})[name];

    if (wasPackage || wasScope) {
      await fs.writeFile(approvedPath2, JSON.stringify(approved2, null, 2) + "\n");
    }

    const out2 = { ok: true, kind: "better.policy.revoke", schemaVersion: 1, name, wasApproved: wasPackage || wasScope };
    if (revokeValues.json) printJson(out2);
    else printText(`better policy revoke: ${wasPackage || wasScope ? `revoked ${name}` : `${name} was not approved`}`);
    return;
  }

  if (sub === "pending") {
    const { values: pendingValues } = parseArgs({
      args: rest,
      options: {
        json: { type: "boolean", default: runtime.json === true },
        "project-root": { type: "string" }
      },
      allowPositionals: true,
      strict: false
    });
    const projectRoot4 = pendingValues["project-root"] ? path.resolve(pendingValues["project-root"]) : process.cwd();
    const approvedPath3 = path.join(projectRoot4, ".better-approved.json");
    let approved3 = { version: 1, mode: "allowlist", packages: {}, scopes: {} };
    try { approved3 = JSON.parse(await fs.readFile(approvedPath3, "utf8")); } catch { /* no file */ }

    // Read lockfile to get installed packages
    const lockfilePath = path.join(projectRoot4, "package-lock.json");
    let lockPackages = [];
    try {
      const lock = JSON.parse(await fs.readFile(lockfilePath, "utf8"));
      lockPackages = Object.entries(lock.packages ?? {})
        .filter(([k]) => k && k !== "")
        .map(([k, v]) => ({ name: k.replace(/^node_modules\//, ""), version: v.version ?? "0.0.0" }));
    } catch { /* no lockfile */ }

    function isApproved(name, _version) {
      if (approved3.mode === "allowlist") {
        // Check scope auto-approve
        const scope = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : null;
        if (scope && approved3.scopes?.[scope]?.auto_approve) return true;
        if (approved3.packages?.[name]) return true;
        return false;
      }
      // denylist mode: everything allowed unless explicitly denied
      return !(name in (approved3.packages ?? {}));
    }

    const unapproved = lockPackages.filter(p => !isApproved(p.name, p.version));
    const out3 = {
      ok: true,
      kind: "better.policy.pending",
      schemaVersion: 1,
      mode: approved3.mode ?? "allowlist",
      total: lockPackages.length,
      unapproved: unapproved.length,
      packages: unapproved.slice(0, 100)
    };

    if (pendingValues.json) printJson(out3);
    else {
      if (unapproved.length === 0) {
        printText(`better policy pending: all ${lockPackages.length} packages approved`);
      } else {
        const lines = [
          `better policy pending: ${unapproved.length} unapproved package(s) of ${lockPackages.length} total`,
          ...unapproved.slice(0, 20).map(p => `  - ${p.name}@${p.version}`),
          ...(unapproved.length > 20 ? [`  ... and ${unapproved.length - 20} more`] : [])
        ];
        printText(lines.join("\n"));
      }
    }
    return;
  }

  throw new Error(`Unknown policy subcommand '${sub}'. Expected check|init|approve|revoke|pending.`);
}
