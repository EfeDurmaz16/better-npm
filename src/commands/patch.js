/**
 * better patch — apply or create npm package patches
 *
 * Provides patch-package-like functionality: create patches from
 * modifications to node_modules, and apply stored patches on
 * postinstall.
 *
 * Usage:
 *   better patch create lodash
 *   better patch apply
 *   better patch list
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const PATCHES_DIR = "patches";

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function cmdPatch(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printText(`Usage: better patch <subcommand> [options]

Create and apply patches to node_modules packages.

Subcommands:
  create <pkg>  Create a patch from current node_modules modifications
  apply         Apply all patches in ./patches/ directory
  list          List available patches

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better patch create lodash
  better patch apply
  better patch list
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const patchesDir = path.join(projectRoot, PATCHES_DIR);
  const nmPath = path.join(projectRoot, "node_modules");

  const sub = positionals[0];

  if (sub === "list") {
    let patches = [];
    try {
      const entries = await fs.readdir(patchesDir);
      patches = entries.filter(e => e.endsWith(".patch"));
    } catch {}

    if (values.json) {
      printJson({ ok: true, kind: "better.patch.list", patches });
      return;
    }

    printText(`\n\x1b[1mbetter patch list\x1b[0m — ${patches.length} patch(es) in ./patches/\n`);
    if (patches.length === 0) {
      printText(`\x1b[90mNo patches found. Create one with: better patch create <package>\x1b[0m`);
      return;
    }
    for (const p of patches) {
      const stat = await fs.stat(path.join(patchesDir, p)).catch(() => null);
      const size = stat ? `${Math.ceil(stat.size / 1024)}KB` : "?";
      printText(`  ${p}  \x1b[90m(${size})\x1b[0m`);
    }
    return;
  }

  if (sub === "create") {
    const pkgArg = positionals[1];
    if (!pkgArg) {
      printText(`\x1b[31mUsage: better patch create <package[@version]>\x1b[0m`);
      process.exitCode = 1;
      return;
    }

    // Get package version from node_modules
    let pkgName = pkgArg;
    let version = null;

    const atIdx = pkgArg.startsWith("@") ? pkgArg.lastIndexOf("@") : pkgArg.indexOf("@");
    if (atIdx > 0) {
      pkgName = pkgArg.slice(0, atIdx);
    }

    try {
      const depPkg = JSON.parse(await fs.readFile(path.join(nmPath, pkgName, "package.json"), "utf8"));
      version = depPkg.version;
    } catch {
      printText(`\x1b[31m"${pkgName}" is not installed in node_modules\x1b[0m`);
      process.exitCode = 1;
      return;
    }

    // Create patches directory if it doesn't exist
    await fs.mkdir(patchesDir, { recursive: true });

    const patchName = `${pkgName.replace("/", "+")}+${version}.patch`;
    const patchPath = path.join(patchesDir, patchName);

    // Use git diff to create the patch
    const pkgDir = path.join(nmPath, pkgName);
    const result = spawnSync("git", [
      "diff", "--no-index", "--diff-filter=M",
      `node_modules/${pkgName}`,
      `node_modules/${pkgName}`,
    ], { cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

    // git diff --no-index always exits 1 when there are differences
    // We use git diff on the working tree instead
    const diffResult = spawnSync("git", [
      "diff", "--", `node_modules/${pkgName}`,
    ], { cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

    const patchContent = diffResult.stdout;
    if (!patchContent || patchContent.trim() === "") {
      if (values.json) {
        printJson({ ok: false, kind: "better.patch.create", error: "No changes found in node_modules for this package" });
      } else {
        printText(`\x1b[33m⚠ No changes found in node_modules/${pkgName}\x1b[0m`);
        printText(`\x1b[90mModify files in node_modules/${pkgName} first, then run better patch create ${pkgName}\x1b[0m`);
      }
      return;
    }

    await fs.writeFile(patchPath, patchContent, "utf8");

    if (values.json) {
      printJson({ ok: true, kind: "better.patch.create", package: pkgName, version, patchFile: patchName });
    } else {
      printText(`\x1b[32m✔ Created patch: patches/${patchName}\x1b[0m`);
      printText(`\x1b[90mAdd to postinstall: "postinstall": "better patch apply"\x1b[0m`);
    }
    return;
  }

  if (sub === "apply") {
    let patches = [];
    try {
      const entries = await fs.readdir(patchesDir);
      patches = entries.filter(e => e.endsWith(".patch"));
    } catch {}

    if (patches.length === 0) {
      if (values.json) {
        printJson({ ok: true, kind: "better.patch.apply", applied: 0, message: "No patches to apply" });
      } else {
        printText(`\x1b[90mNo patches found in ./patches/\x1b[0m`);
      }
      return;
    }

    const results = [];
    for (const patchFile of patches) {
      const patchPath = path.join(patchesDir, patchFile);
      const result = spawnSync("patch", ["-p0", "--forward", "-i", patchPath], {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const success = result.status === 0;
      results.push({ patch: patchFile, success, output: result.stdout?.slice(0, 200) });
    }

    const failed = results.filter(r => !r.success);

    if (values.json) {
      printJson({
        ok: failed.length === 0,
        kind: "better.patch.apply",
        applied: results.filter(r => r.success).length,
        failed: failed.length,
        results,
      });
      if (failed.length > 0) process.exitCode = 1;
      return;
    }

    printText(`\n\x1b[1mbetter patch apply\x1b[0m — ${patches.length} patch(es)\n`);
    for (const r of results) {
      const icon = r.success ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
      printText(`  ${icon}  ${r.patch}`);
    }
    if (failed.length > 0) {
      printText(`\n\x1b[31m✖ ${failed.length} patch(es) failed to apply.\x1b[0m`);
      process.exitCode = 1;
    } else {
      printText(`\n\x1b[32m✔ All patches applied.\x1b[0m`);
    }
    return;
  }

  printText(`\x1b[31mUnknown subcommand: ${sub}\x1b[0m`);
  printText(`Run: better patch --help`);
  process.exitCode = 1;
}
