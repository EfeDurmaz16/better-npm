/**
 * better bin-check — validate bin entries in package.json
 *
 * Checks that all binary scripts declared in the "bin" field of package.json
 * exist on disk and have executable permissions.
 *
 * Usage:
 *   better bin-check
 *   better bin-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdBinCheck(argv) {
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
    printText(`Usage: better bin-check [options]

Validate bin entries in package.json.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • All bin paths in package.json exist on disk
  • Bin files have executable permissions (Unix)
  • Shebang line present in bin files
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter bin-check\x1b[0m\n`);
  }

  let pkgJson = {};
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const { bin } = pkgJson;
  if (!bin) {
    if (values.json) {
      printJson({ ok: true, kind: "better.bin-check", bins: [] });
    } else {
      printText(`  \x1b[90mNo bin field found in package.json.\x1b[0m\n`);
    }
    return;
  }

  const binEntries = typeof bin === "string"
    ? { [pkgJson.name || "bin"]: bin }
    : bin;

  const results = [];
  for (const [name, filePath] of Object.entries(binEntries)) {
    const fullPath = path.join(projectRoot, filePath);
    let exists = false;
    let executable = false;
    let hasShebang = false;
    let issue = null;

    try {
      const stat = await fs.stat(fullPath);
      exists = true;
      // Check executable bit (mode & 0o111)
      executable = !!(stat.mode & 0o111);
      if (!executable) issue = "not executable (missing +x permission)";
    } catch {
      issue = "file not found";
    }

    if (exists) {
      try {
        const content = await fs.readFile(fullPath, "utf8");
        hasShebang = content.startsWith("#!");
        if (!hasShebang && !issue) issue = "missing shebang line";
      } catch {}
    }

    results.push({
      name,
      path: filePath,
      exists,
      executable,
      hasShebang,
      ok: exists && executable && hasShebang,
      issue,
    });
  }

  const ok = results.every(r => r.ok);

  if (values.json) {
    printJson({ ok, kind: "better.bin-check", package: pkgJson.name, bins: results });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const r of results) {
    const icon = r.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    printText(`  ${icon}  \x1b[1m${r.name}\x1b[0m  →  ${r.path}`);
    if (r.issue) {
      printText(`       \x1b[31m${r.issue}\x1b[0m`);
    }
  }

  printText("");
  if (!ok) {
    const issues = results.filter(r => !r.ok);
    printText(`\x1b[31m✘ ${issues.length} bin entry issue(s) found.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\x1b[32m✔ All ${results.length} bin entries are valid.\x1b[0m`);
  }
  printText("");
}
