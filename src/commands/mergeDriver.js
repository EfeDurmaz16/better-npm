/**
 * better merge-driver — manage the better.lock.json git merge driver.
 *
 * Subcommands:
 *   install   Register the driver in .git/config + .gitattributes
 *   uninstall Remove the registration
 *   status    Show current registration state
 */
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const DRIVER_NAME = "better-lock";
const ATTR_LINE = "better.lock.json merge=better-lock\n";

const HELP = `better merge-driver — git merge driver for better.lock.json

Usage:
  better merge-driver install    Register driver in .git/config + .gitattributes
  better merge-driver uninstall  Remove driver registration
  better merge-driver status     Show registration state

Options:
  --project-root PATH  Override project root
  --json               Machine-readable output
  --global             Install/uninstall in global git config (~/.gitconfig)
`;

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function findGitDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, ".git");
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readGitConfig(configPath) {
  try {
    return await fs.readFile(configPath, "utf8");
  } catch {
    return "";
  }
}

async function writeGitConfig(configPath, content) {
  await fs.writeFile(configPath, content, "utf8");
}

function hasDriverSection(configContent) {
  return configContent.includes(`[merge "${DRIVER_NAME}"]`);
}

function driverSection(driverBin) {
  return (
    `[merge "${DRIVER_NAME}"]\n` +
    `\tname = better lockfile merge driver\n` +
    `\tdriver = ${driverBin} %O %A %B %P\n`
  );
}

function removeDriverSection(configContent) {
  // Remove from [merge "better-lock"] through the next blank line / section
  return configContent
    .replace(/\[merge "better-lock"\][^\[]*/, "")
    .replace(/\n{3,}/g, "\n\n");
}

async function readAttrFile(attrPath) {
  try {
    return await fs.readFile(attrPath, "utf8");
  } catch {
    return "";
  }
}

async function ensureAttrLine(attrPath) {
  const existing = await readAttrFile(attrPath);
  if (existing.includes("merge=better-lock")) return false; // already there
  await fs.writeFile(attrPath, existing + (existing.endsWith("\n") || !existing ? "" : "\n") + ATTR_LINE, "utf8");
  return true;
}

async function removeAttrLine(attrPath) {
  const existing = await readAttrFile(attrPath);
  if (!existing.includes("merge=better-lock")) return false;
  const updated = existing
    .split("\n")
    .filter(l => !l.includes("merge=better-lock"))
    .join("\n");
  await fs.writeFile(attrPath, updated, "utf8");
  return true;
}

export async function runMergeDriver(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      "project-root": { type: "string" },
      global: { type: "boolean" }
    },
    allowPositionals: true,
    strict: false
  });

  const sub = positionals[0];

  if (!sub || sub === "help" || sub === "--help") {
    printText(HELP);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]), reason: "flag" }
    : await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const isGlobal = values.global === true;
  const gitDir = isGlobal ? null : await findGitDir(projectRoot);

  // Driver binary path: prefer the installed bin, fall back to the script
  const driverBin = "better-merge-driver";

  if (sub === "install") {
    const results = { config: false, attrs: false };

    if (isGlobal) {
      // Use git's global config
      const { execSync } = await import("node:child_process");
      try {
        execSync(`git config --global merge.${DRIVER_NAME}.name "better lockfile merge driver"`);
        execSync(`git config --global merge.${DRIVER_NAME}.driver "${driverBin} %O %A %B %P"`);
        results.config = true;
      } catch (err) {
        const msg = `Failed to write global git config: ${err.message}`;
        if (values.json) { printJson({ ok: false, reason: msg }); } else { printText(msg); }
        process.exitCode = 1;
        return;
      }
    } else {
      if (!gitDir) {
        const msg = "Not inside a git repository. Run from a git repo or use --global.";
        if (values.json) { printJson({ ok: false, reason: msg }); } else { printText(msg); }
        process.exitCode = 1;
        return;
      }

      const configPath = path.join(gitDir, "config");
      const configContent = await readGitConfig(configPath);
      if (!hasDriverSection(configContent)) {
        await writeGitConfig(configPath, configContent.trimEnd() + "\n\n" + driverSection(driverBin));
        results.config = true;
      }
    }

    // .gitattributes in project root
    const attrPath = path.join(projectRoot, ".gitattributes");
    results.attrs = await ensureAttrLine(attrPath);

    const out = {
      ok: true,
      installed: true,
      configUpdated: results.config,
      attrsUpdated: results.attrs,
      scope: isGlobal ? "global" : "local",
      gitattributes: path.join(projectRoot, ".gitattributes")
    };

    if (values.json) {
      printJson(out);
    } else {
      const lines = ["better merge-driver: install"];
      lines.push(`- scope: ${out.scope}`);
      lines.push(`- git config: ${results.config ? "updated" : "already registered"}`);
      lines.push(`- .gitattributes: ${results.attrs ? "updated" : "already present"}`);
      lines.push("- driver registered as: better-lock");
      lines.push('- files matched: better.lock.json merge=better-lock');
      printText(lines.join("\n"));
    }
    return;
  }

  if (sub === "uninstall") {
    const results = { config: false, attrs: false };

    if (isGlobal) {
      const { execSync } = await import("node:child_process");
      try {
        execSync(`git config --global --remove-section merge.${DRIVER_NAME}`);
        results.config = true;
      } catch { /* section may not exist */ }
    } else {
      if (gitDir) {
        const configPath = path.join(gitDir, "config");
        const configContent = await readGitConfig(configPath);
        if (hasDriverSection(configContent)) {
          await writeGitConfig(configPath, removeDriverSection(configContent));
          results.config = true;
        }
      }
    }

    const attrPath = path.join(projectRoot, ".gitattributes");
    results.attrs = await removeAttrLine(attrPath);

    const out = { ok: true, uninstalled: true, configUpdated: results.config, attrsUpdated: results.attrs };
    if (values.json) {
      printJson(out);
    } else {
      printText(
        ["better merge-driver: uninstall",
          `- git config: ${results.config ? "removed" : "was not registered"}`,
          `- .gitattributes: ${results.attrs ? "removed" : "was not present"}`
        ].join("\n")
      );
    }
    return;
  }

  if (sub === "status") {
    const gitConfigRegistered = (() => {
      if (isGlobal) return false; // skip for global check
      return true; // simplistic; full check would read the config
    })();
    const attrPath = path.join(projectRoot, ".gitattributes");
    const attrContent = await readAttrFile(attrPath);
    const attrRegistered = attrContent.includes("merge=better-lock");

    let localConfigRegistered = false;
    if (gitDir) {
      const configContent = await readGitConfig(path.join(gitDir, "config"));
      localConfigRegistered = hasDriverSection(configContent);
    }

    const out = {
      ok: true,
      gitConfigRegistered: localConfigRegistered,
      gitattributesRegistered: attrRegistered,
      driverName: DRIVER_NAME,
      gitattributesPath: attrPath
    };

    if (values.json) {
      printJson(out);
    } else {
      printText(
        ["better merge-driver: status",
          `- driver name: ${DRIVER_NAME}`,
          `- git config: ${localConfigRegistered ? "registered" : "not registered"}`,
          `- .gitattributes: ${attrRegistered ? "registered" : "not registered"}`
        ].join("\n")
      );
    }
    return;
  }

  printText(`Unknown subcommand: ${sub}\n\n${HELP}`);
  process.exitCode = 2;
}
