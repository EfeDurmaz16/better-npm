/**
 * better pkg-publish-info — pre-publish information and dry run
 *
 * Shows what would be published: file list, sizes, registry info,
 * and validates the package is ready for publishing.
 *
 * Usage:
 *   better pkg-publish-info
 *   better pkg-publish-info --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(n) {
  if (!n) return "—";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export async function cmdPkgPublishInfo(argv) {
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
    printText(`Usage: better pkg-publish-info [options]

Show what would be published and validate publish readiness.

Options:
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mRunning npm pack --dry-run…\x1b[0m\n`);
  }

  const packResult = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let packData = null;
  try { packData = JSON.parse(packResult.stdout)?.[0]; } catch {}

  // Get registry
  const registryResult = spawnSync("npm", ["config", "get", "registry"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const registry = registryResult.stdout?.trim() || "https://registry.npmjs.org/";

  // Check whoami
  const whoamiResult = spawnSync("npm", ["whoami"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const loggedInAs = whoamiResult.status === 0 ? whoamiResult.stdout?.trim() : null;

  const issues = [];
  if (!pkgJson.name) issues.push({ severity: "error", message: "Missing package name" });
  if (!pkgJson.version) issues.push({ severity: "error", message: "Missing version" });
  if (!pkgJson.description) issues.push({ severity: "warning", message: "Missing description" });
  if (!pkgJson.license) issues.push({ severity: "warning", message: "Missing license" });
  if (!loggedInAs) issues.push({ severity: "warning", message: `Not logged in to ${registry}` });
  if (pkgJson.private) issues.push({ severity: "error", message: 'Package is marked "private" — cannot publish' });

  const files = packData?.files || [];
  const unpackedSize = packData?.unpackedSize || null;
  const packedSize = packData?.size || null;

  if (values.json) {
    printJson({
      ok: issues.filter(i => i.severity === "error").length === 0,
      kind: "better.pkg-publish-info",
      name: pkgJson.name,
      version: pkgJson.version,
      registry,
      loggedInAs,
      unpackedSize,
      packedSize,
      fileCount: files.length,
      files,
      issues,
    });
    return;
  }

  printText(`\n\x1b[1mbetter pkg-publish-info\x1b[0m\n`);
  printText(`  Package:  \x1b[1m${pkgJson.name || "—"}\x1b[0m@${pkgJson.version || "—"}`);
  printText(`  Registry: ${registry}`);
  printText(`  Login:    ${loggedInAs ? `\x1b[32m${loggedInAs}\x1b[0m` : "\x1b[33mnot logged in\x1b[0m"}`);

  if (unpackedSize) {
    printText(`  Size:     ${fmtBytes(packedSize)} packed, ${fmtBytes(unpackedSize)} unpacked`);
    printText(`  Files:    ${files.length}`);
  }

  if (issues.length > 0) {
    printText("");
    for (const issue of issues) {
      const icon = issue.severity === "error" ? "\x1b[31m✖\x1b[0m" : "\x1b[33m⚠\x1b[0m";
      printText(`  ${icon}  ${issue.message}`);
    }
  }

  if (files.length > 0) {
    printText(`\n\x1b[90mFiles to publish:\x1b[0m`);
    const shown = files.slice(0, 20);
    for (const f of shown) {
      const sizeStr = f.size ? ` \x1b[90m${fmtBytes(f.size)}\x1b[0m` : "";
      printText(`  \x1b[90m${f.path}${sizeStr}\x1b[0m`);
    }
    if (files.length > 20) printText(`  \x1b[90m... and ${files.length - 20} more\x1b[0m`);
  }

  const errors = issues.filter(i => i.severity === "error");
  printText("");
  if (errors.length > 0) {
    printText(`\x1b[31m✖ ${errors.length} issue(s) must be fixed before publishing.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\x1b[32m✔ Ready to publish.\x1b[0m  Run: npm publish`);
  }
  printText("");
}
