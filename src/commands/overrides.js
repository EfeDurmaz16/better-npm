/**
 * better overrides — manage package.json overrides/resolutions
 *
 * Helps manage npm overrides (or yarn resolutions) to fix
 * vulnerable or conflicting transitive dependencies.
 *
 * Usage:
 *   better overrides list
 *   better overrides add lodash@4.17.21
 *   better overrides remove lodash
 *   better overrides check
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fetchLatestVersion(name) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    https.get(`https://registry.npmjs.org/${encoded}/latest`, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)?.version || null); }
        catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

export async function cmdOverrides(argv) {
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
    printText(`Usage: better overrides <subcommand> [options]

Manage package.json overrides/resolutions for transitive dep conflicts.

Subcommands:
  list                  Show current overrides/resolutions
  add <pkg[@ver]>       Add an override (fetches latest if no version given)
  remove <pkg>          Remove an override
  check                 Validate overrides are still needed

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better overrides list
  better overrides add lodash@4.17.21
  better overrides add semver           # fetches latest
  better overrides remove lodash
  better overrides check
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

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

  const sub = positionals[0];

  // Helper: get overrides object (npm uses "overrides", yarn uses "resolutions")
  const nmPath = path.join(projectRoot, "node_modules");
  const pmLockExists = {
    npm:  await fs.access(path.join(projectRoot, "package-lock.json")).then(() => true).catch(() => false),
    yarn: await fs.access(path.join(projectRoot, "yarn.lock")).then(() => true).catch(() => false),
    pnpm: await fs.access(path.join(projectRoot, "pnpm-lock.yaml")).then(() => true).catch(() => false),
  };
  const usesYarn = pmLockExists.yarn && !pmLockExists.npm;
  const overrideField = usesYarn ? "resolutions" : "overrides";

  if (sub === "list") {
    const overrides = pkgJson[overrideField] || {};
    const count = Object.keys(overrides).length;

    if (values.json) {
      printJson({ ok: true, kind: "better.overrides.list", field: overrideField, count, overrides });
      return;
    }

    printText(`\n\x1b[1mbetter overrides list\x1b[0m — using "${overrideField}" field\n`);
    if (count === 0) {
      printText(`\x1b[90mNo overrides configured.\x1b[0m`);
      return;
    }
    for (const [pkg, ver] of Object.entries(overrides)) {
      printText(`  ${pkg.padEnd(30)} → ${typeof ver === "string" ? ver : JSON.stringify(ver)}`);
    }
    printText(`\n\x1b[90m${count} override(s) total\x1b[0m`);
    return;
  }

  if (sub === "add") {
    const pkgArg = positionals[1];
    if (!pkgArg) {
      printText(`\x1b[31mUsage: better overrides add <package[@version]>\x1b[0m`);
      process.exitCode = 1;
      return;
    }

    let pkgName, version;
    const atIdx = pkgArg.startsWith("@") ? pkgArg.lastIndexOf("@") : pkgArg.indexOf("@");
    if (atIdx > 0) {
      pkgName = pkgArg.slice(0, atIdx);
      version = pkgArg.slice(atIdx + 1);
    } else {
      pkgName = pkgArg;
      version = null;
    }

    if (!version) {
      if (!values.json) process.stderr.write(`\x1b[90mFetching latest version of ${pkgName}…\x1b[0m\n`);
      version = await fetchLatestVersion(pkgName);
      if (!version) {
        const msg = `Cannot find latest version for "${pkgName}"`;
        if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
        process.exitCode = 1;
        return;
      }
    }

    const updated = { ...pkgJson };
    if (!updated[overrideField]) updated[overrideField] = {};
    updated[overrideField][pkgName] = version;

    await fs.writeFile(pkgPath, JSON.stringify(updated, null, 2) + "\n", "utf8");

    if (values.json) {
      printJson({ ok: true, kind: "better.overrides.add", package: pkgName, version, field: overrideField });
    } else {
      printText(`\x1b[32m✔ Added override: ${pkgName} → ${version}\x1b[0m`);
      printText(`\x1b[90mRun: npm install (or yarn/pnpm install) to apply\x1b[0m`);
    }
    return;
  }

  if (sub === "remove") {
    const pkgName = positionals[1];
    if (!pkgName) {
      printText(`\x1b[31mUsage: better overrides remove <package>\x1b[0m`);
      process.exitCode = 1;
      return;
    }

    const overrides = pkgJson[overrideField] || {};
    if (!overrides[pkgName]) {
      const msg = `No override found for "${pkgName}"`;
      if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m${msg}\x1b[0m`); }
      return;
    }

    const updated = { ...pkgJson };
    delete updated[overrideField][pkgName];
    if (Object.keys(updated[overrideField]).length === 0) {
      delete updated[overrideField];
    }

    await fs.writeFile(pkgPath, JSON.stringify(updated, null, 2) + "\n", "utf8");

    if (values.json) {
      printJson({ ok: true, kind: "better.overrides.remove", package: pkgName });
    } else {
      printText(`\x1b[32m✔ Removed override for ${pkgName}\x1b[0m`);
    }
    return;
  }

  if (sub === "check") {
    const overrides = pkgJson[overrideField] || {};
    const count = Object.keys(overrides).length;

    if (count === 0) {
      if (values.json) {
        printJson({ ok: true, kind: "better.overrides.check", message: "No overrides configured" });
      } else {
        printText(`\x1b[90mNo overrides configured.\x1b[0m`);
      }
      return;
    }

    const results = [];
    for (const [pkgName, overrideVer] of Object.entries(overrides)) {
      let installedVer = null;
      try {
        const depPkg = JSON.parse(await fs.readFile(path.join(nmPath, pkgName, "package.json"), "utf8"));
        installedVer = depPkg.version;
      } catch {}

      const isActive = installedVer === overrideVer || installedVer === String(overrideVer).replace(/^[~^]/, "");
      results.push({ package: pkgName, override: overrideVer, installed: installedVer, active: isActive });
    }

    if (values.json) {
      printJson({ ok: true, kind: "better.overrides.check", overrides: results });
      return;
    }

    printText(`\n\x1b[1mbetter overrides check\x1b[0m — ${count} override(s)\n`);
    for (const r of results) {
      const icon = r.active ? "\x1b[32m✔\x1b[0m" : "\x1b[33m?\x1b[0m";
      const installed = r.installed ? ` (installed: ${r.installed})` : " (not installed)";
      printText(`  ${icon}  ${r.package.padEnd(30)} → ${r.override}${installed}`);
    }
    return;
  }

  printText(`\x1b[31mUnknown subcommand: ${sub}\x1b[0m`);
  printText(`Run: better overrides --help`);
  process.exitCode = 1;
}
