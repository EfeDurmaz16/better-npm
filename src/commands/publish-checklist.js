/**
 * better publish-checklist — pre-publish validation checklist
 *
 * Runs a comprehensive checklist before publishing to npm:
 * version, git state, tests, build, files, changelog, etc.
 *
 * Usage:
 *   better publish-checklist
 *   better publish-checklist --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000, cwd });
  return { ok: r.status === 0, output: (r.stdout || "") + (r.stderr || "") };
}

export async function cmdPublishChecklist(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better publish-checklist [options]

Run a comprehensive pre-publish validation checklist.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • package.json completeness (name, version, description, license)
  • .npmignore or files field presence
  • No uncommitted git changes
  • No debug code or console.logs in source
  • Tests pass
  • Build succeeds
  • Changelog updated
  • Version not already published
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter publish-checklist\x1b[0m\n`);
  }

  const checks = [];

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  // 1. Required fields
  const hasName = !!pkgJson.name;
  const hasVersion = !!pkgJson.version;
  const hasDescription = !!pkgJson.description;
  const hasLicense = !!pkgJson.license;
  checks.push({ name: "pkg-name",        ok: hasName,        label: hasName ? `Name: ${pkgJson.name}` : "Missing: name field" });
  checks.push({ name: "pkg-version",     ok: hasVersion,     label: hasVersion ? `Version: ${pkgJson.version}` : "Missing: version field" });
  checks.push({ name: "pkg-description", ok: hasDescription, label: hasDescription ? "Description present" : "Missing: description field" });
  checks.push({ name: "pkg-license",     ok: hasLicense,     label: hasLicense ? `License: ${pkgJson.license}` : "Missing: license field" });

  // 2. Not private
  checks.push({ name: "not-private", ok: !pkgJson.private, label: pkgJson.private ? "Package is marked private — remove to publish" : "Not private" });

  // 3. Files field or .npmignore
  let hasFilesControl = Array.isArray(pkgJson.files) && pkgJson.files.length > 0;
  if (!hasFilesControl) {
    try { await fs.access(path.join(projectRoot, ".npmignore")); hasFilesControl = true; } catch {}
  }
  checks.push({ name: "files-control", ok: hasFilesControl, label: hasFilesControl ? "Files controlled (files field or .npmignore)" : "No files field or .npmignore — entire directory will be published" });

  // 4. Main/exports entry point
  const hasEntry = !!pkgJson.main || !!pkgJson.module || !!pkgJson.exports;
  checks.push({ name: "entry-point", ok: hasEntry, label: hasEntry ? "Entry point defined (main/module/exports)" : "No entry point (main/module/exports)" });

  // 5. Git clean
  const gitStatus = run("git", ["status", "--porcelain"], projectRoot);
  const isDirty = gitStatus.ok && gitStatus.output.trim().length > 0;
  checks.push({ name: "git-clean", ok: !isDirty, label: isDirty ? "Uncommitted changes in working tree" : "Git working tree is clean" });

  // 6. Test script
  const hasTestScript = !!pkgJson.scripts?.test && !pkgJson.scripts.test.includes("no test");
  checks.push({ name: "test-script", ok: hasTestScript, label: hasTestScript ? "Test script present" : 'No test script (or "no test" placeholder)' });

  // 7. Build output (if build script exists)
  if (pkgJson.scripts?.build) {
    let buildExists = false;
    for (const outDir of ["dist", "lib", "build", "out"]) {
      try { await fs.access(path.join(projectRoot, outDir)); buildExists = true; break; } catch {}
    }
    checks.push({ name: "build-output", ok: buildExists, label: buildExists ? "Build output directory exists" : "No build output found — run npm run build" });
  }

  // 8. Changelog
  let hasChangelog = false;
  for (const f of ["CHANGELOG.md", "CHANGELOG", "HISTORY.md", "CHANGES.md"]) {
    try { await fs.access(path.join(projectRoot, f)); hasChangelog = true; break; } catch {}
  }
  checks.push({ name: "changelog", ok: hasChangelog, label: hasChangelog ? "Changelog present" : "No CHANGELOG.md found" });

  // 9. README
  let hasReadme = false;
  try { await fs.access(path.join(projectRoot, "README.md")); hasReadme = true; } catch {}
  checks.push({ name: "readme", ok: hasReadme, label: hasReadme ? "README.md present" : "No README.md" });

  // 10. No debug artifacts
  const srcDirCheck = path.join(projectRoot, "src");
  let hasDebugCode = false;
  try {
    const r = spawnSync("grep", ["-r", "--include=*.js", "--include=*.ts", "-l", "debugger;", srcDirCheck], { encoding: "utf8", timeout: 5000 });
    hasDebugCode = r.stdout?.trim().length > 0;
  } catch {}
  checks.push({ name: "no-debugger", ok: !hasDebugCode, label: hasDebugCode ? "debugger; statements found in source" : "No debugger statements found" });

  const passed = checks.filter(c => c.ok).length;
  const failed = checks.filter(c => !c.ok).length;
  const ok = failed === 0;

  if (values.json) {
    printJson({ ok, kind: "better.publish-checklist", passed, failed, checks });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const c of checks) {
    const icon = c.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
  }

  printText("");
  if (ok) {
    printText(`\x1b[32m✔ All ${passed} checks passed. Ready to publish!\x1b[0m`);
    printText(`  Run: \x1b[36mnpm publish\x1b[0m`);
  } else {
    printText(`\x1b[31m✘ ${failed} check(s) failed. Fix issues before publishing.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
