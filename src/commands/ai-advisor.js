import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runAnalyzeOrgNapi } from "../lib/core.js";

/**
 * `better ai` — AI-powered dependency management
 *
 * Subcommands:
 *   advise              Get AI advice about your dependencies
 *   explain PKG         Explain what a package does and if you need it
 *   alternatives PKG    Find AI-ranked alternatives
 *   review             AI code review for dependency usage
 *   migrate            AI-assisted migration to better alternatives
 */
export async function cmdAi(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better ai <subcommand> [options]

AI-powered dependency management (requires ANTHROPIC_API_KEY or OPENAI_API_KEY).

Subcommands:
  advise              Analyze dependencies and suggest improvements
  explain PKG         Explain what a package does and whether you need it
  alternatives PKG    Find AI-ranked alternative packages
  review              Review dependency usage in your codebase
  migrate PKG [TO]    Get migration guide from one package to another
  provision INTENT    Natural language to OSP service selection and provisioning

Options:
  --model MODEL  AI model to use (default: claude-haiku-4-5)
  --json         Machine-readable output
  -h, --help     Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      model: { type: "string", default: "claude-haiku-4-5" },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const sub = positionals[0];
  const useJson = values.json || runtime.json === true;

  // review and org subcommands are rule-based and don't need an API key
  const LOCAL_SUBCOMMANDS = new Set(["review", "org"]);
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey && !LOCAL_SUBCOMMANDS.has(sub)) {
    const err = {
      ok: false,
      error: "AI features require ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable",
      docs: "Set ANTHROPIC_API_KEY to use Claude for dependency analysis"
    };
    if (useJson) { printJson(err); }
    else { printText("Error: Set ANTHROPIC_API_KEY to use AI features.\n  export ANTHROPIC_API_KEY=your-key"); }
    process.exitCode = 1;
    return;
  }

  const pkgPath = path.join(projectRoot, "package.json");
  let pkg = {};
  try { pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")); } catch {}

  switch (sub) {
    case "review": {
      // Static (rule-based) dependency review — no AI key required
      const { cmdAiReview } = await import("./ai-review.js");
      const reviewArgs = [...positionals.slice(1), ...(useJson ? ["--json"] : []), "--project-root", projectRoot];
      await cmdAiReview(reviewArgs);
      break;
    }
    case "org": {
      // Cross-project org-level dependency analysis — no AI key required
      const orgRoot = positionals[1] ? path.resolve(positionals[1]) : path.dirname(projectRoot);
      const orgResult = runAnalyzeOrgNapi(orgRoot);
      if (orgResult?.ok && orgResult.data) {
        const r = orgResult.data;
        const result = { ok: true, kind: "better.ai.org", ...r };
        if (useJson) { printJson(result); }
        else {
          printText(`\nbetter — Org-level analysis for ${orgRoot}\n`);
          printText(`Projects analyzed: ${r.projects_analyzed}`);
          printText(`Unique dependencies: ${r.total_unique_deps} (${r.total_dep_instances} total instances)`);
          printText(`Standardization score: ${r.standardization_score}/100`);
          if (r.version_inconsistencies?.length > 0) {
            printText(`\nVersion inconsistencies (${r.version_inconsistencies.length}):`);
            for (const v of r.version_inconsistencies.slice(0, 5)) {
              printText(`  ${v.package}: recommended ${v.recommended}`);
            }
          }
          if (r.consolidation_opportunities?.length > 0) {
            printText(`\nConsolidation opportunities (${r.consolidation_opportunities.length}):`);
            for (const c of r.consolidation_opportunities.slice(0, 5)) {
              printText(`  ${c.category}: ${c.packages.join(", ")} — ${c.reason}`);
            }
          }
        }
      } else {
        if (useJson) { printJson({ ok: true, kind: "better.ai.org", projects_analyzed: 0, message: "No projects found" }); }
        else { printText("No multi-project structure found in this directory."); }
      }
      break;
    }
    case "advise": {
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const depList = Object.entries(deps).map(([n, v]) => `${n}@${v}`).join(", ");

      if (!depList) {
        if (useJson) { printJson({ ok: true, advice: "No dependencies found" }); }
        else { printText("No dependencies to analyze."); }
        return;
      }

      if (!useJson) printText("Analyzing dependencies with AI...");

      const prompt = `You are a Node.js dependency expert. Analyze these dependencies and provide:
1. Any that are deprecated or unmaintained
2. Better alternatives for heavy/problematic packages
3. Security concerns
4. Bundle size concerns

Dependencies: ${depList}

Respond in JSON: {"issues": [{"package": "...", "type": "deprecated|heavy|security|unmaintained", "reason": "...", "suggestion": "..."}], "summary": "..."}`;

      const advice = await callAI(apiKey, values.model, prompt);
      const result = { ok: true, kind: "better.ai.advise", ...advice };
      if (useJson) { printJson(result); }
      else {
        printText(advice.summary || "Analysis complete.");
        if (advice.issues?.length > 0) {
          printText("\nIssues found:");
          for (const issue of advice.issues) {
            printText(`  ${issue.package}: ${issue.reason}${issue.suggestion ? ` → Use ${issue.suggestion}` : ""}`);
          }
        }
      }
      break;
    }

    case "explain": {
      const pkgName = positionals[1];
      if (!pkgName) { printText("Error: package name required"); process.exitCode = 1; return; }

      const prompt = `Explain the npm package "${pkgName}" in 2-3 sentences: what it does, when you'd use it, and any notable alternatives. Be concise. Respond as JSON: {"description": "...", "useCase": "...", "alternatives": ["..."]}`;

      const explanation = await callAI(apiKey, values.model, prompt);
      const result = { ok: true, kind: "better.ai.explain", package: pkgName, ...explanation };
      if (useJson) { printJson(result); }
      else {
        printText(`${pkgName}: ${explanation.description || "No description available"}`);
        if (explanation.alternatives?.length > 0) {
          printText(`Alternatives: ${explanation.alternatives.join(", ")}`);
        }
      }
      break;
    }

    case "alternatives": {
      const pkgName = positionals[1];
      if (!pkgName) { printText("Error: package name required"); process.exitCode = 1; return; }

      const currentSpec = pkg.dependencies?.[pkgName] || pkg.devDependencies?.[pkgName] || "unknown";
      const prompt = `List the top 5 npm alternatives to "${pkgName}" (currently ${currentSpec}). Rank by: smaller bundle size, better maintenance, more features, or better API. Respond as JSON: {"alternatives": [{"name": "...", "reason": "...", "weeklyDownloads": N, "pros": ["..."], "cons": ["..."]}]}`;

      const alts = await callAI(apiKey, values.model, prompt);
      const result = { ok: true, kind: "better.ai.alternatives", package: pkgName, ...alts };
      if (useJson) { printJson(result); }
      else {
        printText(`Alternatives to ${pkgName}:`);
        for (const alt of (alts.alternatives || [])) {
          printText(`  ${alt.name}: ${alt.reason}`);
        }
      }
      break;
    }

    case "migrate": {
      const [, fromPkg, toPkg] = positionals;
      if (!fromPkg) { printText("Error: source package required"); process.exitCode = 1; return; }

      const prompt = `Provide a migration guide from "${fromPkg}" to "${toPkg || "its modern alternative"}". Include: breaking changes, API differences, code examples. Respond as JSON: {"from": "...", "to": "...", "steps": ["..."], "codeChanges": [{"before": "...", "after": "..."}], "breakingChanges": ["..."]}`;

      const guide = await callAI(apiKey, values.model, prompt);
      const result = { ok: true, kind: "better.ai.migrate", ...guide };
      if (useJson) { printJson(result); }
      else {
        printText(`Migration: ${guide.from || fromPkg} → ${guide.to || toPkg || "alternative"}`);
        if (guide.steps?.length > 0) {
          for (const step of guide.steps) printText(`  • ${step}`);
        }
      }
      break;
    }

    case "provision": {
      // Natural language to OSP service selection — Task 123
      const [, ...intentWords] = positionals;
      const intent = intentWords.join(" ") || "I need cloud services for my project";

      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const framework = allDeps.next ? "Next.js" : allDeps.react ? "React" : allDeps.express ? "Express" : allDeps.fastify ? "Fastify" : allDeps.nuxt ? "Nuxt" : "Node.js";

      const prompt = `You are an infrastructure advisor for OSP (Open Service Protocol).
User wants: "${intent}"
Project uses: ${framework}, ${Object.keys(allDeps).slice(0, 10).join(", ")}

Recommend the best OSP services. Respond as JSON with this structure:
{"recommended_services": [{"provider": "...", "service": "...", "tier": "free", "reason": "...", "monthly_cost_usd": 0, "alternatives": [{"provider": "...", "service": "...", "monthly_cost_usd": 0, "tradeoff": "..."}]}], "setup_steps": [{"step": 1, "action": "provision", "command": "better provision provider/service --tier free", "generates": [".env"]}], "estimated_monthly_cost": 0}`;

      const plan = await callAI(apiKey, values.model, prompt);
      const result = { ok: true, kind: "better.ai.provision", intent, ...plan };
      if (useJson) { printJson(result); }
      else {
        printText(`Provisioning plan for: "${intent}"\n`);
        for (const svc of plan.recommended_services || []) {
          printText(`  ✓ ${svc.provider}/${svc.service} (${svc.tier}) — $${svc.monthly_cost_usd}/mo`);
          printText(`    ${svc.reason}`);
        }
        printText(`\nEstimated cost: $${plan.estimated_monthly_cost ?? 0}/mo`);
        if (!useJson) printText("\nRun with --json for full plan, or use 'better infra install' to provision.");
      }
      break;
    }

    default:
      printText(`Unknown subcommand: ${sub}. Run 'better ai --help' for usage.`);
      process.exitCode = 1;
  }
}

async function callAI(apiKey, model, prompt) {
  const isAnthropic = apiKey.startsWith("sk-ant-");

  try {
    let resp, data;

    if (isAnthropic) {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      data = await resp.json();
      const text = data.content?.[0]?.text || "{}";
      return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
    } else {
      // OpenAI
      resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        }),
      });
      data = await resp.json();
      const text = data.choices?.[0]?.message?.content || "{}";
      return JSON.parse(text);
    }
  } catch (err) {
    return { error: err.message, summary: "AI analysis failed" };
  }
}
