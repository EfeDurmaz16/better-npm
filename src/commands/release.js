/**
 * better release — full release workflow
 *
 * Orchestrates a complete release: bump version, run tests,
 * generate changelog entry, commit, tag, optionally publish.
 *
 * Usage:
 *   better release patch              # patch release
 *   better release minor              # minor release
 *   better release major --dry-run    # preview major release
 *   better release patch --no-publish # skip npm publish
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
  return { major: maj, minor: min, patch: pat };
}

function bumpVersion(current, type) {
  const v = semverParts(current);
  switch (type) {
    case "major": return `${v.major + 1}.0.0`;
    case "minor": return `${v.major}.${v.minor + 1}.0`;
    case "patch": return `${v.major}.${v.minor}.${v.patch + 1}`;
    default:
      if (/^\d+\.\d+\.\d+/.test(type)) return type;
      return null;
  }
}

function run(cmd, args, cwd, opts = {}) {
  const result = spawnSync(cmd, args, { cwd, stdio: opts.silent ? "pipe" : "inherit" });
  return { ok: result.status === 0, status: result.status };
}

export async function cmdRelease(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "dry-run": { type: "boolean", default: false },
      "no-publish": { type: "boolean", default: false },
      "no-test": { type: "boolean", default: false },
      "no-build": { type: "boolean", default: false },
      "no-tag": { type: "boolean", default: false },
      access: { type: "string", default: "public" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printText(`Usage: better release <type> [options]

Orchestrate a full release: bump → test → build → commit → tag → publish.

Types: patch | minor | major | <version>

Options:
  --dry-run      Preview all steps without executing
  --no-publish   Skip npm publish
  --no-test      Skip test run
  --no-build     Skip build step
  --no-tag       Skip git tag creation
  --access       npm publish access: public (default) | restricted
  --json         Machine-readable output
  -h, --help     Show this help

Examples:
  better release patch
  better release minor --dry-run
  better release major --no-publish
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const pkgPath = path.join(projectRoot, "package.json");

  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch (err) {
    const msg = `Cannot read package.json: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const currentVersion = pkg.version || "0.0.0";
  const bumpType = positionals[0];
  const newVersion = bumpVersion(currentVersion, bumpType);

  if (!newVersion) {
    const msg = `Invalid version type: ${bumpType}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const steps = [
    { name: "test", skip: values["no-test"] || !pkg.scripts?.test, cmd: "npm", args: ["test"] },
    { name: "build", skip: values["no-build"] || !pkg.scripts?.build, cmd: "npm", args: ["run", "build"] },
    { name: "bump", skip: false, fn: async () => {
      if (!values["dry-run"]) {
        pkg.version = newVersion;
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
      }
    }},
    { name: "commit", skip: false, cmd: "git", args: ["commit", "-am", `chore: release v${newVersion}`] },
    { name: "tag", skip: values["no-tag"], cmd: "git", args: ["tag", `-a`, `v${newVersion}`, `-m`, `v${newVersion}`] },
    { name: "publish", skip: values["no-publish"], cmd: "npm", args: ["publish", `--access`, values.access] },
  ];

  const results = [];
  let failed = false;

  if (!values.json) {
    printText(`\n\x1b[1mbetter release\x1b[0m — ${currentVersion} → \x1b[1m\x1b[32m${newVersion}\x1b[0m`);
    if (values["dry-run"]) printText(`\x1b[33m(dry run — no changes will be made)\x1b[0m`);
    printText("");
  }

  for (const step of steps) {
    if (step.skip) {
      results.push({ step: step.name, status: "skipped" });
      if (!values.json) printText(`  \x1b[90m⊘\x1b[0m  ${step.name.padEnd(10)} \x1b[90mskipped\x1b[0m`);
      continue;
    }

    if (values["dry-run"]) {
      results.push({ step: step.name, status: "dry-run" });
      const cmdStr = step.fn ? "(update package.json)" : `${step.cmd} ${step.args.join(" ")}`;
      if (!values.json) printText(`  \x1b[33m~\x1b[0m  ${step.name.padEnd(10)} \x1b[33m${cmdStr}\x1b[0m`);
      continue;
    }

    if (step.fn) {
      try {
        await step.fn();
        results.push({ step: step.name, status: "ok" });
        if (!values.json) printText(`  \x1b[32m✔\x1b[0m  ${step.name.padEnd(10)}`);
      } catch (err) {
        results.push({ step: step.name, status: "failed", error: err.message });
        if (!values.json) printText(`  \x1b[31m✖\x1b[0m  ${step.name.padEnd(10)} \x1b[31m${err.message}\x1b[0m`);
        failed = true;
        break;
      }
    } else {
      const r = run(step.cmd, step.args, projectRoot, { silent: false });
      results.push({ step: step.name, status: r.ok ? "ok" : "failed", exit_code: r.status });
      if (!r.ok) {
        if (!values.json) printText(`  \x1b[31m✖\x1b[0m  ${step.name.padEnd(10)} \x1b[31mfailed (exit ${r.status})\x1b[0m`);
        failed = true;
        break;
      } else if (!values.json) {
        printText(`  \x1b[32m✔\x1b[0m  ${step.name.padEnd(10)}`);
      }
    }
  }

  if (values.json) {
    printJson({
      ok: !failed,
      kind: "better.release",
      from: currentVersion,
      to: newVersion,
      dry_run: values["dry-run"],
      steps: results,
    });
  } else {
    printText("");
    if (failed) {
      printText(`\x1b[31m✖ Release failed. Check the output above.\x1b[0m`);
      process.exitCode = 1;
    } else if (values["dry-run"]) {
      printText(`\x1b[33mDry run complete. Run without --dry-run to release.\x1b[0m`);
    } else {
      printText(`\x1b[32m✔ Released v${newVersion} successfully!\x1b[0m`);
    }
  }
}
