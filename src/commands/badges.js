/**
 * better badges — generate README badges for your project
 *
 * Generates Shields.io badge markdown for npm version, downloads,
 * license, node version, and other package metrics.
 *
 * Usage:
 *   better badges
 *   better badges --format html
 *   better badges --write README.md
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function shieldsBadge(label, message, color, link) {
  const encoded = encodeURIComponent(message).replace(/%20/g, "_");
  const labelEnc = encodeURIComponent(label).replace(/%20/g, "_");
  const url = `https://img.shields.io/badge/${labelEnc}-${encoded}-${color}`;
  const img = `![${label}](${url})`;
  return link ? `[${img}](${link})` : img;
}

function npmBadge(type, pkgName) {
  const encoded = encodeURIComponent(pkgName);
  const url = `https://img.shields.io/npm/${type}/${encoded}`;
  const imgTag = `![npm ${type}](${url})`;
  const npmLink = `https://www.npmjs.com/package/${pkgName}`;
  return `[${imgTag}](${npmLink})`;
}

function nodeBadge(engine) {
  if (!engine) return null;
  const ver = String(engine).replace(/[>=<^~\s]/g, "").split(".")[0];
  return shieldsBadge("node", `>=${ver}`, "brightgreen", "https://nodejs.org");
}

function licenseBadge(license, pkgName) {
  if (!license) return null;
  const color = license.startsWith("MIT") ? "blue"
    : license.startsWith("Apache") ? "orange"
    : license.startsWith("GPL") ? "red"
    : license.startsWith("ISC") ? "blue"
    : "lightgrey";
  return `[![License: ${license}](https://img.shields.io/badge/License-${encodeURIComponent(license)}-${color}.svg)](https://opensource.org/licenses/${license})`;
}

export async function cmdBadges(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      format: { type: "string", default: "markdown" },
      write:  { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better badges [options]

Generate Shields.io badges for your package.json.

Options:
  --format <fmt>   Output format: markdown (default), html, json
  --write <file>   Append badges to a file (e.g. README.md)
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better badges
  better badges --format html
  better badges --write README.md
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

  const name = pkgJson.name;
  const isPrivate = pkgJson.private;

  if (!name) {
    printText(`\x1b[31mpackage.json missing "name" field\x1b[0m`);
    process.exitCode = 1;
    return;
  }

  const badges = [];

  if (!isPrivate) {
    badges.push({ id: "npm-version",   label: "npm version",   markdown: npmBadge("v", name) });
    badges.push({ id: "npm-downloads", label: "weekly downloads", markdown: npmBadge("dw", name) });
  }

  if (pkgJson.license) {
    const lb = licenseBadge(pkgJson.license, name);
    if (lb) badges.push({ id: "license", label: "license", markdown: lb });
  }

  const nodeEngine = pkgJson.engines?.node;
  if (nodeEngine) {
    const nb = nodeBadge(nodeEngine);
    if (nb) badges.push({ id: "node", label: "node", markdown: nb });
  }

  // TypeScript badge
  if (pkgJson.types || pkgJson.typings) {
    badges.push({
      id: "typescript",
      label: "typescript",
      markdown: shieldsBadge("TypeScript", "yes", "blue", "https://www.typescriptlang.org"),
    });
  }

  // GitHub Actions CI badge
  const ghRepo = pkgJson.repository?.url?.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:$|\/)/)?.[1];
  if (ghRepo) {
    const ciUrl = `https://github.com/${ghRepo}/actions`;
    const ciBadge = `[![CI](https://github.com/${ghRepo}/workflows/CI/badge.svg)](${ciUrl})`;
    badges.push({ id: "ci", label: "CI", markdown: ciBadge });
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.badges",
      package: name,
      badges: badges.map(b => ({ id: b.id, label: b.label, markdown: b.markdown })),
    });
    return;
  }

  if (badges.length === 0) {
    printText(`\x1b[33m⚠ No badges to generate (private package or missing fields).\x1b[0m`);
    return;
  }

  const mdLine = badges.map(b => b.markdown).join(" ");
  const htmlLine = badges.map(b =>
    b.markdown
      .replace(/\[!\[([^\]]+)\]\(([^)]+)\)\]\(([^)]+)\)/g, `<a href="$3"><img src="$2" alt="$1"></a>`)
      .replace(/!\[([^\]]+)\]\(([^)]+)\)/g, `<img src="$2" alt="$1">`)
  ).join("\n");

  printText(`\n\x1b[1mbetter badges\x1b[0m — ${badges.length} badge(s) for ${name}\n`);

  if (values.format === "html") {
    printText(htmlLine);
  } else {
    printText(mdLine);
  }

  printText("");

  if (values.write) {
    const writePath = path.isAbsolute(values.write)
      ? values.write
      : path.join(projectRoot, values.write);

    let existing = "";
    try { existing = await fs.readFile(writePath, "utf8"); } catch {}

    // Check if badges already present
    if (existing.includes("img.shields.io")) {
      printText(`\x1b[33m⚠ ${values.write} already contains badges — not overwriting.\x1b[0m`);
      printText(`\x1b[90mPaste the badges above manually.\x1b[0m`);
    } else {
      const updated = `${mdLine}\n\n${existing}`;
      await fs.writeFile(writePath, updated, "utf8");
      printText(`\x1b[32m✔ Badges prepended to ${values.write}\x1b[0m`);
    }
  }
}
