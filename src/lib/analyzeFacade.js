import { analyzeProject } from "../analyze/analyzeProject.js";
import { findBetterCore, runBetterCoreAnalyze, tryLoadNapiAddon, runBetterCoreAnalyzeNapi } from "./core.js";

export async function analyzeWithBestEngine(projectRoot, opts = {}) {
  const { includeGraph = true, coreMode = "auto" } = opts;
  // coreMode: "auto" | "napi" | "force" | "off"

  // Try napi first (for "auto" or "napi" mode)
  if (coreMode === "napi" || coreMode === "auto") {
    const addon = tryLoadNapiAddon();
    if (addon) {
      try {
        const analysis = runBetterCoreAnalyzeNapi(projectRoot, { includeGraph });
        return { analysis, engine: "napi", corePath: null };
      } catch (err) {
        if (coreMode === "napi") throw err;
        // fall through to binary/JS
      }
    } else if (coreMode === "napi") {
      throw new Error("napi addon not found (build via `npm run napi:build`)");
    }
  }

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
