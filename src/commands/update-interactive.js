/**
 * better update-interactive — interactive dependency update checker
 *
 * Shows which dependencies have updates available, categorized by
 * semver type (patch/minor/major), with links to changelogs.
 *
 * Usage:
 *   better update-interactive
 *   better update-interactive --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "better-npm/1.0" }, timeout: 8000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function parseVersion(v) {
  const clean = String(v).replace(/^[^0-9]*/, "");
  const parts = clean.split(".").map(Number);
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0, raw: clean };
}

function classifyUpdate(current, latest) {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (l.major > c.major) return "major";
  if (l.minor > c.minor) return "minor";
  if (l.patch > c.patch) return "patch";
  return "none";
}

export async function cmdUpdateInteractive(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      "prod-only": { type: "boolean", default: false },
      major:    { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better update-interactive [options]

Show available dependency updates with changelogs.

Options:
  --prod-only  Only check production dependencies
  --major      Include major version updates (hidden by default)
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter update-interactive\x1b[0m\n`);
    process.stderr.write(`\x1b[90mChecking for updates...\x1b[0m\n`);
  }

  let pkgJson = {};
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const allDeps = values["prod-only"]
    ? { ...pkgJson.dependencies }
    : { ...pkgJson.dependencies, ...pkgJson.devDependencies };

  const depList = Object.entries(allDeps).map(([name, range]) => ({ name, range }));

  // Fetch latest versions in batches
  const BATCH = 5;
  const results = [];
  for (let i = 0; i < depList.length; i += BATCH) {
    const batch = depList.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ name, range }) => {
      try {
        const { status, body } = await httpGet(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
        if (status !== 200) return;
        const data = JSON.parse(body);
        const latest = data.version;
        const current = String(range).replace(/^[~^>=<]+/, "");
        const type = classifyUpdate(current, latest);
        if (type === "none") return;
        if (type === "major" && !values.major) return;
        results.push({
          name,
          current,
          range,
          latest,
          type,
          changelog: data.repository?.url
            ? data.repository.url.replace(/^git\+/, "").replace(/\.git$/, "") + "/releases"
            : null,
          isDev: !pkgJson.dependencies?.[name],
        });
      } catch {}
    }));
  }

  results.sort((a, b) => {
    const order = { major: 0, minor: 1, patch: 2 };
    return (order[a.type] ?? 3) - (order[b.type] ?? 3) || a.name.localeCompare(b.name);
  });

  const majors = results.filter(r => r.type === "major");
  const minors = results.filter(r => r.type === "minor");
  const patches = results.filter(r => r.type === "patch");

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.update-interactive",
      checked: depList.length,
      updates: results.length,
      majors: majors.length,
      minors: minors.length,
      patches: patches.length,
      packages: results,
    });
    return;
  }

  if (results.length === 0) {
    printText(`\x1b[32m✔ All ${depList.length} dependencies are up to date.\x1b[0m\n`);
    return;
  }

  printText(`  Checked: ${depList.length}  |  Updates: ${results.length}  (${majors.length} major, ${minors.length} minor, ${patches.length} patch)\n`);

  const TYPE_COLORS = { major: "\x1b[31m", minor: "\x1b[33m", patch: "\x1b[32m" };
  for (const r of results) {
    const col = TYPE_COLORS[r.type] || "";
    const devTag = r.isDev ? " \x1b[90m(dev)\x1b[0m" : "";
    const type = `${col}${r.type.padEnd(5)}\x1b[0m`;
    printText(`  ${type}  \x1b[1m${r.name}\x1b[0m  ${r.current} → \x1b[1m${r.latest}\x1b[0m${devTag}`);
  }

  printText(`\n  Run: \x1b[90mnpm update\x1b[0m (for minor/patch) or update package.json manually for major updates.`);
  printText("");
}
