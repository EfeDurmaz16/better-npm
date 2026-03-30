/**
 * better version-bumper — bump package version with git tag and changelog
 *
 * Bumps the package.json version (patch/minor/major), optionally
 * creates a git commit and tag, and prepends a changelog entry.
 *
 * Usage:
 *   better version-bumper patch
 *   better version-bumper minor --no-tag
 *   better version-bumper major --no-commit
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function bumpVersion(current, type) {
  const parts = current.replace(/^v/, "").split(".").map(Number);
  let [major, minor, patch] = parts;
  if (isNaN(major)) throw new Error(`Invalid version: ${current}`);
  switch (type) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
    default: throw new Error(`Invalid bump type: ${type}`);
  }
}

function fmtDate() {
  return new Date().toISOString().slice(0, 10);
}

export async function cmdVersionBumper(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      "no-tag":   { type: "boolean", default: false },
      "no-commit":{ type: "boolean", default: false },
      "dry-run":  { type: "boolean", default: false },
      message:    { type: "string", short: "m" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better version-bumper <patch|minor|major> [options]

Bump package version with optional git commit and tag.

Arguments:
  patch | minor | major   Type of version bump

Options:
  --no-tag        Skip creating a git tag
  --no-commit     Skip creating a git commit
  --dry-run       Preview without making changes
  -m <message>    Custom tag/commit message
  --json          Machine-readable output
  -h, --help      Show this help

Examples:
  better version-bumper patch
  better version-bumper minor --no-tag
  better version-bumper major --dry-run
`);
    return;
  }

  if (positionals.length === 0 || !["patch", "minor", "major"].includes(positionals[0])) {
    printText("Usage: better version-bumper <patch|minor|major>\nRun: better version-bumper --help for more info.");
    process.exitCode = 1;
    return;
  }

  const bumpType = positionals[0];
  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const pkgPath = path.join(projectRoot, "package.json");

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const currentVersion = pkgJson.version || "0.0.0";
  let newVersion;
  try {
    newVersion = bumpVersion(currentVersion, bumpType);
  } catch (e) {
    const msg = e.message;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const tagName = `v${newVersion}`;
  const commitMsg = values.message || `chore: bump version to ${newVersion}`;
  const date = fmtDate();

  if (!values.json) {
    printText(`\n\x1b[1mbetter version-bumper\x1b[0m\n`);
    printText(`  ${currentVersion} → \x1b[32m${newVersion}\x1b[0m  \x1b[90m(${bumpType})\x1b[0m`);
  }

  if (values["dry-run"]) {
    if (values.json) {
      printJson({ ok: true, kind: "better.version-bumper", dryRun: true, currentVersion, newVersion, bumpType, tagName });
    } else {
      printText(`\n  \x1b[90mDry run — no changes made.\x1b[0m`);
      printText(`  Would update package.json: version → ${newVersion}`);
      if (!values["no-commit"]) printText(`  Would create commit: "${commitMsg}"`);
      if (!values["no-tag"]) printText(`  Would create tag: ${tagName}`);
    }
    return;
  }

  // Write updated package.json
  pkgJson.version = newVersion;
  await fs.writeFile(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf8");

  // Prepend changelog entry if CHANGELOG.md exists
  const changelogPath = path.join(projectRoot, "CHANGELOG.md");
  try {
    const existing = await fs.readFile(changelogPath, "utf8");
    const entry = `## ${newVersion} — ${date}\n\n- \n\n`;
    await fs.writeFile(changelogPath, entry + existing, "utf8");
  } catch { /* no changelog */ }

  // Git operations
  if (!values["no-commit"]) {
    spawnSync("git", ["add", pkgPath, changelogPath], { cwd: projectRoot });
    const commitResult = spawnSync("git", ["commit", "-m", commitMsg], { cwd: projectRoot, encoding: "utf8" });
    if (commitResult.status !== 0) {
      if (!values.json) printText(`  \x1b[33m⚠ Git commit failed (working tree may be dirty)\x1b[0m`);
    }
  }

  if (!values["no-tag"] && !values["no-commit"]) {
    const tagResult = spawnSync("git", ["tag", tagName, "-a", "-m", commitMsg], { cwd: projectRoot, encoding: "utf8" });
    if (tagResult.status !== 0) {
      if (!values.json) printText(`  \x1b[33m⚠ Git tag failed\x1b[0m`);
    }
  }

  if (values.json) {
    printJson({ ok: true, kind: "better.version-bumper", currentVersion, newVersion, bumpType, tagName, dryRun: false });
    return;
  }

  printText(`\n  \x1b[32m✔ Updated package.json\x1b[0m`);
  if (!values["no-commit"]) printText(`  \x1b[32m✔ Created commit: "${commitMsg}"\x1b[0m`);
  if (!values["no-tag"] && !values["no-commit"]) printText(`  \x1b[32m✔ Created tag: ${tagName}\x1b[0m`);
  printText(`\n  Next: \x1b[36mgit push && git push --tags\x1b[0m\n`);
}
