/**
 * better patch-package-check — audit patch-package patches
 *
 * Reviews patches in the patches/ directory (used by patch-package or
 * @yarnpkg/patch), verifies targeted packages exist, checks patch
 * applicability, and warns about stale patches after version upgrades.
 *
 * Usage:
 *   better patch-package-check
 *   better patch-package-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parsePatchFilename(filename) {
  // patch-package format: package-name+1.2.3.patch or @scope+pkg+1.2.3.patch
  const base = filename.replace(/\.patch$/, "");
  const parts = base.split("+");
  if (parts.length < 2) return null;
  const version = parts[parts.length - 1];
  const pkgName = parts.slice(0, -1).join("/").replace(/^@/, "@").replace(/\+/, "/");
  return { pkgName: parts.length === 3 ? `@${parts[0]}/${parts[1]}` : parts[0], version };
}

function parsePatchStats(content) {
  const lines = content.split("\n");
  let additions = 0;
  let deletions = 0;
  let files = new Set();
  for (const line of lines) {
    if (line.startsWith("+++") && !line.startsWith("+++ /dev/null")) {
      const m = line.match(/^\+\+\+ b\/(.+)/);
      if (m) files.add(m[1]);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }
  return { additions, deletions, files: [...files] };
}

export async function cmdPatchPackageCheck(argv) {
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
    printText(`Usage: better patch-package-check [options]

Audit patch-package patches in your project.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Patch files in patches/ directory
  • Target package existence in node_modules
  • Version match between patch and installed version
  • Patch size and affected files
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const patchesDir = path.join(projectRoot, "patches");

  if (!values.json) {
    printText(`\n\x1b[1mbetter patch-package-check\x1b[0m\n`);
  }

  let patchFiles = [];
  try {
    const entries = await fs.readdir(patchesDir);
    patchFiles = entries.filter(f => f.endsWith(".patch"));
  } catch {
    if (values.json) { printJson({ ok: true, kind: "better.patch-package-check", count: 0, patches: [] }); return; }
    printText(`  \x1b[90mNo patches/ directory found.\x1b[0m`);
    printText("");
    return;
  }

  if (patchFiles.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.patch-package-check", count: 0, patches: [] }); return; }
    printText(`  \x1b[90mNo .patch files found in patches/.\x1b[0m`);
    printText("");
    return;
  }

  const nmPath = path.join(projectRoot, "node_modules");
  const patches = [];

  for (const filename of patchFiles) {
    const parsed = parsePatchFilename(filename);
    if (!parsed) {
      patches.push({ filename, ok: false, issue: "Cannot parse patch filename" });
      continue;
    }

    const { pkgName, version: patchedVersion } = parsed;

    // Check if package is installed
    let installedVersion = null;
    let packageExists = false;
    try {
      const pkgPath = path.join(nmPath, pkgName, "package.json");
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      installedVersion = pkg.version;
      packageExists = true;
    } catch {}

    // Read patch content
    let stats = null;
    try {
      const content = await fs.readFile(path.join(patchesDir, filename), "utf8");
      stats = parsePatchStats(content);
    } catch {}

    const versionMatch = packageExists && installedVersion === patchedVersion;
    const issue = !packageExists
      ? "Package not installed"
      : !versionMatch
        ? `Version mismatch: patched ${patchedVersion}, installed ${installedVersion}`
        : null;

    patches.push({
      filename,
      pkgName,
      patchedVersion,
      installedVersion,
      packageExists,
      versionMatch,
      issue,
      ok: packageExists && versionMatch,
      stats,
    });
  }

  const ok = patches.every(p => p.ok);

  if (values.json) {
    printJson({ ok, kind: "better.patch-package-check", count: patches.length, patches });
    if (!ok) process.exitCode = 1;
    return;
  }

  printText(`  Patches: ${patches.length}  |  OK: ${patches.filter(p => p.ok).length}  |  Issues: ${patches.filter(p => !p.ok).length}\n`);

  for (const p of patches) {
    const icon = p.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    const statsStr = p.stats ? `  \x1b[90m+${p.stats.additions}/-${p.stats.deletions} in ${p.stats.files.length} file(s)\x1b[0m` : "";
    printText(`  ${icon}  \x1b[1m${p.pkgName || p.filename}\x1b[0m@${p.patchedVersion || "?"}${statsStr}`);
    if (p.issue) {
      printText(`       \x1b[33m${p.issue}\x1b[0m`);
    }
    if (p.stats && p.stats.files.length > 0) {
      for (const f of p.stats.files.slice(0, 3)) {
        printText(`       \x1b[90m${f}\x1b[0m`);
      }
      if (p.stats.files.length > 3) {
        printText(`       \x1b[90m... and ${p.stats.files.length - 3} more\x1b[0m`);
      }
    }
  }

  if (!ok) {
    printText(`\n\x1b[33m⚠ Some patches may not apply correctly. Update them after upgrading packages.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
