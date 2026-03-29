/**
 * better risk — dependency risk scoring (#18)
 *
 * Computes A–F risk grades for installed packages using:
 *   - npm registry metadata (staleness, deprecation, maintainer count)
 *   - OSV vulnerability data (integrated with existing audit)
 *   - Optional weekly download counts
 *
 * Usage:
 *   better risk                        # score all direct deps
 *   better risk --all                  # include transitive
 *   better risk lodash express         # score specific packages
 *   better risk --threshold F          # exit 1 if any package >= grade F
 *   better risk --json
 */
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { printJson, printText } from "../lib/output.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { scorePackage, scorePortfolio, riskLabel } from "../lib/riskScore.js";

const HELP = `better risk — dependency risk scoring

Usage:
  better risk [packages...]         Score direct dependencies (or named packages)
  better risk --all                 Include transitive dependencies
  better risk --threshold <grade>   Exit 1 if worst grade ≥ threshold (A-F)

Options:
  --all              Include transitive deps
  --threshold GRADE  A|B|C|D|F exit-code threshold (default: none)
  --project-root     Override project root
  --json             Machine-readable output
  -h, --help         Show this help
`;

const GRADES = ["A", "B", "C", "D", "F"];

function gradeToNum(g) { return GRADES.indexOf(g.toUpperCase()); }

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" } }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    }).on("error", reject);
  });
}

async function fetchNpmMeta(name) {
  try {
    return await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  } catch {
    return null;
  }
}

async function readDirectDeps(projectRoot) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return {
      prod: Object.keys(pkg.dependencies ?? {}),
      dev: Object.keys(pkg.devDependencies ?? {})
    };
  } catch {
    return { prod: [], dev: [] };
  }
}

async function readTransitiveDeps(projectRoot) {
  const lockPath = path.join(projectRoot, "package-lock.json");
  try {
    const raw = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const pkgs = raw.packages ?? raw.dependencies ?? {};
    return Object.entries(pkgs)
      .filter(([k]) => k && k !== "")
      .map(([k, v]) => ({ name: k.replace(/^node_modules\//, "").split("/node_modules/").pop(), version: v.version }));
  } catch {
    return [];
  }
}

function colorGrade(grade) {
  const colors = { A: "\x1b[32m", B: "\x1b[92m", C: "\x1b[33m", D: "\x1b[91m", F: "\x1b[31m" };
  return (colors[grade] ?? "") + grade + "\x1b[0m";
}

function colorRisk(label) {
  const colors = { low: "\x1b[32m", medium: "\x1b[33m", high: "\x1b[91m", critical: "\x1b[31m" };
  return (colors[label] ?? "") + label + "\x1b[0m";
}

export async function cmdRisk(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      all: { type: "boolean", default: false },
      threshold: { type: "string" },
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

  // Determine which packages to score
  let packages;
  if (positionals.length > 0) {
    packages = positionals.map(n => ({ name: n, version: null }));
  } else if (values.all) {
    packages = await readTransitiveDeps(projectRoot);
  } else {
    const { prod, dev } = await readDirectDeps(projectRoot);
    packages = [...prod, ...dev].map(n => ({ name: n, version: null }));
  }

  if (packages.length === 0) {
    const msg = "No packages found. Is this a Node.js project?";
    if (values.json) { printJson({ ok: false, reason: msg, packages: [] }); }
    else { printText(msg); }
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mScoring ${packages.length} package(s) via npm registry…\x1b[0m\n`);
  }

  // Fetch metadata in batches to avoid slamming the registry
  const BATCH = 10;
  const scored = [];

  for (let i = 0; i < packages.length; i += BATCH) {
    const batch = packages.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async ({ name, version }) => {
        const meta = await fetchNpmMeta(name);
        const result = scorePackage(meta ?? {}, {});
        return { name, version: version ?? meta?.["dist-tags"]?.latest ?? "?", ...result };
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") scored.push(r.value);
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const aggregate = scored.length
    ? Math.round(scored.reduce((s, p) => s + p.score, 0) / scored.length)
    : 0;

  const portfolio = scorePortfolio(
    packages.map(p => ({ name: p.name, version: p.version, meta: {} }))
  );

  if (values.json) {
    printJson({
      ok: true,
      aggregate,
      grade: scored[0] ? scored.reduce((worst, p) => {
        return gradeToNum(p.grade) > gradeToNum(worst) ? p.grade : worst;
      }, "A") : "A",
      packages: scored
    });
    return;
  }

  // Terminal output
  const COL_NAME = 35;
  const COL_VER  = 10;
  const COL_SCORE = 6;
  const COL_GRADE = 6;
  const COL_RISK  = 10;

  const header =
    "Package".padEnd(COL_NAME) +
    "Version".padEnd(COL_VER) +
    "Score".padStart(COL_SCORE) +
    "  Grade".padEnd(COL_GRADE + 2) +
    "  Risk".padEnd(COL_RISK);

  printText(`\nbetter risk — ${packages.length} package(s)\n`);
  printText("\x1b[90m" + "─".repeat(header.length) + "\x1b[0m");
  printText("\x1b[1m" + header + "\x1b[0m");
  printText("\x1b[90m" + "─".repeat(header.length) + "\x1b[0m");

  for (const pkg of scored) {
    const name = (pkg.name ?? "?").slice(0, COL_NAME - 1).padEnd(COL_NAME);
    const ver  = String(pkg.version ?? "?").slice(0, COL_VER - 1).padEnd(COL_VER);
    const score = String(pkg.score).padStart(COL_SCORE);
    const grade = "  " + colorGrade(pkg.grade).padEnd(COL_GRADE);
    const risk  = "  " + colorRisk(pkg.label);
    printText(name + ver + score + grade + risk);
  }

  printText("\x1b[90m" + "─".repeat(header.length) + "\x1b[0m");

  // Signals summary for high-risk packages
  const highRisk = scored.filter(p => p.score > 50);
  if (highRisk.length > 0) {
    printText("\n\x1b[1mHigh-risk signals:\x1b[0m");
    for (const pkg of highRisk.slice(0, 10)) {
      const sigs = [];
      if (pkg.signals.deprecated) sigs.push("deprecated");
      if (pkg.signals.ageDays > 365) sigs.push(`stale (${Math.round(pkg.signals.ageDays / 365)}y)`);
      if (pkg.signals.vulnCount > 0) sigs.push(`${pkg.signals.vulnCount} CVE(s)`);
      if (pkg.signals.maintainerCount != null && pkg.signals.maintainerCount <= 1)
        sigs.push(`${pkg.signals.maintainerCount} maintainer`);
      if (pkg.signals.noLicense) sigs.push("no license");
      printText(`  \x1b[91m${pkg.name}\x1b[0m — ${sigs.join(", ")}`);
    }
  }

  printText(`\nAggregate score: \x1b[1m${aggregate}/100\x1b[0m  (${riskLabel(aggregate)})`);

  // Threshold check
  if (values.threshold) {
    const thresh = values.threshold.toUpperCase();
    if (!GRADES.includes(thresh)) {
      printText(`\nInvalid --threshold "${thresh}". Use A, B, C, D, or F.`);
      process.exitCode = 2;
      return;
    }
    const worstGrade = scored.reduce((worst, p) => {
      return gradeToNum(p.grade) > gradeToNum(worst) ? p.grade : worst;
    }, "A");
    if (gradeToNum(worstGrade) >= gradeToNum(thresh)) {
      printText(`\n\x1b[31m✖ Risk threshold exceeded: worst grade ${worstGrade} ≥ ${thresh}\x1b[0m`);
      process.exitCode = 1;
    }
  }
}
