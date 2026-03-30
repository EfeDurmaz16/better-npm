import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better diff [ref1] [ref2]` — compare lockfile dependency sets
 *
 * Usage:
 *   better diff                    # compare working tree vs HEAD
 *   better diff HEAD~1             # compare HEAD vs HEAD~1
 *   better diff HEAD~1 HEAD        # explicit range
 *   better diff v1.0.0 v1.1.0      # compare git tags
 *   better diff --base file1.lock --head file2.lock  # compare files
 */
export async function cmdDiff(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better diff [ref1] [ref2] [options]
  better diff --base <file> --head <file>

Compare package dependencies between two lockfile states.

Arguments:
  ref1, ref2     Git refs (commits, tags, branches). Default: HEAD~1 HEAD

Options:
  --base FILE    Path to base lockfile
  --head FILE    Path to head lockfile
  --json         Machine-readable JSON output
  --no-color     Disable colored output
  -h, --help     Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      base: { type: "string" },
      head: { type: "string" },
      "no-color": { type: "boolean", default: false },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  let basePkgs, headPkgs;

  if (values.base && values.head) {
    // Direct file comparison
    basePkgs = await readLockfile(values.base);
    headPkgs = await readLockfile(values.head);
  } else {
    // Git-based comparison
    const ref1 = positionals[0] || "HEAD~1";
    const ref2 = positionals[1] || "HEAD";

    const lockPath = path.join(projectRoot, "package-lock.json");
    const lockExists = await fs.access(lockPath).then(() => true).catch(() => false);
    if (!lockExists) {
      printText("Error: package-lock.json not found");
      process.exitCode = 1;
      return;
    }

    try {
      const { execSync } = await import("node:child_process");
      const base = execSync(`git show ${ref1}:package-lock.json 2>/dev/null`, { cwd: projectRoot }).toString();
      const head = execSync(`git show ${ref2}:package-lock.json 2>/dev/null`, { cwd: projectRoot }).toString();
      basePkgs = extractPackages(JSON.parse(base));
      headPkgs = extractPackages(JSON.parse(head));
    } catch (err) {
      // Fall back to working tree vs HEAD
      try {
        const { execSync } = await import("node:child_process");
        const base = execSync(`git show HEAD:package-lock.json 2>/dev/null`, { cwd: projectRoot }).toString();
        basePkgs = extractPackages(JSON.parse(base));
        headPkgs = await readLockfile(lockPath);
      } catch {
        printText(`Error: could not get lockfile at git ref (${err.message})`);
        process.exitCode = 1;
        return;
      }
    }
  }

  const diff = computeDiff(basePkgs, headPkgs);

  if (values.json) {
    printJson({ ok: true, kind: "better.diff", ...diff });
    return;
  }

  // Text output
  const noColor = values["no-color"] || !process.stdout.isTTY;
  const red = noColor ? (s) => s : (s) => `\x1b[31m${s}\x1b[0m`;
  const green = noColor ? (s) => s : (s) => `\x1b[32m${s}\x1b[0m`;
  const yellow = noColor ? (s) => s : (s) => `\x1b[33m${s}\x1b[0m`;

  const lines = [];
  if (diff.added.length > 0) {
    lines.push(green(`+ ${diff.added.length} added`));
    for (const p of diff.added) lines.push(green(`  + ${p.name}@${p.version}`));
  }
  if (diff.removed.length > 0) {
    lines.push(red(`- ${diff.removed.length} removed`));
    for (const p of diff.removed) lines.push(red(`  - ${p.name}@${p.version}`));
  }
  if (diff.upgraded.length > 0) {
    lines.push(yellow(`\u2191 ${diff.upgraded.length} upgraded`));
    for (const p of diff.upgraded) lines.push(yellow(`  \u2191 ${p.name}: ${p.from} \u2192 ${p.to}`));
  }
  if (diff.downgraded.length > 0) {
    lines.push(red(`\u2193 ${diff.downgraded.length} downgraded`));
    for (const p of diff.downgraded) lines.push(red(`  \u2193 ${p.name}: ${p.from} \u2192 ${p.to}`));
  }

  if (lines.length === 0) {
    printText("No dependency changes.");
  } else {
    printText(lines.join("\n"));
  }
}

async function readLockfile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return extractPackages(JSON.parse(content));
}

function extractPackages(lockJson) {
  const pkgs = {};
  if (lockJson.packages) {
    for (const [key, val] of Object.entries(lockJson.packages)) {
      if (!key || key === "") continue;
      const name = key.replace(/^node_modules\//, "");
      pkgs[name] = val.version;
    }
  } else if (lockJson.dependencies) {
    function walk(deps) {
      for (const [name, val] of Object.entries(deps)) {
        pkgs[name] = val.version;
        if (val.dependencies) walk(val.dependencies);
      }
    }
    walk(lockJson.dependencies);
  }
  return pkgs;
}

function computeDiff(base, head) {
  const added = [];
  const removed = [];
  const upgraded = [];
  const downgraded = [];

  const allNames = new Set([...Object.keys(base), ...Object.keys(head)]);
  for (const name of allNames) {
    if (!(name in base)) {
      added.push({ name, version: head[name] });
    } else if (!(name in head)) {
      removed.push({ name, version: base[name] });
    } else if (base[name] !== head[name]) {
      const direction = compareVersions(head[name], base[name]);
      if (direction >= 0) {
        upgraded.push({ name, from: base[name], to: head[name] });
      } else {
        downgraded.push({ name, from: base[name], to: head[name] });
      }
    }
  }

  return {
    added, removed, upgraded, downgraded,
    summary: { added: added.length, removed: removed.length, upgraded: upgraded.length, downgraded: downgraded.length }
  };
}

function compareVersions(a, b) {
  const pa = a.split(".").map(n => parseInt(n) || 0);
  const pb = b.split(".").map(n => parseInt(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
