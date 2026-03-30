/**
 * better migrate — help with major version migration
 *
 * Detects packages with available major updates and provides
 * migration guidance, breaking change summaries, and
 * codemods if available.
 *
 * Usage:
 *   better migrate
 *   better migrate react
 *   better migrate --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Known migration resources for popular packages
const MIGRATION_GUIDES = {
  "react": {
    guides: {
      "18": "https://react.dev/blog/2022/03/08/react-18-upgrade-guide",
      "17": "https://legacy.reactjs.org/blog/2020/08/10/react-v17-rc.html",
    },
    codemods: "npx react-codemod@latest",
  },
  "next": {
    guides: {
      "14": "https://nextjs.org/docs/pages/building-your-application/upgrading/version-14",
      "13": "https://nextjs.org/docs/pages/building-your-application/upgrading/version-13",
    },
    codemods: "npx @next/codemod@latest",
  },
  "vue": {
    guides: {
      "3": "https://v3-migration.vuejs.org/",
    },
    codemods: "npx @vue/compat",
  },
  "@angular/core": {
    guides: {},
    codemods: "npx ng update",
  },
  "eslint": {
    guides: {
      "9": "https://eslint.org/docs/latest/use/migrate-to-9.0.0",
    },
  },
  "jest": {
    guides: {
      "29": "https://jestjs.io/docs/upgrading-to-jest29",
      "28": "https://jestjs.io/docs/upgrading-to-jest28",
    },
  },
  "webpack": {
    guides: {
      "5": "https://webpack.js.org/migrate/5/",
    },
  },
  "typescript": {
    guides: {
      "5": "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html",
    },
  },
  "express": {
    guides: {
      "5": "https://expressjs.com/en/guide/migrating-5.html",
    },
  },
};

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

function parseMajor(version) {
  return parseInt(String(version).replace(/^[~^>=v]/, "").split(".")[0]) || 0;
}

export async function cmdMigrate(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better migrate [packages...] [options]

Get migration guidance for packages with major version updates.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better migrate
  better migrate react next
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

  const nmPath = path.join(projectRoot, "node_modules");
  const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };

  const targets = positionals.length > 0
    ? positionals
    : Object.keys(allDeps);

  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking for major updates in ${targets.length} package(s)…\x1b[0m\n`);
  }

  const BATCH = 8;
  const results = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (name) => {
      let installedVersion = null;
      try {
        const depPkg = JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
        installedVersion = depPkg.version;
      } catch {}

      const latestVersion = await fetchLatestVersion(name);
      if (!latestVersion || !installedVersion) return null;

      const installedMajor = parseMajor(installedVersion);
      const latestMajor = parseMajor(latestVersion);

      if (latestMajor <= installedMajor) return null;

      const guide = MIGRATION_GUIDES[name];
      const guideUrl = guide?.guides?.[String(latestMajor)];
      const codemod = guide?.codemods;

      return {
        name,
        installedVersion,
        latestVersion,
        majorsBehind: latestMajor - installedMajor,
        guideUrl,
        codemod,
      };
    }));

    results.push(...batchResults.filter(Boolean));
  }

  results.sort((a, b) => b.majorsBehind - a.majorsBehind);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.migrate",
      totalChecked: targets.length,
      needsMigration: results.length,
      migrations: results,
    });
    return;
  }

  printText(`\n\x1b[1mbetter migrate\x1b[0m — ${targets.length} packages checked\n`);

  if (results.length === 0) {
    printText(`\x1b[32m✔ No major version updates available.\x1b[0m`);
    return;
  }

  printText(`\x1b[33m${results.length} package(s) have major version updates:\x1b[0m\n`);

  for (const r of results) {
    const behind = r.majorsBehind > 1 ? `\x1b[31m${r.majorsBehind} major versions behind\x1b[0m` : "\x1b[33m1 major version behind\x1b[0m";
    printText(`  \x1b[1m${r.name}\x1b[0m  ${r.installedVersion} → \x1b[33m${r.latestVersion}\x1b[0m  ${behind}`);

    if (r.guideUrl) {
      printText(`    \x1b[90mMigration guide: ${r.guideUrl}\x1b[0m`);
    }
    if (r.codemod) {
      printText(`    \x1b[90mCodemod: ${r.codemod}\x1b[0m`);
    }
    if (!r.guideUrl && !r.codemod) {
      const major = parseMajor(r.latestVersion);
      printText(`    \x1b[90mCheck the CHANGELOG for v${major} breaking changes\x1b[0m`);
    }
    printText("");
  }

  printText(`\x1b[90mRun: better update — to update to latest compatible versions\x1b[0m`);
}
