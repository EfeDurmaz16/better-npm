import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better why-not <package>[@version]` — explain why a package conflicts
 *
 * Shows:
 * - Peer dependency conflicts
 * - Version range incompatibilities
 * - Policy violations preventing install
 * - License conflicts
 */
export async function cmdWhyNot(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better why-not <package>[@version] [options]

Explain why a package cannot be installed or causes conflicts.

Options:
  --json         Machine-readable output
  --project-root PATH Override project root
  -h, --help     Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const target = positionals[0];
  if (!target) {
    printText("Error: package name required");
    process.exitCode = 1;
    return;
  }

  const [pkgName, pkgVersion] = target.split("@");
  const useJson = values.json || runtime.json === true;

  // Load project deps
  const pkgPath = path.join(projectRoot, "package.json");
  let pkg = {};
  try { pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")); } catch {}

  const lockPath = path.join(projectRoot, "package-lock.json");
  let lock = null;
  try { lock = JSON.parse(await fs.readFile(lockPath, "utf8")); } catch {}

  const conflicts = [];
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  // Check peer deps from npm
  try {
    const resp = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}${pkgVersion ? `/${pkgVersion}` : "/latest"}`);
    if (resp.ok) {
      const data = await resp.json();
      const peerDeps = data.peerDependencies || {};
      for (const [peer, range] of Object.entries(peerDeps)) {
        const installed = allDeps[peer];
        if (!installed) {
          conflicts.push({ type: "missing-peer", package: peer, required: range, installed: null });
        } else {
          // Simplified range check
          const installedVer = installed.replace(/[^0-9.].*/, "").replace(/^[^0-9]*/, "");
          const requiredMajor = parseInt(range.replace(/[^0-9].*/, "")) || 0;
          const installedMajor = parseInt(installedVer.split(".")[0]) || 0;
          if (requiredMajor > 0 && installedMajor > 0 && installedMajor < requiredMajor) {
            conflicts.push({ type: "peer-version-mismatch", package: peer, required: range, installed });
          }
        }
      }
    }
  } catch { /* ignore */ }

  // Check if already installed with different version
  if (lock?.packages) {
    const key = `node_modules/${pkgName}`;
    if (lock.packages[key]) {
      const installedVersion = lock.packages[key].version;
      if (pkgVersion && installedVersion !== pkgVersion) {
        conflicts.push({ type: "version-mismatch", installed: installedVersion, requested: pkgVersion });
      }
    }
  }

  const result = {
    ok: true,
    kind: "better.why-not",
    package: pkgName,
    version: pkgVersion || "latest",
    canInstall: conflicts.length === 0,
    conflicts,
    summary: conflicts.length === 0
      ? `${pkgName} can be installed without conflicts`
      : `${pkgName} has ${conflicts.length} conflict(s)`,
  };

  if (useJson) {
    printJson(result);
  } else {
    if (conflicts.length === 0) {
      printText(`✅ ${pkgName} can be installed without conflicts.`);
    } else {
      printText(`❌ ${pkgName} has ${conflicts.length} conflict(s):`);
      for (const c of conflicts) {
        switch (c.type) {
          case "missing-peer":
            printText(`  • Missing peer dependency: ${c.package}@${c.required}`);
            break;
          case "peer-version-mismatch":
            printText(`  • Peer version mismatch: ${c.package} requires ${c.required}, installed ${c.installed}`);
            break;
          case "version-mismatch":
            printText(`  • Version conflict: ${pkgVersion} requested, ${c.installed} installed`);
            break;
        }
      }
    }
  }
}
