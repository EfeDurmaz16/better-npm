import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import { join } from "node:path";

// Known consolidation suggestions (mirrors Rust logic)
const CONSOLIDATIONS = [
  { primary: "moment", alts: ["date-fns", "dayjs", "luxon"], advice: "Use date-fns or dayjs (lighter alternatives)" },
  { primary: "lodash", alts: ["underscore", "ramda"], advice: "Lodash covers this; remove underscore/ramda" },
  { primary: "axios", alts: ["node-fetch", "got", "superagent"], advice: "Pick one HTTP client" },
  { primary: "jest", alts: ["mocha", "jasmine", "vitest"], advice: "Pick one test framework" },
];

const LIGHTER = [
  { heavy: "moment", lighter: "dayjs", reason: "dayjs is 2KB vs moment's 67KB" },
  { heavy: "lodash", lighter: "lodash-es", reason: "lodash-es is tree-shakeable" },
  { heavy: "request", lighter: "got", reason: "request is deprecated; use got or node-fetch" },
  { heavy: "uuid", lighter: "nanoid", reason: "nanoid is smaller and faster" },
];

const DEPRECATED = ["request", "node-uuid", "tslint", "bower", "grunt-cli", "jade", "stylus"];

export async function cmdAiReview(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage: better ai review [options]

AI-powered dependency review — suggests consolidations, lighter alternatives, removals.

Options:
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const useJson = runtime.json === true;
  const cwd = process.cwd();

  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(join(cwd, "package.json"), "utf8"));
  } catch {
    const msg = "No package.json found in current directory";
    if (useJson) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ];

  const suggestions = [];

  for (const { primary, alts, advice } of CONSOLIDATIONS) {
    if (allDeps.includes(primary)) {
      const found = alts.filter(a => allDeps.includes(a));
      if (found.length > 0) {
        suggestions.push({ category: "consolidate", severity: "medium", title: `Consolidate: ${primary} + ${found.join(", ")}`, description: advice, packages: [primary, ...found], action: `better why ${primary}` });
      }
    }
  }

  for (const { heavy, lighter, reason } of LIGHTER) {
    if (allDeps.includes(heavy)) {
      suggestions.push({ category: "downsize", severity: "low", title: `Consider ${lighter} instead of ${heavy}`, description: reason, packages: [heavy], action: `npm install ${lighter} && npm uninstall ${heavy}` });
    }
  }

  for (const dep of DEPRECATED) {
    if (allDeps.includes(dep)) {
      suggestions.push({ category: "remove", severity: "high", title: `${dep} is deprecated`, description: `${dep} has been deprecated. Find a modern replacement.`, packages: [dep], action: `better why ${dep}` });
    }
  }

  const score = Math.max(0, 100 - suggestions.length * 10);
  const result = {
    ok: true,
    kind: "better.ai.review",
    project: cwd.split("/").pop(),
    total_deps: allDeps.length,
    suggestions,
    overall_health: {
      score,
      dep_count_rating: allDeps.length < 10 ? "lean" : allDeps.length < 30 ? "moderate" : "heavy",
      security_rating: suggestions.some(s => s.category === "security") ? "issues found" : "clean",
    },
  };

  if (useJson) {
    printJson(result);
  } else {
    printText(`\nbetter — Dependency Review for ${result.project}\n`);
    printText(`Total dependencies: ${allDeps.length} (${result.overall_health.dep_count_rating})`);
    printText(`Health score: ${score}/100\n`);
    if (suggestions.length === 0) {
      printText("No suggestions — dependencies look good!");
    } else {
      for (const s of suggestions) {
        const icon = s.severity === "high" ? "!" : s.severity === "medium" ? "~" : "-";
        printText(`[${icon}] ${s.title}`);
        printText(`    ${s.description}`);
        printText(`    Action: ${s.action}\n`);
      }
    }
  }
}
