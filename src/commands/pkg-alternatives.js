/**
 * better pkg-alternatives — find alternative packages to a dependency
 *
 * Searches for popular alternatives to an npm package based on
 * keywords, category, and community recommendations.
 *
 * Usage:
 *   better pkg-alternatives lodash
 *   better pkg-alternatives moment
 *   better pkg-alternatives express --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "better-npm/1.0" }, timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location));
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function fmtNum(n) {
  if (!n) return "?";
  if (n >= 1e9) return `${(n/1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n/1e3).toFixed(0)}K`;
  return String(n);
}

// Curated alternatives knowledge base
const KNOWN_ALTERNATIVES = {
  "lodash": ["ramda", "just-clone", "native-lodash", "remeda"],
  "moment": ["date-fns", "dayjs", "luxon", "tempo"],
  "request": ["axios", "got", "node-fetch", "undici", "ky"],
  "express": ["fastify", "koa", "hono", "h3", "polka"],
  "jquery": ["vanilla-js", "cash-dom", "umbrellajs"],
  "webpack": ["esbuild", "vite", "rollup", "parcel", "turbopack"],
  "babel": ["swc", "esbuild", "oxc"],
  "jest": ["vitest", "mocha", "ava", "jasmine", "uvu"],
  "eslint": ["biome", "oxlint"],
  "prettier": ["biome", "dprint"],
  "gulp": ["npm-run-all2", "npm scripts"],
  "grunt": ["npm scripts", "just-task"],
  "underscore": ["lodash", "remeda"],
  "async": ["bluebird", "promise-all-settled", "native Promises"],
  "bluebird": ["native Promises", "p-map", "p-limit"],
  "chalk": ["picocolors", "kleur", "kolorist", "ansis"],
  "colors": ["chalk", "picocolors", "kleur"],
  "uuid": ["nanoid", "cuid2", "crypto.randomUUID()"],
  "rimraf": ["del", "native fs.rm()"],
  "mkdirp": ["make-dir", "native fs.mkdir({ recursive: true })"],
  "glob": ["fast-glob", "tinyglobby", "picomatch"],
  "minimist": ["yargs", "commander", "meow", "cac"],
  "commander": ["yargs", "meow", "cac", "citty"],
  "yargs": ["commander", "meow", "cac", "citty"],
  "mongoose": ["prisma", "drizzle-orm", "mikro-orm"],
  "sequelize": ["prisma", "drizzle-orm", "knex"],
  "passport": ["lucia-auth", "better-auth", "arctic"],
  "jsonwebtoken": ["jose", "@auth/core"],
  "bcrypt": ["bcryptjs", "argon2", "@node-rs/bcrypt"],
  "dotenv": ["native import.meta.env", "@t3-oss/env-core"],
  "cross-env": ["native process.env", "env-cmd"],
  "nodemon": ["tsx --watch", "ts-node-dev", "bun --watch"],
  "ts-node": ["tsx", "jiti", "bun"],
  "typescript": ["swc", "esbuild (transpile only)"],
};

export async function cmdPkgAlternatives(argv) {
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
    printText(`Usage: better pkg-alternatives <package> [options]

Find alternative packages to a given npm dependency.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Shows:
  • Curated list of known alternatives
  • Weekly download comparison
  • Registry search results for related packages

Examples:
  better pkg-alternatives lodash
  better pkg-alternatives moment
  better pkg-alternatives express
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better pkg-alternatives <package>\nRun: better pkg-alternatives --help for more info.");
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];

  if (!values.json) {
    printText(`\n\x1b[1mbetter pkg-alternatives\x1b[0m — alternatives to \x1b[1m${pkgName}\x1b[0m\n`);
    process.stderr.write(`\x1b[90mFetching package info and alternatives...\x1b[0m\n`);
  }

  // Get original package info
  let originalMeta = null;
  let weeklyDownloads = null;
  try {
    const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`);
    if (res.status === 200) originalMeta = JSON.parse(res.body);
    const dlRes = await httpsGet(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkgName)}`);
    if (dlRes.status === 200) weeklyDownloads = JSON.parse(dlRes.body).downloads || null;
  } catch {}

  const knownAlts = KNOWN_ALTERNATIVES[pkgName] || [];

  // Also search npm registry for related packages via keywords
  let searchResults = [];
  try {
    const keywords = originalMeta?.keywords?.slice(0, 3) || [];
    const query = keywords.length > 0 ? keywords.join("+") : pkgName;
    const res = await httpsGet(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=10`);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      searchResults = (data.objects || [])
        .map(o => o.package)
        .filter(p => p.name !== pkgName)
        .slice(0, 5);
    }
  } catch {}

  // Fetch download counts for known alternatives
  const altDetails = await Promise.all(knownAlts.filter(a => !a.includes(" ")).map(async (alt) => {
    try {
      const dlRes = await httpsGet(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(alt)}`);
      const downloads = dlRes.status === 200 ? JSON.parse(dlRes.body).downloads || 0 : 0;
      return { name: alt, downloads };
    } catch {
      return { name: alt, downloads: 0 };
    }
  }));
  altDetails.sort((a, b) => b.downloads - a.downloads);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.pkg-alternatives",
      package: pkgName,
      weeklyDownloads,
      knownAlternatives: knownAlts,
      alternativeDetails: altDetails,
      searchResults: searchResults.map(r => ({ name: r.name, description: r.description, version: r.version })),
    });
    return;
  }

  if (originalMeta) {
    printText(`  ${pkgName}@${originalMeta.version}  \x1b[90m${originalMeta.description || ""}\x1b[0m`);
    printText(`  Downloads: ${fmtNum(weeklyDownloads)}/week\n`);
  }

  if (knownAlts.length > 0) {
    printText(`\x1b[1mCurated alternatives:\x1b[0m`);
    for (const alt of knownAlts) {
      const detail = altDetails.find(a => a.name === alt);
      const dlStr = detail ? `  \x1b[90m${fmtNum(detail.downloads)}/wk\x1b[0m` : "";
      if (alt.includes(" ") || alt.startsWith("native")) {
        printText(`  \x1b[90m·\x1b[0m  \x1b[3m${alt}\x1b[0m  \x1b[90m(built-in)\x1b[0m`);
      } else {
        printText(`  \x1b[32m→\x1b[0m  ${alt}${dlStr}`);
      }
    }
    printText("");
  } else {
    printText(`  \x1b[90mNo curated alternatives in database for this package.\x1b[0m\n`);
  }

  if (searchResults.length > 0) {
    printText(`\x1b[1mRelated packages (npm search):\x1b[0m`);
    for (const r of searchResults) {
      printText(`  \x1b[90m·\x1b[0m  \x1b[1m${r.name}\x1b[0m@${r.version || "?"}  \x1b[90m${(r.description || "").slice(0, 60)}\x1b[0m`);
    }
  }
  printText("");
}
