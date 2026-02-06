import { analyzeProject } from "../analyze/analyzeProject.js";
import { findBetterCore, runBetterCoreAnalyze } from "./core.js";

export async function analyzeWithBestEngine(projectRoot, opts = {}) {
  const { includeGraph = true, coreMode = "auto" } = opts;
  // coreMode: "auto" | "force" | "off"
  if (coreMode !== "off") {
    const corePath = await findBetterCore();
    if (corePath) {
      try {
        const analysis = await runBetterCoreAnalyze(corePath, projectRoot, { includeGraph });
        return { analysis, engine: "core", corePath };
      } catch (err) {
        if (coreMode === "force") throw err;
        // fall through to JS
      }
    } else if (coreMode === "force") {
      throw new Error("better-core not found (set BETTER_CORE_PATH or build via `npm run core:build`)");
    }
  }

  const analysis = await analyzeProject(projectRoot, { includeGraph });
  return { analysis, engine: "js", corePath: null };
}
