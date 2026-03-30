/**
 * better monorepo-version-sync — check cross-package version consistency
 *
 * In monorepos, checks that internal package references use consistent
 * versions, identifies mismatched peer deps, and flags packages that
 * need version updates.
 *
 * Usage:
 *   better monorepo-version-sync
 *   better monorepo-version-sync --fix
 *   better monorepo-version-sync --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function findWorkspacePackages(projectRoot, workspaceGlobs) {
  const packages = [];
  for (const glob of workspaceGlobs) {
    // Handle simple patterns like "packages/*" or "apps/*"
    const parts = glob.split("/");
    const baseDir = parts.slice(0, -1).join("/");
    const pattern = parts[parts.length - 1];
    const absBase = path.join(projectRoot, baseDir);
    try {
      const entries = await fs.readdir(absBase, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (pattern !== "*" && e.name !== pattern) continue;
        const pkgPath = path.join(absBase, e.name, "package.json");
        try {
          const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
          if (pkg.name) packages.push({ name: pkg.name, version: pkg.version, path: path.join(absBase, e.name), pkg });
        } catch {}
      }
    } catch {}
  }
  return packages;
}

export async function cmdMonorepoVersionSync(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      fix:   { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better monorepo-version-sync [options]

Check cross-package version consistency in monorepos.

Options:
  --fix        Auto-update mismatched internal references
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Internal package references match published versions
  • Consistent dependency versions across workspace packages
  • Missing workspace: protocol where applicable
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter monorepo-version-sync\x1b[0m\n`);
  }

  let rootPkg = {};
  try { rootPkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const workspaces = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : Array.isArray(rootPkg.workspaces?.packages)
      ? rootPkg.workspaces.packages
      : [];

  if (workspaces.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.monorepo-version-sync", count: 0, issues: [] }); return; }
    printText(`  \x1b[90mNo workspaces found. This command is for monorepos.\x1b[0m\n`);
    return;
  }

  const workspacePkgs = await findWorkspacePackages(projectRoot, workspaces);

  if (workspacePkgs.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.monorepo-version-sync", count: 0, issues: [] }); return; }
    printText(`  \x1b[90mNo workspace packages found.\x1b[0m\n`);
    return;
  }

  // Build name → version map
  const pkgVersions = new Map(workspacePkgs.map(p => [p.name, p.version]));

  // Check cross-references
  const issues = [];
  const fixes = [];

  for (const wp of workspacePkgs) {
    const allDeps = {
      ...wp.pkg.dependencies,
      ...wp.pkg.devDependencies,
      ...wp.pkg.peerDependencies,
    };
    for (const [dep, range] of Object.entries(allDeps)) {
      if (!pkgVersions.has(dep)) continue;
      const actualVersion = pkgVersions.get(dep);
      if (!actualVersion) continue;

      const isWorkspaceProtocol = String(range).startsWith("workspace:");
      const rangeVersion = String(range).replace(/^[~^*>=<workspace:]+/, "");

      if (!isWorkspaceProtocol && rangeVersion !== actualVersion && rangeVersion !== "*" && rangeVersion !== "") {
        const issue = {
          package: wp.name,
          dep,
          currentRange: range,
          actualVersion,
          type: "version-mismatch",
        };
        issues.push(issue);

        if (values.fix) {
          // Fix: update to workspace:* protocol
          const depType = wp.pkg.dependencies?.[dep] ? "dependencies"
            : wp.pkg.devDependencies?.[dep] ? "devDependencies"
            : "peerDependencies";
          wp.pkg[depType][dep] = `workspace:*`;
          fixes.push({ ...issue, fixedRange: "workspace:*" });
        }
      }
    }
  }

  if (values.fix && fixes.length > 0) {
    for (const wp of workspacePkgs) {
      if (fixes.some(f => f.package === wp.name)) {
        await fs.writeFile(path.join(wp.path, "package.json"), JSON.stringify(wp.pkg, null, 2) + "\n", "utf8");
      }
    }
  }

  const ok = issues.length === 0;

  if (values.json) {
    printJson({ ok, kind: "better.monorepo-version-sync", packages: workspacePkgs.length, issues: issues.length, details: issues, fixes });
    if (!ok) process.exitCode = 1;
    return;
  }

  printText(`  Workspace packages: ${workspacePkgs.length}\n`);

  if (ok) {
    printText(`\x1b[32m✔ All internal version references are consistent.\x1b[0m`);
  } else {
    printText(`\x1b[33m⚠ ${issues.length} version inconsistenc${issues.length === 1 ? "y" : "ies"} found:\x1b[0m\n`);
    for (const issue of issues) {
      printText(`  \x1b[33m·\x1b[0m  \x1b[1m${issue.package}\x1b[0m depends on \x1b[1m${issue.dep}\x1b[0m@${issue.currentRange}`);
      printText(`       \x1b[90mActual version in workspace: ${issue.actualVersion}\x1b[0m`);
    }
    if (!values.fix) {
      printText(`\n  Run with \x1b[36m--fix\x1b[0m to update references to \`workspace:*\` protocol.`);
    } else {
      printText(`\n  \x1b[32m✔ Fixed ${fixes.length} reference(s).\x1b[0m`);
    }
    if (!values.fix) process.exitCode = 1;
  }
  printText("");
}
