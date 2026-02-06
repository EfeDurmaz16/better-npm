import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { analyzeWithBestEngine } from "../lib/analyzeFacade.js";
import { printJson, printText } from "../lib/output.js";
import { enrichPackagesWithManifest } from "../lib/packageMeta.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { detectPackageManager } from "../pm/detect.js";
import { runCommand } from "../lib/spawn.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function scoreFromAnalysis(analysis, opts = {}) {
  const findings = opts.findings ?? [];
  const deduction = findings.reduce((sum, finding) => sum + Number(finding.impact ?? 0), 0);
  return {
    score: Math.max(0, 100 - deduction),
    deduction
  };
}

function severityRank(severity) {
  if (severity === "error") return 0;
  if (severity === "warning") return 1;
  return 2;
}

function groupFindings(findings) {
  const grouped = { error: [], warning: [], info: [] };
  for (const finding of findings) {
    grouped[finding.severity].push(finding);
  }
  return grouped;
}

async function getLockfileStaleReason(projectRoot) {
  if (!projectRoot) return null;
  const lockfiles = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json"];
  const pkgPath = path.join(projectRoot, "package.json");
  try {
    const pkgSt = await fs.stat(pkgPath);
    for (const lockfile of lockfiles) {
      const lockfilePath = path.join(projectRoot, lockfile);
      if (!(await exists(lockfilePath))) continue;
      const lockSt = await fs.stat(lockfilePath);
      if (lockSt.mtimeMs < pkgSt.mtimeMs) {
        return `${lockfile} is older than package.json`;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function buildHealthFindings(analysis, packages, opts = {}) {
  const findings = [];
  const maxDepth = opts.maxDepth ?? 15;
  const p95Depth = opts.p95Depth ?? 10;
  const largeNodeModulesBytes = opts.largeNodeModulesBytes ?? 500 * 1024 * 1024;
  const lockfileStaleReason = opts.lockfileStaleReason ?? null;
  const securityFindings = opts.securityFindings ?? [];

  for (const dup of analysis.duplicates ?? []) {
    if ((dup.versions ?? []).length <= 1) continue;
    const impact = Math.min(18, (dup.versions.length - 1) * 4);
    findings.push({
      id: "duplicate_versions",
      title: `Duplicate versions for ${dup.name}`,
      severity: "warning",
      impact,
      recommendation: "Use package-manager dedupe commands and align dependent version ranges.",
      details: {
        versions: dup.versions,
        majors: dup.majors,
        count: dup.count
      }
    });
  }

  for (const pkg of packages) {
    if (!pkg.deprecated) continue;
    findings.push({
      id: "deprecated_package",
      title: `Deprecated package ${pkg.name}@${pkg.version}`,
      severity: "error",
      impact: 6,
      recommendation: "Replace deprecated packages with actively maintained alternatives.",
      details: { message: pkg.deprecated, key: pkg.key }
    });
  }

  if ((analysis.depth?.maxDepth ?? 0) > maxDepth) {
    findings.push({
      id: "excessive_depth",
      title: "Dependency tree is too deep",
      severity: "warning",
      impact: 10,
      recommendation: "Investigate deep chains and reduce unnecessary transitive layers.",
      details: { maxDepth: analysis.depth?.maxDepth, threshold: maxDepth }
    });
  } else if ((analysis.depth?.p95Depth ?? 0) > p95Depth) {
    findings.push({
      id: "high_p95_depth",
      title: "Dependency depth p95 is high",
      severity: "warning",
      impact: 6,
      recommendation: "Audit frequently deep dependency paths and consolidate where possible.",
      details: { p95Depth: analysis.depth?.p95Depth, threshold: p95Depth }
    });
  }

  const nodeModulesSize = analysis.nodeModules?.physicalBytes ?? 0;
  if (nodeModulesSize > largeNodeModulesBytes) {
    findings.push({
      id: "large_node_modules",
      title: "Large node_modules footprint",
      severity: "warning",
      impact: 12,
      recommendation: "Remove unused dependencies and consider lighter alternatives.",
      details: { bytes: nodeModulesSize, threshold: largeNodeModulesBytes }
    });
  }

  if (lockfileStaleReason) {
    findings.push({
      id: "lockfile_stale",
      title: "Lockfile appears stale",
      severity: "warning",
      impact: 15,
      recommendation: "Regenerate and commit lockfile changes for reproducible installs.",
      details: { reason: lockfileStaleReason }
    });
  }

  findings.push(...securityFindings);

  return findings.sort((a, b) => {
    const sevCmp = severityRank(a.severity) - severityRank(b.severity);
    if (sevCmp !== 0) return sevCmp;
    return b.impact - a.impact;
  });
}

async function runFixes(projectRoot, jsonOutput) {
  const detected = await detectPackageManager(projectRoot);
  let cmd = null;
  let args = [];
  if (detected.pm === "pnpm") {
    cmd = "pnpm";
    args = ["dedupe"];
  } else if (detected.pm === "yarn") {
    cmd = "yarn";
    args = ["dedupe"];
  } else {
    cmd = "npm";
    args = ["dedupe"];
  }
  const result = await runCommand(cmd, args, {
    cwd: projectRoot,
    passthroughStdio: !jsonOutput,
    captureLimitBytes: 64 * 1024
  });
  return {
    pm: detected.pm,
    command: { cmd, args },
    exitCode: result.exitCode,
    wallTimeMs: result.wallTimeMs,
    stderrTail: result.stderrTail,
    ok: result.exitCode === 0
  };
}

function parseAuditJson(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Some tools emit JSON lines.
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        // continue
      }
    }
  }
  return null;
}

function severityCountersFromAudit(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  if (parsed.metadata?.vulnerabilities) {
    const v = parsed.metadata.vulnerabilities;
    return {
      info: Number(v.info ?? 0),
      low: Number(v.low ?? 0),
      moderate: Number(v.moderate ?? 0),
      high: Number(v.high ?? 0),
      critical: Number(v.critical ?? 0)
    };
  }

  if (parsed.vulnerabilities && typeof parsed.vulnerabilities === "object") {
    let info = 0;
    let low = 0;
    let moderate = 0;
    let high = 0;
    let critical = 0;
    for (const vuln of Object.values(parsed.vulnerabilities)) {
      const sev = String(vuln?.severity ?? "low");
      if (sev === "critical") critical += 1;
      else if (sev === "high") high += 1;
      else if (sev === "moderate") moderate += 1;
      else if (sev === "info") info += 1;
      else low += 1;
    }
    return { info, low, moderate, high, critical };
  }

  return null;
}

async function runSecurityAudit(projectRoot, opts = {}) {
  const pmDetected = await detectPackageManager(projectRoot);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const candidates = [];
  if (pmDetected.pm === "pnpm") {
    candidates.push({ cmd: "pnpm", args: ["audit", "--json"] });
  } else if (pmDetected.pm === "yarn") {
    candidates.push({ cmd: "yarn", args: ["npm", "audit", "--json"] });
    candidates.push({ cmd: "yarn", args: ["audit", "--json"] });
  } else {
    candidates.push({ cmd: "npm", args: ["audit", "--json"] });
  }

  for (const candidate of candidates) {
    const res = await runCommand(candidate.cmd, candidate.args, {
      cwd: projectRoot,
      passthroughStdio: false,
      captureLimitBytes: 512 * 1024,
      timeoutMs
    });
    if (res.timedOut) {
      return {
        ok: false,
        status: "timeout",
        pm: pmDetected.pm,
        command: candidate,
        error: `audit timed out after ${timeoutMs}ms`
      };
    }

    const parsed = parseAuditJson(res.stdout);
    const counters = severityCountersFromAudit(parsed);
    if (counters) {
      return {
        ok: true,
        status: "ok",
        pm: pmDetected.pm,
        command: candidate,
        counters
      };
    }

    if (res.exitCode === 0 && res.stderr.trim().length === 0) {
      return {
        ok: true,
        status: "ok",
        pm: pmDetected.pm,
        command: candidate,
        counters: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }
      };
    }
  }

  return {
    ok: false,
    status: "unavailable",
    pm: pmDetected.pm,
    error: "audit command unavailable or returned non-JSON output"
  };
}

function securityFindingsFromAudit(audit) {
  if (!audit?.ok || !audit?.counters) {
    return [
      {
        id: "security_advisories_stub",
        title: "Security advisory scan unavailable",
        severity: "info",
        impact: 0,
        recommendation: "Configure npm/pnpm/yarn audit in this environment for vulnerability checks.",
        details: {
          status: audit?.status ?? "unavailable",
          error: audit?.error ?? null
        }
      }
    ];
  }

  const counters = audit.counters;
  const findings = [];
  const highRisk = Number(counters.high ?? 0) + Number(counters.critical ?? 0);
  const moderate = Number(counters.moderate ?? 0);
  const low = Number(counters.low ?? 0);
  const info = Number(counters.info ?? 0);

  if (highRisk > 0) {
    findings.push({
      id: "security_high_risk",
      title: "High-risk vulnerabilities detected",
      severity: "error",
      impact: Math.min(30, Number(counters.critical ?? 0) * 10 + Number(counters.high ?? 0) * 5),
      recommendation: "Prioritize upgrading or replacing vulnerable dependencies.",
      details: counters
    });
  }
  if (moderate > 0) {
    findings.push({
      id: "security_moderate",
      title: "Moderate vulnerabilities detected",
      severity: "warning",
      impact: Math.min(15, moderate * 2),
      recommendation: "Schedule dependency updates to resolve moderate advisories.",
      details: counters
    });
  }
  if (findings.length === 0 && (low > 0 || info > 0)) {
    findings.push({
      id: "security_low_info",
      title: "Low/info vulnerabilities present",
      severity: "info",
      impact: 0,
      recommendation: "Review low/info advisories and update when convenient.",
      details: counters
    });
  }
  if (findings.length === 0) {
    findings.push({
      id: "security_no_findings",
      title: "No vulnerabilities reported",
      severity: "info",
      impact: 0,
      recommendation: "Continue regular dependency audits in CI.",
      details: counters
    });
  }
  return findings;
}

export async function cmdDoctor(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better doctor [--json] [--threshold N] [--fix] [--from FILE]
                [--security auto|on|off] [--core|--no-core]
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "doctor" });
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      from: { type: "string" },
      fix: { type: "boolean", default: false },
      threshold: { type: "string", default: String(runtime.doctor?.threshold ?? 70) },
      security: { type: "string", default: "auto" }, // auto|on|off
      "fail-on": { type: "string", default: "fail" },
      core: { type: "boolean", default: false },
      "no-core": { type: "boolean", default: false }
    },
    allowPositionals: true,
    strict: false
  });

  let analysis;
  if (values.from) {
    const raw = await fs.readFile(path.resolve(values.from), "utf8");
    analysis = JSON.parse(raw);
  } else {
    const coreMode = values["no-core"] ? "off" : values.core ? "force" : "auto";
    const res = await analyzeWithBestEngine(process.cwd(), { includeGraph: false, coreMode });
    analysis = res.analysis;
  }

  if (!analysis.ok) {
    const out = { ok: false, kind: "better.doctor", schemaVersion: 2, reason: analysis.reason ?? "analysis_failed" };
    if (values.json) printJson(out);
    else printText(`better doctor: ${out.reason}`);
    process.exitCode = 1;
    return;
  }

  let packages = await enrichPackagesWithManifest(analysis.packages ?? []);
  const lockfileStaleReason = await getLockfileStaleReason(analysis.projectRoot);
  const thresholdRaw = Number(values.threshold);
  const threshold = Number.isFinite(thresholdRaw) ? Math.max(0, Math.min(100, thresholdRaw)) : 70;
  const securityMode = values.security;
  if (!["auto", "on", "off"].includes(securityMode)) {
    throw new Error(`Unknown --security '${securityMode}'. Expected auto|on|off.`);
  }
  let audit = null;
  let securityFindings = [];
  if (securityMode !== "off") {
    audit = await runSecurityAudit(analysis.projectRoot, { timeoutMs: securityMode === "on" ? 20_000 : 2_500 });
    securityFindings = securityFindingsFromAudit(audit);
  }

  let findings = buildHealthFindings(analysis, packages, {
    maxDepth: runtime.doctor?.maxDepth,
    p95Depth: runtime.doctor?.p95Depth,
    largeNodeModulesBytes: runtime.doctor?.largeNodeModulesBytes,
    lockfileStaleReason,
    securityFindings
  });

  let fixes = null;
  if (values.fix) {
    commandLogger.info("doctor.fix.start", { projectRoot: analysis.projectRoot });
    const fixResult = await runFixes(analysis.projectRoot, values.json);
    fixes = { attempted: true, steps: [fixResult] };
    if (fixResult.ok) {
      const res = await analyzeWithBestEngine(analysis.projectRoot, { includeGraph: false, coreMode: "auto" });
      if (res.analysis?.ok) {
        analysis = res.analysis;
        packages = await enrichPackagesWithManifest(analysis.packages ?? []);
        if (securityMode !== "off") {
          audit = await runSecurityAudit(analysis.projectRoot, { timeoutMs: securityMode === "on" ? 20_000 : 2_500 });
          securityFindings = securityFindingsFromAudit(audit);
        }
        findings = buildHealthFindings(analysis, packages, {
          maxDepth: runtime.doctor?.maxDepth,
          p95Depth: runtime.doctor?.p95Depth,
          largeNodeModulesBytes: runtime.doctor?.largeNodeModulesBytes,
          lockfileStaleReason: await getLockfileStaleReason(analysis.projectRoot),
          securityFindings
        });
      }
    }
    commandLogger.info("doctor.fix.end", { ok: fixResult.ok, exitCode: fixResult.exitCode });
  }

  const { score, deduction } = scoreFromAnalysis(analysis, { findings });
  const grouped = groupFindings(findings);
  const out = {
    ok: true,
    kind: "better.doctor",
    schemaVersion: 2,
    projectRoot: analysis.projectRoot,
    healthScore: {
      score,
      threshold,
      maxScore: 100,
      deduction,
      belowThreshold: score < threshold
    },
    findings,
    findingsBySeverity: grouped,
    checks: {
      duplicates: findings.filter((f) => f.id === "duplicate_versions").length,
      deprecated: findings.filter((f) => f.id === "deprecated_package").length,
      depth: findings.some((f) => f.id === "excessive_depth" || f.id === "high_p95_depth"),
      size: findings.some((f) => f.id === "large_node_modules"),
      lockfileStale: findings.some((f) => f.id === "lockfile_stale"),
      securityAdvisories: findings.some((f) => String(f.id).startsWith("security_"))
    },
    securityAudit: audit,
    fixes
  };

  if (values.json) {
    printJson(out);
  } else {
    printText(
      [
        "better doctor",
        `- health score: ${score}/100 (threshold: ${threshold})`,
        `- findings: ${findings.length}`,
        `- errors/warnings/info: ${grouped.error.length}/${grouped.warning.length}/${grouped.info.length}`,
        ...findings.slice(0, 10).map((f) => `  - [${f.severity}] ${f.title} (impact ${f.impact})`)
      ].join("\n")
    );
  }

  process.exitCode = score < threshold ? 1 : 0;
}
