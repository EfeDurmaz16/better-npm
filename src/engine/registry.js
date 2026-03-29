/**
 * Engine registry bootstrap.
 *
 * Import this module once at startup to register all built-in engines.
 * Then use getEngine(name) from ./interface.js to retrieve an instance.
 *
 * Example:
 *   import "./engine/registry.js";
 *   import { getEngine } from "./engine/interface.js";
 *   const engine = await getEngine("npm");
 */
import { registerEngine } from "./interface.js";

registerEngine("npm",    () => import("./npm.js").then(m => new m.NpmEngine()));
registerEngine("pnpm",   () => import("./pnpm.js").then(m => new m.PnpmEngine()));
registerEngine("yarn",   () => import("./yarn.js").then(m => new m.YarnEngine()));
registerEngine("better", () => import("./betterEngine.js").then(m => new m.BetterEngine()));
