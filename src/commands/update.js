/**
 * better update — auto-update intelligence (#19)
 *
 * Fetches latest versions for all direct deps, classifies each as
 * patch / minor / major, optionally fetches CHANGELOG snippets, and
 * presents a ranked safe-to-upgrade list.
 *
 * Usage:
 *   better update                  # list all available upgrades
 *   better update --safe           # only patch + minor (no breaking)
 *   better update --apply          # actually bump package.json + re-install
 *   better update --changelog      # fetch changelog snippets inline
 *   better update lodash express   # limit to specific packages
 *   better update --json
 */
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { printJson, printText } from "../lib/output.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const HELP = `better update — auto-update intelligence

Usage:
  better update [packages...]       List available upgrades
  better update --safe              Only patch + minor upgrades
  better update --apply             Apply updates to package.json
  better update --changelog         Show CHANGELOG snippets
  better update --json              Machine-readable output

Options:
  --safe             Only suggest patch/minor (no breaking major bumps)
  --apply            Write changes to package.json and run install
  --changelog        Fetch and display changelog snippets
  --project-root     Override project root
  --json             Machine-readable output
  -h, --help         Show help
`;

function semverParts(v) {
  const clean = String(v ?? "0.0.0").replace(/^[^0-9]*/, "");
  const [maj, min, pat] = clean.split(".").map(Number);
  return { major: maj || 0, minor: min || 0, patch: pat || 0 };
}

function classifyBump(from, to) {
  const a = semverParts(from);
  const b = semverParts(to);
  if (b.major > a.major) return "major";
  if (b.minor > a.minor) return "minor";
  if (b.patch > a.patch) return "patch";
  return "none";
}

function semverGt(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  return pa.patch > pb.patch;
}

async function fetchJson(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" } }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}

async function fetchPackumentAbbrev(name) {
  // Abbreviated packument is much smaller
  return fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
}

/**
 * Try to find a short changelog snippet for a version bump.
 * Looks at the npm metadata `description` and `homepage` fields.
 * Falls back to GitHub releases API if repo is on github.com.
 */
async function fetchChangelogSnippet(meta, fromVersion, toVersion) {
  const repoUrl = meta?.repository?.url ?? meta?.repository ?? "";
  const ghMatch = String(repoUrl).match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!ghMatch) return null;

  const repo = ghMatch[1].replace(/\.git$/, "");
  // Try GitHub releases API (unauthenticated, may be rate-limited)
  const releases = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=20`);
  if (!Array.isArray(releases)) return null;

  const toVersionClean = toVersion.replace(/^[^0-9]*/, "");
  const release = releases.find(r =>
    r.tag_name === `v${toVersionClean}` || r.tag_name === toVersionClean
  );
  if (!release?.body) return null;

  // Return first 3 lines of the release body
  return release.body.split("\n").filter(l => l.trim()).slice(0, 3).join(" / ");
}

async function readDeps(projectRoot) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    const deps = {};
    for (const [k, v] of Object.entries(pkg.dependencies ?? {})) deps[k] = { version: v, type: "prod" };
    for (const [k, v] of Object.entries(pkg.devDependencies ?? {})) deps[k] = { version: v, type: "dev" };
    return deps;
  } catch {
    return {};
  }
}

function stripRange(v) {
  return String(v ?? "").replace(/^[\^~>=<\s]+/, "").split(" ")[0];
}

function bumpTypeColor(type) {
  const c = { patch: "\x1b[32m", minor: "\x1b[33m", major: "\x1b[31m", none: "\x1b[90m" };
  return (c[type] ?? "") + type + "\x1b[0m";
}

export async function cmdUpdate(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      safe: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      changelog: { type: "boolean", default: false },
      "project-root": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: true,
    strict: false
  });

  if (values.help) { printText(HELP); return; }

  const cwd = process.cwd();
  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const allDeps = await readDeps(projectRoot);
  const targetNames = positionals.length > 0
    ? positionals.filter(n => allDeps[n])
    : Object.keys(allDeps);

  if (targetNames.length === 0) {
    const msg = "No dependencies found.";
    if (values.json) { printJson({ ok: false, reason: msg, updates: [] }); } else { printText(msg); }
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking ${targetNames.length} package(s) for updates…\x1b[0m\n`);
  }

  const BATCH = 8;
  const updates = [];

  for (let i = 0; i < targetNames.length; i += BATCH) {
    const batch = targetNames.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (name) => {
        const dep = allDeps[name];
        const currentRaw = stripRange(dep.version);
        const meta = await fetchPackumentAbbrev(name);
        if (!meta) return null;

        const latest = meta["dist-tags"]?.latest ?? null;
        if (!latest) return null;

        const bump = classifyBump(currentRaw, latest);
        if (bump === "none") return null;

        let changelog = null;
        if (values.changelog && (bump === "patch" || bump === "minor")) {
          changelog = await fetchChangelogSnippet(meta, currentRaw, latest);
        }

        const isSafe = bump === "patch" || bump === "minor";

        return {
          name,
          type: dep.type,
          current: currentRaw,
          latest,
          bump,
          safe: isSafe,
          deprecated: Boolean(meta.deprecated),
          changelog
        };
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        updates.push(r.value);
      }
    }
  }

  // Filter if --safe
  const displayUpdates = values.safe
    ? updates.filter(u => u.safe)
    : updates;

  // Sort: patch first, then minor, then major; within each by name
  const ORDER = { patch: 0, minor: 1, major: 2 };
  displayUpdates.sort((a, b) => (ORDER[a.bump] ?? 3) - (ORDER[b.bump] ?? 3) || a.name.localeCompare(b.name));

  if (values.json) {
    printJson({ ok: true, updates: displayUpdates, total: updates.length, filtered: displayUpdates.length });
    return;
  }

  if (displayUpdates.length === 0) {
    printText(values.safe ? "All dependencies are up to date (patch/minor)." : "All dependencies are up to date.");
    return;
  }

  const COL_NAME = 32;
  const COL_CUR  = 12;
  const COL_NEW  = 12;
  const header =
    "Package".padEnd(COL_NAME) +
    "Current".padEnd(COL_CUR) +
    "Latest".padEnd(COL_NEW) +
    "Bump    Type";

  printText(`\nbetter update — ${displayUpdates.length} update(s) available\n`);
  printText("\x1b[90m" + "─".repeat(header.length + 10) + "\x1b[0m");
  printText("\x1b[1m" + header + "\x1b[0m");
  printText("\x1b[90m" + "─".repeat(header.length + 10) + "\x1b[0m");

  for (const u of displayUpdates) {
    const name = u.name.slice(0, COL_NAME - 1).padEnd(COL_NAME);
    const cur  = u.current.padEnd(COL_CUR);
    const latest = u.latest.padEnd(COL_NEW);
    const bump = bumpTypeColor(u.bump).padEnd(12);
    const type = "\x1b[90m" + u.type + "\x1b[0m";
    const depr = u.deprecated ? " \x1b[31m[deprecated]\x1b[0m" : "";
    printText(name + cur + latest + bump + type + depr);
    if (u.changelog) {
      printText("  \x1b[90m↳ " + u.changelog.slice(0, 100) + "\x1b[0m");
    }
  }

  printText("\x1b[90m" + "─".repeat(header.length + 10) + "\x1b[0m");

  const counts = { patch: 0, minor: 0, major: 0 };
  for (const u of displayUpdates) counts[u.bump] = (counts[u.bump] ?? 0) + 1;
  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  printText(`\nSummary: ${summary}`);

  if (values.apply) {
    printText("\n\x1b[1mApplying updates to package.json…\x1b[0m");
    const pkgPath = path.join(projectRoot, "package.json");
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);

    for (const u of displayUpdates) {
      const prefix = (allDeps[u.name].version.match(/^[\^~]/) ?? [""])[0];
      if (pkg.dependencies?.[u.name]) {
        pkg.dependencies[u.name] = prefix + u.latest;
      } else if (pkg.devDependencies?.[u.name]) {
        pkg.devDependencies[u.name] = prefix + u.latest;
      }
    }

    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    printText(`\x1b[32m✔ Updated package.json (${displayUpdates.length} packages)\x1b[0m`);
    printText("\x1b[90mRun `better install` to apply changes.\x1b[0m");
  } else {
    printText("\x1b[90mRun `better update --apply` to write changes to package.json.\x1b[0m");
  }
}
