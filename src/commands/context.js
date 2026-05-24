/**
 * better context — generate LLM-friendly context for a package
 *
 * Outputs structured context about a package (or the current project) that
 * can be fed directly to an LLM or used by AI-powered tooling.
 */
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore, tryLoadNapiAddon } from "../lib/core.js";
import { runCommand } from "../lib/spawn.js";

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

async function readFileSafe(p) {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

async function buildProjectContext(projectRoot) {
  const pkg = await readJsonSafe(path.join(projectRoot, "package.json"));
  const lockPkg = await readJsonSafe(path.join(projectRoot, "package-lock.json"));
  const readme = await readFileSafe(path.join(projectRoot, "README.md"))
    ?? await readFileSafe(path.join(projectRoot, "readme.md"));

  const deps = Object.keys(pkg?.dependencies ?? {});
  const devDeps = Object.keys(pkg?.devDependencies ?? {});
  const peerDeps = Object.keys(pkg?.peerDependencies ?? {});

  const installedPackages = lockPkg
    ? Object.entries(lockPkg.packages ?? {})
        .filter(([k]) => k && k !== "")
        .map(([k, v]) => ({
          name: k.replace(/^node_modules\//, ""),
          version: v.version ?? "0.0.0",
          dev: v.dev === true
        }))
        .filter(p => !p.name.includes("/node_modules/"))
    : null;

  return {
    kind: "project",
    name: pkg?.name ?? path.basename(projectRoot),
    version: pkg?.version ?? "0.0.0",
    description: pkg?.description ?? null,
    license: pkg?.license ?? null,
    engines: pkg?.engines ?? null,
    scripts: pkg?.scripts ?? null,
    dependencies: deps,
    devDependencies: devDeps,
    peerDependencies: peerDeps,
    installedCount: installedPackages?.length ?? null,
    installedPackages: installedPackages?.slice(0, 100) ?? null,
    readme: readme ? readme.slice(0, 4000) : null,
    projectRoot
  };
}

async function buildPackageContext(packageName, projectRoot) {
  // Look for the package in node_modules
  const nmPath = path.join(projectRoot, "node_modules", packageName);
  const pkg = await readJsonSafe(path.join(nmPath, "package.json"));

  const readme = await readFileSafe(path.join(nmPath, "README.md"))
    ?? await readFileSafe(path.join(nmPath, "readme.md"));

  const hasTypes = pkg?.types || pkg?.typings
    || await exists(path.join(nmPath, "index.d.ts"))
    || await exists(path.join(nmPath, "dist", "index.d.ts"));

  let typeDefinitions = null;
  if (hasTypes) {
    const typeFile = pkg?.types ?? pkg?.typings ?? "index.d.ts";
    typeDefinitions = await readFileSafe(path.join(nmPath, typeFile));
    if (typeDefinitions && typeDefinitions.length > 6000) {
      typeDefinitions = typeDefinitions.slice(0, 6000) + "\n// ... (truncated) ...";
    }
  }

  const exports = pkg?.exports ?? null;
  const mainEntry = pkg?.main ?? pkg?.module ?? "index.js";
  const bin = pkg?.bin ?? null;

  return {
    kind: "package",
    name: pkg?.name ?? packageName,
    version: pkg?.version ?? "unknown",
    description: pkg?.description ?? null,
    license: pkg?.license ?? null,
    homepage: pkg?.homepage ?? null,
    repository: typeof pkg?.repository === "string" ? pkg.repository : pkg?.repository?.url ?? null,
    engines: pkg?.engines ?? null,
    main: mainEntry,
    exports,
    bin,
    hasTypes: !!hasTypes,
    typeDefinitions,
    dependencies: Object.keys(pkg?.dependencies ?? {}),
    peerDependencies: Object.keys(pkg?.peerDependencies ?? {}),
    readme: readme ? readme.slice(0, 4000) : null,
    installedPath: nmPath
  };
}

export async function cmdContext(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better context [<package>] [--json] [--project-root PATH]
  better context --all [--json] [--project-root PATH]

Generate LLM-friendly context for a package or the entire project.
With no arguments: outputs project-level context (dependencies, scripts, lockfile).
With <package>: reads the installed package from node_modules.
With --all: generates context for every installed package (may be large).

Options:
  --all              Generate context for all installed packages
  --include-types    Include TypeScript definition files (default: true)
  --project-root     Path to project root
  --json             Output structured JSON
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
      all: { type: "boolean", default: false },
      "include-types": { type: "boolean", default: true }
    },
    allowPositionals: true,
    strict: false
  });

  const projectRoot = values["project-root"]
    ? path.resolve(values["project-root"])
    : process.cwd();

  // Try better-core binary first (only in human mode — binary's JSON support is limited)
  const corePath = await findBetterCore();
  if (corePath && !values.json) {
    const args = ["context", ...positionals];
    if (values.all) args.push("--all");
    if (values["project-root"]) args.push("--project-root", values["project-root"]);
    const res = await runCommand(corePath, args, { cwd: projectRoot, passthroughStdio: true });
    process.exitCode = res.exitCode ?? 0;
    return;
  }

  // JS-native fallback
  const packageName = positionals[0];

  if (values.all) {
    // Generate context for all installed packages
    const lockPkg = await readJsonSafe(path.join(projectRoot, "package-lock.json"));
    const packageNames = lockPkg
      ? Object.keys(lockPkg.packages ?? {})
          .filter(k => k && k !== "" && !k.includes("/node_modules/"))
          .map(k => k.replace(/^node_modules\//, ""))
      : [];

    const contexts = [];
    for (const name of packageNames.slice(0, 50)) { // cap at 50 to avoid huge output
      try {
        const ctx = await buildPackageContext(name, projectRoot);
        contexts.push(ctx);
      } catch { /* skip */ }
    }

    const out = {
      ok: true,
      kind: "better.context.all",
      schemaVersion: 1,
      projectRoot,
      packageCount: packageNames.length,
      includedCount: contexts.length,
      packages: contexts
    };
    if (values.json) { printJson(out); return; }
    for (const ctx of contexts) {
      printText(`## ${ctx.name}@${ctx.version}\n${ctx.description ?? ""}\nDeps: ${ctx.dependencies.join(", ") || "none"}\n`);
    }
    return;
  }

  if (!packageName) {
    // Project-level context
    const { kind: _k1, ...ctx } = await buildProjectContext(projectRoot);
    const out = { ok: true, kind: "better.context.project", schemaVersion: 1, ...ctx };
    if (values.json) { printJson(out); return; }
    printText([
      `## ${out.name}@${out.version}`,
      out.description ? `${out.description}` : "",
      `- dependencies: ${out.dependencies.join(", ") || "none"}`,
      `- devDependencies: ${out.devDependencies.join(", ") || "none"}`,
      `- installed packages: ${out.installedCount ?? "unknown"}`,
      out.readme ? `\n### README (preview)\n${out.readme.slice(0, 800)}` : ""
    ].filter(Boolean).join("\n"));
    return;
  }

  // Single package context
  try {
    const { kind: _k2, ...ctx } = await buildPackageContext(packageName, projectRoot);
    const out = { ok: true, kind: "better.context.package", schemaVersion: 1, ...ctx };
    if (values.json) { printJson(out); return; }
    const lines = [
      `## ${out.name}@${out.version}`,
      out.description ?? "",
      `- license: ${out.license ?? "unknown"}`,
      `- homepage: ${out.homepage ?? "n/a"}`,
      `- has types: ${out.hasTypes}`,
      `- dependencies: ${out.dependencies.join(", ") || "none"}`,
      out.readme ? `\n### README (preview)\n${out.readme.slice(0, 800)}` : "",
      out.typeDefinitions ? `\n### Type Definitions (preview)\n\`\`\`ts\n${out.typeDefinitions.slice(0, 1200)}\n\`\`\`` : ""
    ].filter(Boolean);
    printText(lines.join("\n"));
  } catch (err) {
    const out = { ok: false, kind: "better.context.package", error: err.message };
    if (values.json) printJson(out);
    else printText(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}
