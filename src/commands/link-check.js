/**
 * better link-check — verify npm linked packages
 *
 * Lists all npm-linked packages in the project and verifies
 * their link targets still exist and are valid.
 *
 * Usage:
 *   better link-check
 *   better link-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdLinkCheck(argv) {
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
    printText(`Usage: better link-check [options]

Find and verify npm-linked packages in node_modules.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Symlinks in node_modules that point to local packages
  • Link target directories exist
  • Linked package has a package.json
  • Linked package name matches the symlink name
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  try { await fs.access(nmPath); } catch {
    const msg = "node_modules not found";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter link-check\x1b[0m\n`);
  }

  const links = [];

  async function scanForLinks(dir, prefix = "") {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      const pkgName = prefix ? `${prefix}/${e.name}` : e.name;

      if (e.isSymbolicLink()) {
        let linkTarget = null;
        let resolvedTarget = null;
        let targetExists = false;
        let hasPkgJson = false;
        let nameMatch = true;
        let targetPkgName = null;

        try {
          linkTarget = await fs.readlink(full);
          resolvedTarget = path.resolve(path.dirname(full), linkTarget);
          await fs.access(resolvedTarget);
          targetExists = true;
          try {
            const pkg = JSON.parse(await fs.readFile(path.join(resolvedTarget, "package.json"), "utf8"));
            hasPkgJson = true;
            targetPkgName = pkg.name;
            nameMatch = pkg.name === pkgName;
          } catch {}
        } catch {}

        links.push({
          name: pkgName,
          linkTarget,
          resolvedTarget,
          targetExists,
          hasPkgJson,
          nameMatch,
          targetPkgName,
          valid: targetExists && hasPkgJson && nameMatch,
        });
      } else if (e.isDirectory() && e.name.startsWith("@")) {
        await scanForLinks(full, e.name);
      }
    }
  }

  await scanForLinks(nmPath);

  if (links.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.link-check", links: [] }); return; }
    printText(`  \x1b[90mNo linked packages found.\x1b[0m\n`);
    return;
  }

  const broken = links.filter(l => !l.valid);
  const allOk = broken.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.link-check",
      total: links.length,
      valid: links.filter(l => l.valid).length,
      broken: broken.length,
      links,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`  Found ${links.length} linked package(s)\n`);

  for (const link of links) {
    const icon = link.valid ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    const target = link.resolvedTarget || link.linkTarget || "?";
    const rel = path.relative(projectRoot, target);
    printText(`  ${icon}  \x1b[1m${link.name}\x1b[0m  \x1b[90m→ ${rel}\x1b[0m`);
    if (!link.targetExists) {
      printText(`       \x1b[31mLink target does not exist: ${target}\x1b[0m`);
    } else if (!link.hasPkgJson) {
      printText(`       \x1b[31mNo package.json at link target\x1b[0m`);
    } else if (!link.nameMatch) {
      printText(`       \x1b[33mName mismatch: package.json says "${link.targetPkgName}"\x1b[0m`);
    }
  }

  printText("");
  if (allOk) {
    printText(`\x1b[32m✔ All ${links.length} link(s) are valid.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${broken.length} broken link(s) found.\x1b[0m`);
    printText(`\x1b[90m  Run: npm unlink <package> && npm link <path> to fix\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
