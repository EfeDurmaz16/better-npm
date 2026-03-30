/**
 * better namespace — manage package scopes and namespaces
 *
 * Shows all installed scoped packages, checks if your package
 * follows namespace conventions, and helps with scope management.
 *
 * Usage:
 *   better namespace
 *   better namespace --scope @myorg
 *   better namespace --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdNamespace(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      scope: { type: "string" },
      all:   { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better namespace [options]

Analyze package scopes and namespaces in your project.

Options:
  --scope <@org>   Filter to a specific scope
  --all            Include all transitive deps
  --json           Machine-readable output
  -h, --help       Show this help
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

  const allDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
    ...(values.all ? {} : {}),
  };

  const nmPath = path.join(projectRoot, "node_modules");

  // If --all, scan node_modules for scoped packages
  let scopedPkgs;
  if (values.all) {
    const scopeDirs = [];
    try {
      const entries = await fs.readdir(nmPath, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.startsWith("@")) {
          const scopePath = path.join(nmPath, e.name);
          const subEntries = await fs.readdir(scopePath, { withFileTypes: true }).catch(() => []);
          for (const se of subEntries) {
            if (se.isDirectory()) {
              const fullName = `${e.name}/${se.name}`;
              let version = "?";
              try {
                const p = JSON.parse(await fs.readFile(path.join(scopePath, se.name, "package.json"), "utf8"));
                version = p.version || "?";
              } catch {}
              scopeDirs.push({ name: fullName, scope: e.name, version, source: "transitive" });
            }
          }
        }
      }
    } catch {}
    scopedPkgs = scopeDirs;
  } else {
    scopedPkgs = Object.keys(allDeps)
      .filter(name => name.startsWith("@"))
      .map(name => {
        const scope = name.split("/")[0];
        let version = allDeps[name];
        let installedVersion = version;
        return { name, scope, version, source: "direct" };
      });
  }

  // Filter by scope if requested
  if (values.scope) {
    const filterScope = values.scope.startsWith("@") ? values.scope : `@${values.scope}`;
    scopedPkgs = scopedPkgs.filter(p => p.scope === filterScope);
  }

  // Group by scope
  const byScope = {};
  for (const pkg of scopedPkgs) {
    if (!byScope[pkg.scope]) byScope[pkg.scope] = [];
    byScope[pkg.scope].push(pkg);
  }

  const totalScopes = Object.keys(byScope).length;
  const totalPkgs = scopedPkgs.length;

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.namespace",
      totalScopes,
      totalPackages: totalPkgs,
      scopes: Object.fromEntries(
        Object.entries(byScope).map(([scope, pkgs]) => [scope, pkgs.map(p => ({
          name: p.name, version: p.version, source: p.source,
        }))])
      ),
    });
    return;
  }

  printText(`\n\x1b[1mbetter namespace\x1b[0m — ${totalPkgs} scoped package(s) across ${totalScopes} scope(s)\n`);

  if (totalPkgs === 0) {
    printText(`\x1b[90mNo scoped packages found.\x1b[0m`);
    return;
  }

  for (const [scope, pkgs] of Object.entries(byScope).sort()) {
    printText(`\x1b[1m${scope}\x1b[0m \x1b[90m(${pkgs.length} package${pkgs.length !== 1 ? "s" : ""})\x1b[0m`);
    for (const pkg of pkgs) {
      const shortName = pkg.name.slice(scope.length + 1);
      const ver = pkg.version !== "?" ? `\x1b[90m@${pkg.version}\x1b[0m` : "";
      printText(`  ${shortName}${ver}`);
    }
    printText("");
  }

  // Project scope info
  if (pkgJson.name?.startsWith("@")) {
    const ownScope = pkgJson.name.split("/")[0];
    printText(`\x1b[90mThis package's scope: ${ownScope}\x1b[0m`);
  }
}
