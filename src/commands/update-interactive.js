/**
 * better update-interactive — interactive major/minor update chooser
 *
 * Lists all available updates grouped by major/minor/patch,
 * lets the user select which ones to apply, then updates
 * package.json version ranges and optionally runs npm install.
 *
 * Usage:
 *   better update-interactive
 *   better update-interactive --no-install
 *   better update-interactive --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
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

function parseMajor(v) { return parseInt(String(v).replace(/^[~^>=v]/, "").split(".")[0]) || 0; }
function parseMinor(v) { return parseInt(String(v).replace(/^[~^>=v]/, "").split(".")[1]) || 0; }
function parsePatch(v) { return parseInt(String(v).replace(/^[~^>=v]/, "").split(".")[2]) || 0; }

function bumpType(current, latest) {
  const cm = parseMajor(current), lm = parseMajor(latest);
  if (lm > cm) return "major";
  const cmi = parseMinor(current), lmi = parseMinor(latest);
  if (lmi > cmi) return "minor";
  const cp = parsePatch(current), lp = parsePatch(latest);
  if (lp > cp) return "patch";
  return "none";
}

function applyPrefix(range, version) {
  const prefix = range.match(/^([~^])/)?.[1] || "^";
  return `${prefix}${version}`;
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

export async function cmdUpdateInteractive(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:        { type: "boolean", default: runtime.json === true },
      help:        { type: "boolean", short: "h", default: false },
      install:     { type: "boolean", default: true },
      "no-install":{ type: "boolean", default: false },
      dev:         { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better update-interactive [packages...] [options]

Interactively choose which packages to update.

Options:
  --no-install    Skip running npm install after updating
  --dev           Include devDependencies
  --json          Show available updates as JSON (non-interactive)
  -h, --help      Show this help

Examples:
  better update-interactive
  better update-interactive react next
  better update-interactive --no-install
`);
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

  const sections = values.dev
    ? [["dependencies", pkgJson.dependencies], ["devDependencies", pkgJson.devDependencies]]
    : [["dependencies", pkgJson.dependencies]];

  const allDeps = {};
  for (const [section, deps] of sections) {
    for (const [name, range] of Object.entries(deps || {})) {
      allDeps[name] = { range, section };
    }
  }

  const targets = positionals.length > 0
    ? positionals.filter(p => allDeps[p])
    : Object.keys(allDeps);

  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking ${targets.length} package(s) for updates…\x1b[0m\n`);
  }

  const BATCH = 8;
  const updates = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (name) => {
      const { range, section } = allDeps[name];
      const latest = await fetchLatestVersion(name);
      if (!latest) return null;
      const type = bumpType(range, latest);
      if (type === "none") return null;
      return { name, current: range, latest, type, section };
    }));
    updates.push(...results.filter(Boolean));
  }

  updates.sort((a, b) => {
    const order = { major: 0, minor: 1, patch: 2 };
    return (order[a.type] ?? 3) - (order[b.type] ?? 3) || a.name.localeCompare(b.name);
  });

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.update-interactive",
      totalChecked: targets.length,
      availableUpdates: updates.length,
      updates,
    });
    return;
  }

  if (updates.length === 0) {
    printText(`\n\x1b[32m✔ All packages are up to date.\x1b[0m`);
    return;
  }

  if (!process.stdin.isTTY) {
    // Non-interactive: just show the list
    printText(`\n\x1b[1mbetter update-interactive\x1b[0m — ${updates.length} update(s) available\n`);
    const typeColor = { major: "\x1b[31m", minor: "\x1b[33m", patch: "\x1b[32m" };
    for (const u of updates) {
      const col = typeColor[u.type] || "";
      printText(`  ${col}${u.type.padEnd(7)}\x1b[0m  \x1b[1m${u.name}\x1b[0m  ${u.current} → \x1b[32m${u.latest}\x1b[0m`);
    }
    printText(`\n\x1b[90mRun in an interactive terminal to select updates.\x1b[0m`);
    return;
  }

  printText(`\n\x1b[1mbetter update-interactive\x1b[0m — ${updates.length} update(s) available\n`);

  const TYPE_COLOR = { major: "\x1b[31m", minor: "\x1b[33m", patch: "\x1b[32m" };

  updates.forEach((u, i) => {
    const col = TYPE_COLOR[u.type] || "";
    const num = String(i + 1).padStart(3);
    printText(`  ${num}. [${col}${u.type}\x1b[0m] \x1b[1m${u.name}\x1b[0m  ${u.current} → \x1b[32m${u.latest}\x1b[0m  \x1b[90m(${u.section})\x1b[0m`);
  });

  printText(`\nEnter numbers to select (e.g. 1,3,5), ranges (1-3), "all", or "none":`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask(rl, "> ");
  rl.close();

  let selected = [];
  const trimmed = answer.trim().toLowerCase();

  if (trimmed === "all") {
    selected = updates;
  } else if (trimmed === "none" || trimmed === "") {
    printText(`\x1b[90mNo updates applied.\x1b[0m`);
    return;
  } else {
    const parts = trimmed.split(",").map(s => s.trim());
    for (const part of parts) {
      if (part.includes("-")) {
        const [from, to] = part.split("-").map(Number);
        for (let i = from; i <= to; i++) {
          if (updates[i - 1]) selected.push(updates[i - 1]);
        }
      } else {
        const idx = parseInt(part);
        if (!isNaN(idx) && updates[idx - 1]) selected.push(updates[idx - 1]);
      }
    }
  }

  if (selected.length === 0) {
    printText(`\x1b[90mNo valid selections. Nothing updated.\x1b[0m`);
    return;
  }

  // Apply updates to pkgJson
  const updated = { ...pkgJson };
  for (const u of selected) {
    if (!updated[u.section]) continue;
    const newRange = applyPrefix(u.current, u.latest);
    updated[u.section][u.name] = newRange;
  }

  await fs.writeFile(pkgPath, JSON.stringify(updated, null, 2) + "\n");

  printText(`\n\x1b[32m✔ Updated ${selected.length} package(s):\x1b[0m`);
  for (const u of selected) {
    printText(`  \x1b[1m${u.name}\x1b[0m  ${u.current} → \x1b[32m${applyPrefix(u.current, u.latest)}\x1b[0m`);
  }

  const doInstall = values.install !== false && !values["no-install"];
  if (doInstall) {
    printText(`\n\x1b[90mRunning npm install…\x1b[0m`);
    const r = spawnSync("npm", ["install"], { cwd: projectRoot, stdio: "inherit" });
    if (r.status !== 0) {
      printText(`\x1b[31mWarning: npm install exited with code ${r.status}\x1b[0m`);
    } else {
      printText(`\x1b[32m✔ npm install complete.\x1b[0m`);
    }
  } else {
    printText(`\n\x1b[90mRun npm install to apply the version changes.\x1b[0m`);
  }
}
