import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runPlanAuditFixesNapi } from "../lib/core.js";

/**
 * `better audit fix` — automatically fix vulnerabilities
 *
 * Strategy:
 * 1. Run audit to get list of vulnerabilities with fix versions
 * 2. For packages with semver-compatible fixes, update package.json
 * 3. For packages with breaking fixes, report and optionally apply with --force
 * 4. Re-run install to apply fixes
 */
export async function cmdAuditFix(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better audit fix [options]

Automatically fix known vulnerabilities by upgrading affected packages.

Options:
  --dry-run           Show what would be fixed without making changes
  --force             Apply breaking (major version) fixes
  --prod-only         Only fix production dependencies
  --json              Machine-readable JSON output
  --project-root PATH Override project root
  -h, --help          Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "prod-only": { type: "boolean", default: false },
      "project-root": { type: "string" },
    },
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  // Run audit to get vulnerabilities
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const auditResult = spawnSync(
    process.execPath,
    [cliPath, "audit", "--json", "--project-root", projectRoot],
    { encoding: "utf8", timeout: 60000 }
  );

  let auditData;
  try {
    auditData = JSON.parse(auditResult.stdout || "{}");
  } catch {
    auditData = { vulnerabilities: [] };
  }

  const vulns = auditData.vulnerabilities || [];

  if (vulns.length === 0) {
    const result = { ok: true, kind: "better.audit-fix", fixed: 0, message: "No vulnerabilities found" };
    if (values.json) { printJson(result); } else { printText("No vulnerabilities to fix."); }
    return;
  }

  // Read package.json
  const pkgPath = path.join(projectRoot, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch {
    const err = { ok: false, error: "package.json not found" };
    if (values.json) { printJson(err); } else { printText("Error: package.json not found"); }
    process.exitCode = 1;
    return;
  }

  // NAPI fast path: use Rust audit-fix planner for major-version detection
  const napiVulns = vulns
    .filter(v => v.fixedIn && (v.package || v.name))
    .map(v => ({
      package: v.package || v.name,
      version: v.version || v.range || "0.0.0",
      severity: v.severity || "unknown",
      ids: [v.id].filter(Boolean),
      patched_version: v.fixedIn || null
    }));

  const napiPlan = napiVulns.length > 0
    ? runPlanAuditFixesNapi(projectRoot, JSON.stringify(napiVulns), values.force === true)
    : null;

  let fixes = [];
  const needsForce = [];

  if (napiPlan !== null && napiPlan.ok) {
    const data = napiPlan.data ?? napiPlan;
    for (const detail of (data.details ?? [])) {
      const pkgName = detail.package;
      if (values["prod-only"] && !pkg.dependencies?.[pkgName]) continue;
      const isSkipped = typeof detail.status === "object" && "Skipped" in detail.status;
      if (isSkipped && detail.status.Skipped?.reason?.includes("Major version")) {
        needsForce.push({ name: pkgName, from: detail.from_version, to: detail.to_version });
      } else if (!isSkipped) {
        fixes.push({ name: pkgName, from: detail.from_version, to: `^${detail.to_version}`, breaking: false });
      }
    }
  } else {
    // JS fallback: basic major-version detection
    for (const vuln of vulns) {
      if (!vuln.fixedIn) continue;
      const pkgName = vuln.package || vuln.name;
      if (!pkgName) continue;

      const currentSpec = pkg.dependencies?.[pkgName] || pkg.devDependencies?.[pkgName];
      if (!currentSpec) continue;

      if (values["prod-only"] && !pkg.dependencies?.[pkgName]) continue;

      const fixVersion = vuln.fixedIn;
      const currentMajor = parseInt(currentSpec.replace(/[^0-9].*/, "")) || 0;
      const fixMajor = parseInt(fixVersion.split(".")[0]) || 0;

      if (fixMajor === currentMajor || fixMajor < currentMajor) {
        fixes.push({ name: pkgName, from: currentSpec, to: `^${fixVersion}`, breaking: false });
      } else if (values.force) {
        fixes.push({ name: pkgName, from: currentSpec, to: `^${fixVersion}`, breaking: true });
      } else {
        needsForce.push({ name: pkgName, from: currentSpec, to: `^${fixVersion}`, vuln: vuln.id });
      }
    }
  }

  if (values["dry-run"]) {
    const result = {
      ok: true, kind: "better.audit-fix", dryRun: true,
      fixes, needsForce,
      summary: { willFix: fixes.length, requiresForce: needsForce.length }
    };
    if (values.json) { printJson(result); }
    else {
      if (fixes.length > 0) {
        printText(`Would fix ${fixes.length} vulnerabilities:\n${fixes.map(f => `  ${f.name}: ${f.from} → ${f.to}`).join("\n")}`);
      }
      if (needsForce.length > 0) {
        printText(`${needsForce.length} fixes require --force (breaking changes):\n${needsForce.map(f => `  ${f.name}: ${f.from} → ${f.to} (${f.vuln})`).join("\n")}`);
      }
    }
    return;
  }

  if (fixes.length === 0) {
    const result = { ok: true, kind: "better.audit-fix", fixed: 0, message: `No auto-fixable vulnerabilities. ${needsForce.length} require --force.` };
    if (values.json) { printJson(result); }
    else { printText(`No auto-fixable vulnerabilities.${needsForce.length > 0 ? ` ${needsForce.length} require --force.` : ""}`); }
    return;
  }

  // Apply fixes to package.json
  for (const fix of fixes) {
    if (pkg.dependencies?.[fix.name]) pkg.dependencies[fix.name] = fix.to;
    if (pkg.devDependencies?.[fix.name]) pkg.devDependencies[fix.name] = fix.to;
  }

  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // Re-run install
  if (!values.json) printText(`Fixed ${fixes.length} vulnerabilities. Running install...`);
  const { cmdInstall } = await import("./install.js");
  await cmdInstall(["--project-root", projectRoot]);

  const result = {
    ok: true, kind: "better.audit-fix",
    fixed: fixes.length, fixes,
    needsForce: needsForce.length > 0 ? needsForce : undefined,
  };
  if (values.json) { printJson(result); }
  else { printText(`Fixed ${fixes.length} vulnerabilities.${needsForce.length > 0 ? ` ${needsForce.length} require --force.` : ""}`); }
}
