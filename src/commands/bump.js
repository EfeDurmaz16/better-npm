/**
 * better bump — bump package version
 *
 * Increments the version in package.json according to semver rules.
 * Optionally creates a git commit and tag.
 *
 * Usage:
 *   better bump patch                 # 1.0.0 → 1.0.1
 *   better bump minor                 # 1.0.0 → 1.1.0
 *   better bump major                 # 1.0.0 → 2.0.0
 *   better bump prerelease --pre beta # 1.0.0 → 1.0.1-beta.0
 *   better bump 2.5.0                 # set exact version
 *   better bump patch --tag           # commit + git tag
 *   better bump patch --dry-run       # preview only
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function semverParts(v) {
  const clean = String(v ?? "0.0.0").replace(/^v/, "").split("-")[0];
  const [maj, min, pat] = clean.split(".").map(n => parseInt(n) || 0);
  const preRaw = String(v ?? "").includes("-") ? String(v).split("-").slice(1).join("-") : null;
  return { major: maj, minor: min, patch: pat, pre: preRaw };
}

function bumpVersion(current, type, preId) {
  const v = semverParts(current);
  switch (type) {
    case "major":
      return `${v.major + 1}.0.0`;
    case "minor":
      return `${v.major}.${v.minor + 1}.0`;
    case "patch":
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    case "premajor":
      return `${v.major + 1}.0.0-${preId || "0"}.0`;
    case "preminor":
      return `${v.major}.${v.minor + 1}.0-${preId || "0"}.0`;
    case "prepatch":
      return `${v.major}.${v.minor}.${v.patch + 1}-${preId || "0"}.0`;
    case "prerelease": {
      if (v.pre) {
        // Increment pre-release number
        const parts = v.pre.split(".");
        const lastNum = parseInt(parts[parts.length - 1]);
        if (!isNaN(lastNum)) {
          parts[parts.length - 1] = String(lastNum + 1);
          return `${v.major}.${v.minor}.${v.patch}-${parts.join(".")}`;
        }
      }
      return `${v.major}.${v.minor}.${v.patch + 1}-${preId || "alpha"}.0`;
    }
    default:
      // Treat as explicit version
      if (/^\d+\.\d+\.\d+/.test(type)) return type;
      return null;
  }
}

export async function cmdBump(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      tag: { type: "boolean", default: false },
      commit: { type: "boolean", default: true },
      "no-commit": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      pre: { type: "string" },
      message: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printText(`Usage: better bump <type|version> [options]

Bump package.json version following semver.

Types:
  patch       1.0.0 → 1.0.1
  minor       1.0.0 → 1.1.0
  major       1.0.0 → 2.0.0
  prerelease  1.0.0 → 1.0.1-alpha.0
  prepatch    1.0.0 → 1.0.1-alpha.0
  preminor    1.0.0 → 1.1.0-alpha.0
  premajor    1.0.0 → 2.0.0-alpha.0
  <version>   Set exact version (e.g., 2.5.0)

Options:
  --pre <id>      Pre-release identifier (default: alpha)
  --tag           Create git tag after bump
  --no-commit     Only update package.json, no git commit
  --dry-run       Preview without changes
  --message <msg> Custom commit message
  --json          Machine-readable output
  -h, --help      Show this help

Examples:
  better bump patch
  better bump minor --tag
  better bump 3.0.0 --tag
  better bump prerelease --pre beta
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const pkgPath = path.join(projectRoot, "package.json");

  let pkg;
  let raw;
  try {
    raw = await fs.readFile(pkgPath, "utf8");
    pkg = JSON.parse(raw);
  } catch (err) {
    const msg = `Cannot read package.json: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const currentVersion = pkg.version || "0.0.0";
  const bumpType = positionals[0];
  const newVersion = bumpVersion(currentVersion, bumpType, values.pre);

  if (!newVersion) {
    const msg = `Invalid version type or format: ${bumpType}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  if (values.json) {
    if (!values["dry-run"]) {
      pkg.version = newVersion;
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

      if (!values["no-commit"]) {
        const commitMsg = values.message || `chore: bump version to ${newVersion}`;
        spawnSync("git", ["add", pkgPath], { cwd: projectRoot });
        spawnSync("git", ["commit", "-m", commitMsg], { cwd: projectRoot });
        if (values.tag) {
          spawnSync("git", ["tag", `v${newVersion}`, "-m", `v${newVersion}`], { cwd: projectRoot });
        }
      }
    }
    printJson({
      ok: true,
      kind: "better.bump",
      from: currentVersion,
      to: newVersion,
      type: bumpType,
      dry_run: values["dry-run"],
      tagged: values.tag && !values["dry-run"],
    });
    return;
  }

  printText(`\n\x1b[1mbetter bump\x1b[0m${values["dry-run"] ? " \x1b[33m(dry run)\x1b[0m" : ""}`);
  printText(`\n  ${currentVersion}  →  \x1b[1m\x1b[32m${newVersion}\x1b[0m\n`);

  if (values["dry-run"]) {
    printText(`Would update package.json version.`);
    if (!values["no-commit"]) {
      printText(`Would commit: "chore: bump version to ${newVersion}"`);
    }
    if (values.tag) printText(`Would create git tag: v${newVersion}`);
    return;
  }

  // Update package.json
  pkg.version = newVersion;
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  printText(`\x1b[32m✔\x1b[0m Updated package.json → v${newVersion}`);

  // Git operations
  if (!values["no-commit"]) {
    const commitMsg = values.message || `chore: bump version to ${newVersion}`;
    const addResult = spawnSync("git", ["add", pkgPath], { cwd: projectRoot });
    if (addResult.status === 0) {
      const commitResult = spawnSync("git", ["commit", "-m", commitMsg], { cwd: projectRoot, stdio: "pipe" });
      if (commitResult.status === 0) {
        printText(`\x1b[32m✔\x1b[0m Created commit: "${commitMsg}"`);
      }
    }

    if (values.tag) {
      const tagResult = spawnSync("git", ["tag", `v${newVersion}`, "-m", `v${newVersion}`], {
        cwd: projectRoot, stdio: "pipe"
      });
      if (tagResult.status === 0) {
        printText(`\x1b[32m✔\x1b[0m Created tag: v${newVersion}`);
      } else {
        printText(`\x1b[33m⚠\x1b[0m Could not create tag (is git available?)`);
      }
    }
  }
}
