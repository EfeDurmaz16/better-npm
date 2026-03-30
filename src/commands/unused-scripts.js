/**
 * better unused-scripts — find package.json scripts that are never called
 *
 * Scans for npm scripts that are not referenced in other scripts,
 * CI configuration, or documentation, helping identify dead scripts.
 *
 * Usage:
 *   better unused-scripts
 *   better unused-scripts --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Lifecycle scripts that npm calls automatically
const LIFECYCLE_SCRIPTS = new Set([
  "prepare", "prepublish", "prepublishOnly", "postpublish",
  "preinstall", "install", "postinstall", "preuninstall", "uninstall", "postuninstall",
  "preversion", "version", "postversion",
  "pretest", "test", "posttest",
  "prestop", "stop", "poststop",
  "prestart", "start", "poststart",
  "prerestart", "restart", "postrestart",
  "preshrinkwrap", "shrinkwrap", "postshrinkwrap",
]);

// Common scripts that are typically user-invoked
const COMMON_USER_SCRIPTS = new Set([
  "test", "build", "start", "dev", "lint", "format", "clean", "deploy",
  "typecheck", "check", "watch", "serve",
]);

async function readFileIfExists(p) {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

async function findReferencesInFiles(scriptNames, projectRoot) {
  const referenced = new Set();
  const searchDirs = [".github", ".circleci", ".gitlab"];
  const searchExts = [".yml", ".yaml", ".json", ".md", ".sh", ".txt"];

  async function scanDir(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await scanDir(full);
      else if (e.isFile() && searchExts.includes(path.extname(e.name).toLowerCase())) {
        const content = await readFileIfExists(full);
        if (!content) continue;
        for (const name of scriptNames) {
          if (content.includes(`npm run ${name}`) || content.includes(`yarn ${name}`) || content.includes(`pnpm run ${name}`)) {
            referenced.add(name);
          }
        }
      }
    }
  }

  for (const dir of searchDirs) {
    await scanDir(path.join(projectRoot, dir));
  }

  // Check README
  const readme = await readFileIfExists(path.join(projectRoot, "README.md"))
    || await readFileIfExists(path.join(projectRoot, "readme.md"));
  if (readme) {
    for (const name of scriptNames) {
      if (readme.includes(`npm run ${name}`) || readme.includes(name)) referenced.add(name);
    }
  }

  return referenced;
}

export async function cmdUnusedScripts(argv) {
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
    printText(`Usage: better unused-scripts [options]

Find package.json scripts that may be unused or dead code.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Analysis:
  • Checks which scripts call other scripts (npm run X)
  • Scans .github/, .circleci/, .gitlab/ CI configs
  • Checks README.md for script references
  • Marks lifecycle scripts as automatically called
  • Marks common scripts (test, build, start) as user-invoked
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

  const scripts = pkgJson.scripts || {};
  const scriptNames = Object.keys(scripts);

  if (scriptNames.length === 0) {
    if (values.json) { printJson({ ok: true, kind: "better.unused-scripts", scripts: [], unused: [] }); return; }
    printText(`\x1b[90mNo scripts defined in package.json.\x1b[0m`);
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter unused-scripts\x1b[0m\n`);
  }

  // Find scripts referenced by other scripts
  const referencedByScripts = new Set();
  for (const [, cmd] of Object.entries(scripts)) {
    for (const name of scriptNames) {
      if (cmd.includes(`npm run ${name}`) || cmd.includes(`run ${name}`) || cmd.includes(`:${name}`) || cmd.includes(`&&${name}`)) {
        referencedByScripts.add(name);
      }
    }
    // Pre/post hooks are automatically called
    for (const name of scriptNames) {
      if (scripts[`pre${name}`] !== undefined) referencedByScripts.add(`pre${name}`);
      if (scripts[`post${name}`] !== undefined) referencedByScripts.add(`post${name}`);
    }
  }

  // Check CI and docs
  const referencedInFiles = await findReferencesInFiles(scriptNames, projectRoot);

  // Classify scripts
  const analysis = scriptNames.map(name => {
    const isLifecycle = LIFECYCLE_SCRIPTS.has(name);
    const isCommon = COMMON_USER_SCRIPTS.has(name);
    const isPrePost = /^(pre|post)/.test(name) && scriptNames.includes(name.slice(name.startsWith("pre") ? 3 : 4));
    const calledByOther = referencedByScripts.has(name);
    const inFiles = referencedInFiles.has(name);

    const used = isLifecycle || isCommon || isPrePost || calledByOther || inFiles;
    const reason = isLifecycle ? "lifecycle" : isCommon ? "common" : isPrePost ? "pre/post hook" : calledByOther ? "called by other script" : inFiles ? "referenced in CI/docs" : null;

    return { name, script: scripts[name], used, reason };
  });

  const unused = analysis.filter(a => !a.used);

  if (values.json) {
    printJson({ ok: true, kind: "better.unused-scripts", total: scriptNames.length, unused: unused.length, scripts: analysis });
    return;
  }

  printText(`  Total scripts: ${scriptNames.length}  |  Potentially unused: ${unused.length}\n`);

  if (unused.length === 0) {
    printText(`\x1b[32m✔ All scripts appear to be used.\x1b[0m`);
  } else {
    printText(`\x1b[33mPotentially unused scripts:\x1b[0m`);
    for (const s of unused) {
      printText(`  \x1b[33m⚠\x1b[0m  \x1b[1m${s.name}\x1b[0m`);
      printText(`       \x1b[90m${s.script.slice(0, 80)}${s.script.length > 80 ? "…" : ""}\x1b[0m`);
    }
    printText(`\n\x1b[90m  Note: static analysis only — may have false positives.\x1b[0m`);
  }
  printText("");
}
