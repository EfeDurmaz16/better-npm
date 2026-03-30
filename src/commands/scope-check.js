/**
 * better scope-check — validate scoped package configuration
 *
 * Checks that scoped packages (@org/pkg) have the correct registry
 * configured, auth tokens are present where needed, and scope
 * configuration in .npmrc is valid.
 *
 * Usage:
 *   better scope-check
 *   better scope-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function parseNpmrc(content) {
  const lines = content.split("\n");
  const config = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    config[key] = value;
  }
  return config;
}

export async function cmdScopeCheck(argv) {
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
    printText(`Usage: better scope-check [options]

Validate scoped package (@org/pkg) configuration.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Scopes used in dependencies
  • Registry configuration per scope in .npmrc
  • Auth token presence for private registries
  • Scope config in project vs global .npmrc
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter scope-check\x1b[0m\n`);
  }

  // Read package.json
  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const allDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
    ...pkgJson.peerDependencies,
    ...pkgJson.optionalDependencies,
  };

  // Extract unique scopes
  const scopes = new Set();
  for (const dep of Object.keys(allDeps)) {
    if (dep.startsWith("@")) {
      const scope = dep.split("/")[0]; // e.g. @myorg
      scopes.add(scope);
    }
  }

  if (scopes.size === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.scope-check", scopes: [], count: 0 }); return; }
    printText(`  \x1b[90mNo scoped packages found in dependencies.\x1b[0m\n`);
    return;
  }

  // Read .npmrc files
  const npmrcPaths = [
    path.join(projectRoot, ".npmrc"),
    path.join(os.homedir(), ".npmrc"),
  ];
  let mergedConfig = {};
  const npmrcSources = [];
  for (const npmrcPath of npmrcPaths) {
    try {
      const content = await fs.readFile(npmrcPath, "utf8");
      const parsed = parseNpmrc(content);
      mergedConfig = { ...mergedConfig, ...parsed };
      npmrcSources.push(npmrcPath);
    } catch {}
  }

  const results = [];
  for (const scope of [...scopes].sort()) {
    const scopeKey = `${scope}:registry`;
    const registry = mergedConfig[scopeKey] || null;

    let hasAuth = false;
    if (registry) {
      // Check for auth token for this registry
      const host = new URL(registry.startsWith("http") ? registry : `https:${registry}`).host;
      const authKey = `//${host}/:_authToken`;
      hasAuth = !!mergedConfig[authKey];
    }

    const isPublic = !registry || registry.includes("registry.npmjs.org") || registry.includes("npmjs.com");
    const needsAuth = !isPublic;
    const issue = needsAuth && !hasAuth
      ? `No auth token found for ${registry}`
      : !registry && scope !== "@types"
        ? `No registry configured for scope ${scope}`
        : null;

    results.push({
      scope,
      registry: registry || "https://registry.npmjs.org/ (default)",
      hasAuth,
      isPublic,
      needsAuth,
      issue,
      ok: !issue,
    });
  }

  const ok = results.every(r => r.ok);

  if (values.json) {
    printJson({ ok, kind: "better.scope-check", count: results.length, scopes: results });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const r of results) {
    const icon = r.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    const authStr = r.needsAuth ? (r.hasAuth ? "  \x1b[32m[auth ✔]\x1b[0m" : "  \x1b[31m[no auth]\x1b[0m") : "";
    printText(`  ${icon}  \x1b[1m${r.scope}\x1b[0m  \x1b[90m→ ${r.registry}\x1b[0m${authStr}`);
    if (r.issue) printText(`       \x1b[33m${r.issue}\x1b[0m`);
  }

  if (!ok) {
    printText(`\n\x1b[33m⚠ Some scopes may fail to install. Configure registry/auth in .npmrc.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
