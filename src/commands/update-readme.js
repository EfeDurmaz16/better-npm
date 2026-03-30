/**
 * better update-readme — auto-update README badges and sections
 *
 * Updates dynamic sections in README.md: version badges, dependency
 * count, install size stats, and CI status from package.json data.
 *
 * Usage:
 *   better update-readme
 *   better update-readme --dry-run
 *   better update-readme --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function escapeShield(s) {
  return String(s || "").replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_");
}

function shieldsBadge(label, value, color, link) {
  const url = `https://img.shields.io/badge/${escapeShield(label)}-${escapeShield(value)}-${color}`;
  return link ? `[![${label}](${url})](${link})` : `![${label}](${url})`;
}

export async function cmdUpdateReadme(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:      { type: "boolean", default: runtime.json === true },
      help:      { type: "boolean", short: "h", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better update-readme [options]

Auto-update dynamic sections in README.md from package.json.

Options:
  --dry-run    Show changes without writing
  --json       Machine-readable output
  -h, --help   Show this help

Updates:
  • Version badge (from package.json version)
  • npm version badge
  • Dependency count badge
  • License badge
  • Node.js engine badge

Markers in README.md:
  <!-- better:badges --> ... <!-- /better:badges -->
  <!-- better:stats --> ... <!-- /better:stats -->
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

  // Find README
  let readmePath = null;
  for (const name of ["README.md", "readme.md", "Readme.md"]) {
    const p = path.join(projectRoot, name);
    try { await fs.access(p); readmePath = p; break; } catch {}
  }

  if (!readmePath) {
    const msg = "README.md not found";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  let readme = await fs.readFile(readmePath, "utf8");
  const original = readme;

  const name = pkgJson.name || "package";
  const version = pkgJson.version || "0.0.0";
  const license = pkgJson.license || "?";
  const nodeEngine = pkgJson.engines?.node || null;
  const depCount = Object.keys(pkgJson.dependencies || {}).length;
  const npmUrl = `https://www.npmjs.com/package/${name}`;

  // Build badges section
  const badges = [
    shieldsBadge("npm", `v${version}`, "red", npmUrl),
    shieldsBadge("license", license, "blue"),
    nodeEngine ? shieldsBadge("node", nodeEngine.replace(/[>=^~]/g, ""), "green") : null,
    shieldsBadge("deps", String(depCount), depCount > 50 ? "orange" : "brightgreen"),
  ].filter(Boolean);

  const badgesBlock = badges.join("  \n");

  // Build stats section
  const statsLines = [
    `**Version:** ${version}`,
    `**License:** ${license}`,
    `**Dependencies:** ${depCount}`,
    nodeEngine ? `**Node.js:** ${nodeEngine}` : null,
  ].filter(Boolean);
  const statsBlock = statsLines.join("  \n");

  let updated = readme;
  let changeCount = 0;

  // Replace <!-- better:badges --> sections
  const badgesRe = /<!-- better:badges -->[\s\S]*?<!-- \/better:badges -->/;
  const newBadgesSection = `<!-- better:badges -->\n${badgesBlock}\n<!-- /better:badges -->`;
  if (badgesRe.test(updated)) {
    const old = updated.match(badgesRe)[0];
    if (old !== newBadgesSection) { updated = updated.replace(badgesRe, newBadgesSection); changeCount++; }
  }

  // Replace <!-- better:stats --> sections
  const statsRe = /<!-- better:stats -->[\s\S]*?<!-- \/better:stats -->/;
  const newStatsSection = `<!-- better:stats -->\n${statsBlock}\n<!-- /better:stats -->`;
  if (statsRe.test(updated)) {
    const old = updated.match(statsRe)[0];
    if (old !== newStatsSection) { updated = updated.replace(statsRe, newStatsSection); changeCount++; }
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.update-readme",
      changed: changeCount > 0,
      dryRun: values["dry-run"],
      sections: changeCount,
      badges,
    });
    if (!values["dry-run"] && changeCount > 0) {
      await fs.writeFile(readmePath, updated, "utf8");
    }
    return;
  }

  printText(`\n\x1b[1mbetter update-readme\x1b[0m\n`);

  if (changeCount === 0 && updated === original) {
    if (!badgesRe.test(readme) && !statsRe.test(readme)) {
      printText(`  \x1b[33m⚠\x1b[0m  No <!-- better:badges --> or <!-- better:stats --> markers found in README.md`);
      printText(`  \x1b[90mAdd markers to README.md to enable auto-updates:\x1b[0m`);
      printText(`  \x1b[90m  <!-- better:badges --><!-- /better:badges -->\x1b[0m`);
      printText(`  \x1b[90m  <!-- better:stats --><!-- /better:stats -->\x1b[0m`);
    } else {
      printText(`\x1b[32m✔ README.md is already up to date.\x1b[0m`);
    }
  } else if (values["dry-run"]) {
    printText(`  Would update ${changeCount} section(s).\n`);
    printText(`  \x1b[1mNew badges:\x1b[0m\n  ${badgesBlock.replace(/\n/g, "\n  ")}`);
    printText(`\n  \x1b[90mRun without --dry-run to apply.\x1b[0m`);
  } else {
    await fs.writeFile(readmePath, updated, "utf8");
    printText(`\x1b[32m✔ Updated ${changeCount} section(s) in README.md\x1b[0m`);
  }
  printText("");
}
