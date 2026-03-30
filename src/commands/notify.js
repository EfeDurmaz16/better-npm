/**
 * better notify — proactive update notifications
 *
 * Checks for stale dependencies and prints a notification summary.
 * Can be hooked into shell init (add `better notify --check` to .bashrc/.zshrc).
 *
 * Usage:
 *   better notify               # show pending update summary
 *   better notify --check       # exit 0 if updates available, 1 if none
 *   better notify --schedule    # show how to add to shell init
 *   better notify --clear       # clear the notification cache
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const STATE_FILE = path.join(process.env.HOME || "/tmp", ".better", "notify-state.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function fetchLatest(name) {
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
    https.get(url, { headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" } }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

function semverParts(v) {
  const clean = String(v ?? "0.0.0").replace(/^[^0-9]*/, "");
  const [maj, min, pat] = clean.split(".").map(Number);
  return { major: maj || 0, minor: min || 0, patch: pat || 0 };
}

function semverGt(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  return pa.patch > pb.patch;
}

function stripRange(v) {
  return String(v ?? "").replace(/^[\^~>=<\s]+/, "").split(" ")[0];
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return { lastChecked: 0, updates: [] };
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function runCheck(projectRoot) {
  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    return [];
  }

  const allDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
  };

  const names = Object.keys(allDeps).slice(0, 50); // Check top 50 deps
  const BATCH = 8;
  const updates = [];

  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (name) => {
        const current = stripRange(allDeps[name]);
        const meta = await fetchLatest(name);
        if (!meta?.version) return null;
        const latest = meta.version;
        if (semverGt(latest, current)) {
          const cur = semverParts(current);
          const lat = semverParts(latest);
          let bump;
          if (lat.major > cur.major) bump = "major";
          else if (lat.minor > cur.minor) bump = "minor";
          else bump = "patch";
          return { name, current, latest, bump };
        }
        return null;
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) updates.push(r.value);
    }
  }

  return updates;
}

export async function cmdNotify(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      check: { type: "boolean", default: false },
      schedule: { type: "boolean", default: false },
      clear: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better notify [options]

Proactive update notifications — check for stale dependencies.

Options:
  --check       Exit 0 if updates available, 1 if all up-to-date
  --force       Re-check even if checked recently (bypass 24h cache)
  --schedule    Show instructions to add to shell init
  --clear       Clear notification cache
  --json        Machine-readable output
  -h, --help    Show this help

Shell integration:
  Add to ~/.bashrc or ~/.zshrc:
    eval "$(better notify --schedule)"
`);
    return;
  }

  if (values.schedule) {
    printText(`# Add this to ~/.bashrc or ~/.zshrc:
# better notify --check --json 2>/dev/null | node -e "
#   let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
#     try{const r=JSON.parse(d);if(r.updates?.length)
#       console.log('\\x1b[33mbetter: '+r.updates.length+' update(s) available. Run \\'better update\\' to see them.\\x1b[0m');}catch{}
#   });" &`);
    return;
  }

  if (values.clear) {
    try {
      await fs.unlink(STATE_FILE);
      if (values.json) { printJson({ ok: true, message: "Notification cache cleared" }); }
      else { printText("Notification cache cleared."); }
    } catch {
      if (values.json) { printJson({ ok: true, message: "Nothing to clear" }); }
      else { printText("Nothing to clear."); }
    }
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const state = await loadState();
  const now = Date.now();
  const shouldCheck = values.force || (now - state.lastChecked) > CHECK_INTERVAL_MS;

  let updates = state.updates ?? [];

  if (shouldCheck) {
    if (!values.json) {
      process.stderr.write("\x1b[90mChecking for updates…\x1b[0m\n");
    }
    updates = await runCheck(projectRoot);
    await saveState({ lastChecked: now, updates });
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.notify",
      updates,
      total: updates.length,
      last_checked: new Date(shouldCheck ? now : state.lastChecked).toISOString(),
      from_cache: !shouldCheck,
    });
    process.exitCode = updates.length > 0 ? 0 : 1;
    return;
  }

  if (values.check) {
    process.exitCode = updates.length > 0 ? 0 : 1;
    return;
  }

  if (updates.length === 0) {
    const checkedAt = shouldCheck ? "just now" : new Date(state.lastChecked).toLocaleString();
    printText(`\x1b[32mAll dependencies up to date\x1b[0m (checked ${checkedAt})`);
    return;
  }

  const majors = updates.filter(u => u.bump === "major");
  const minors = updates.filter(u => u.bump === "minor");
  const patches = updates.filter(u => u.bump === "patch");

  printText(`\n\x1b[1mbetter notify — ${updates.length} update(s) available\x1b[0m\n`);

  if (patches.length > 0) {
    printText(`\x1b[32m${patches.length} patch update(s):\x1b[0m`);
    for (const u of patches.slice(0, 5)) {
      printText(`  ${u.name.padEnd(28)} ${u.current} → ${u.latest}`);
    }
    if (patches.length > 5) printText(`  \x1b[90m...and ${patches.length - 5} more\x1b[0m`);
  }

  if (minors.length > 0) {
    printText(`\n\x1b[33m${minors.length} minor update(s):\x1b[0m`);
    for (const u of minors.slice(0, 5)) {
      printText(`  ${u.name.padEnd(28)} ${u.current} → ${u.latest}`);
    }
    if (minors.length > 5) printText(`  \x1b[90m...and ${minors.length - 5} more\x1b[0m`);
  }

  if (majors.length > 0) {
    printText(`\n\x1b[31m${majors.length} major update(s) — may have breaking changes:\x1b[0m`);
    for (const u of majors.slice(0, 5)) {
      printText(`  ${u.name.padEnd(28)} ${u.current} → ${u.latest}`);
    }
    if (majors.length > 5) printText(`  \x1b[90m...and ${majors.length - 5} more\x1b[0m`);
  }

  printText(`\n\x1b[90mRun \x1b[0m\x1b[1mbetter update\x1b[0m\x1b[90m to see details, or \x1b[0m\x1b[1mbetter update --apply --safe\x1b[0m\x1b[90m to auto-apply patch/minor.\x1b[0m`);
}
