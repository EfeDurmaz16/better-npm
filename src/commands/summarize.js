/**
 * better summarize — AI-powered project summary
 *
 * Generates a concise, human-readable summary of the project's
 * dependencies, structure, purpose, and health status.
 * Useful for onboarding, code reviews, or documentation.
 *
 * Usage:
 *   better summarize
 *   better summarize --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Map of common frameworks/tools to their category
const FRAMEWORK_MAP = {
  // Frontend frameworks
  "react": "React app",
  "vue": "Vue.js app",
  "angular": "@angular/core",
  "svelte": "Svelte app",
  "next": "Next.js app",
  "nuxt": "Nuxt.js app",
  "remix": "Remix app",
  "gatsby": "Gatsby site",

  // Backend frameworks
  "express": "Express.js server",
  "fastify": "Fastify server",
  "hono": "Hono server",
  "koa": "Koa server",
  "nestjs": "@nestjs/core",

  // Build tools
  "vite": "Vite",
  "webpack": "Webpack",
  "rollup": "Rollup",
  "parcel": "Parcel",
  "esbuild": "esbuild",
  "tsup": "tsup",

  // Testing
  "jest": "Jest",
  "vitest": "Vitest",
  "mocha": "Mocha",
  "cypress": "Cypress",
  "playwright": "@playwright/test",

  // ORMs / DB
  "prisma": "Prisma ORM",
  "typeorm": "TypeORM",
  "mongoose": "Mongoose/MongoDB",
  "knex": "Knex.js",
  "drizzle-orm": "Drizzle ORM",

  // Languages
  "typescript": "TypeScript",
};

function detectFrameworks(deps) {
  const found = [];
  for (const [key, label] of Object.entries(FRAMEWORK_MAP)) {
    if (deps[key] || deps[label]) {
      found.push(key === label ? key : key);
    }
  }
  return found;
}

function getProjectType(frameworks, pkgJson) {
  const hasBin = Boolean(pkgJson.bin);
  const hasMain = Boolean(pkgJson.main || pkgJson.exports);
  const isPrivate = pkgJson.private === true;

  if (frameworks.includes("next") || frameworks.includes("nuxt") || frameworks.includes("gatsby") || frameworks.includes("remix")) return "full-stack web app";
  if (frameworks.includes("react") && !hasMain) return "React frontend app";
  if (frameworks.includes("vue")) return "Vue.js frontend app";
  if (frameworks.includes("svelte")) return "Svelte frontend app";
  if (frameworks.includes("express") || frameworks.includes("fastify") || frameworks.includes("hono") || frameworks.includes("koa")) return "Node.js web server";
  if (hasBin && !hasMain) return "CLI tool";
  if (hasMain && !isPrivate) return "npm library";
  if (hasBin && hasMain) return "CLI tool / library";
  return "Node.js project";
}

export async function cmdSummarize(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better summarize [options]

Generate a human-readable summary of your project's dependencies
and structure for documentation or onboarding.

Options:
  --json       Machine-readable output
  -h, --help   Show this help
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

  const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
  const prodDeps = pkgJson.dependencies || {};
  const devDeps = pkgJson.devDependencies || {};

  const frameworks = detectFrameworks(allDeps);
  const projectType = getProjectType(frameworks, pkgJson);
  const usesTypeScript = Boolean(allDeps.typescript);
  const hasBin = Boolean(pkgJson.bin);
  const hasTests = Boolean(pkgJson.scripts?.test && !pkgJson.scripts.test.startsWith("echo"));
  const hasCI = await fs.access(path.join(projectRoot, ".github/workflows")).then(() => true).catch(async () => {
    return await fs.access(path.join(projectRoot, ".travis.yml")).then(() => true).catch(() => false);
  });

  const license = pkgJson.license || "unspecified";
  const prodCount = Object.keys(prodDeps).length;
  const devCount = Object.keys(devDeps).length;
  const nodeVersion = pkgJson.engines?.node || "unspecified";

  // Count scripts
  const scriptCount = Object.keys(pkgJson.scripts || {}).length;
  const scriptNames = Object.keys(pkgJson.scripts || {}).join(", ");

  // Detect test framework
  const testFramework = frameworks.includes("jest") ? "Jest" :
    frameworks.includes("vitest") ? "Vitest" :
    frameworks.includes("mocha") ? "Mocha" :
    frameworks.includes("cypress") ? "Cypress" :
    frameworks.includes("playwright") ? "Playwright" : null;

  // Generate summary text
  const name = pkgJson.name || path.basename(projectRoot);
  const version = pkgJson.version || "0.0.0";
  const description = pkgJson.description || "";

  const summaryLines = [
    `**${name}** v${version}${description ? ` — ${description}` : ""}`,
    "",
    `**Type:** ${projectType}`,
    `**Language:** ${usesTypeScript ? "TypeScript" : "JavaScript"}`,
    `**License:** ${license}`,
    `**Node.js:** ${nodeVersion}`,
    "",
    `**Dependencies:** ${prodCount} production, ${devCount} development`,
  ];

  if (frameworks.length > 0) {
    summaryLines.push(`**Key frameworks:** ${frameworks.slice(0, 6).join(", ")}`);
  }

  if (testFramework) {
    summaryLines.push(`**Testing:** ${testFramework}${hasTests ? " (configured)" : " (detected but no test script)"}`);
  } else {
    summaryLines.push(`**Testing:** ${hasTests ? "configured (unknown framework)" : "not configured"}`);
  }

  summaryLines.push(`**CI/CD:** ${hasCI ? "configured" : "not configured"}`);
  summaryLines.push(`**Scripts:** ${scriptCount} (${scriptNames.slice(0, 60)}${scriptNames.length > 60 ? "…" : ""})`);

  if (pkgJson.keywords?.length > 0) {
    summaryLines.push(`**Keywords:** ${pkgJson.keywords.slice(0, 8).join(", ")}`);
  }

  if (pkgJson.repository) {
    const repoUrl = typeof pkgJson.repository === "string"
      ? pkgJson.repository
      : pkgJson.repository.url || "";
    if (repoUrl) summaryLines.push(`**Repository:** ${repoUrl.replace(/^git\+/, "").replace(/\.git$/, "")}`);
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.summarize",
      name,
      version,
      description,
      projectType,
      language: usesTypeScript ? "TypeScript" : "JavaScript",
      license,
      nodeVersion,
      prodDeps: prodCount,
      devDeps: devCount,
      frameworks,
      testFramework,
      hasTests,
      hasCI,
      summary: summaryLines.filter(l => l).join("\n"),
    });
    return;
  }

  printText(`\n\x1b[1mbetter summarize — ${name}\x1b[0m\n`);
  for (const line of summaryLines) {
    if (!line) { printText(""); continue; }
    // Convert **bold** to ANSI bold
    const formatted = line.replace(/\*\*([^*]+)\*\*/g, "\x1b[1m$1\x1b[0m");
    printText(formatted);
  }
  printText("");
}
