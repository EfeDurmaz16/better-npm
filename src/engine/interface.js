/**
 * Engine trait (abstract interface) for better's pluggable install backends.
 *
 * All concrete engines extend EngineBase and implement:
 *   - resolve(projectRoot, opts) → ResolutionPlan
 *   - install(projectRoot, plan, opts) → InstallResult
 *   - verify(projectRoot, opts) → VerifyResult
 *
 * Engine implementations live alongside this file:
 *   - NpmEngine   (src/engine/npm.js)
 *   - PnpmEngine  (src/engine/pnpm.js)
 *   - YarnEngine  (src/engine/yarn.js)
 *   - BetterEngine (src/engine/better/index.js)
 */

/**
 * @typedef {Object} ResolutionPlan
 * @property {boolean} ok
 * @property {string} lockfile          - resolved lockfile path
 * @property {number} packageCount      - estimated package count
 * @property {string} [reason]          - if ok=false, why
 */

/**
 * @typedef {Object} InstallResult
 * @property {boolean} ok
 * @property {number} wallTimeMs
 * @property {number} exitCode
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} [reason]          - if ok=false, why
 */

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} ok
 * @property {string[]} errors
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} EngineOptions
 * @property {boolean} [frozen]          - enforce frozen lockfile
 * @property {boolean} [production]      - omit devDependencies
 * @property {string[]} [passthrough]    - extra args forwarded to underlying CLI
 * @property {Object}  [env]             - environment variables
 * @property {string}  [logLevel]        - debug|info|warn|error|silent
 * @property {boolean} [json]            - suppress all non-JSON output
 */

export class EngineBase {
  /** @type {string} */
  get name() {
    throw new Error(`${this.constructor.name} must implement get name()`);
  }

  /**
   * Resolve the dependency graph and return a plan.
   * Should NOT write to node_modules.
   *
   * @param {string} projectRoot
   * @param {EngineOptions} [opts]
   * @returns {Promise<ResolutionPlan>}
   */
  // eslint-disable-next-line no-unused-vars
  async resolve(projectRoot, opts = {}) {
    throw new Error(`${this.constructor.name} must implement resolve()`);
  }

  /**
   * Materialise the resolved plan into node_modules.
   *
   * @param {string} projectRoot
   * @param {ResolutionPlan} plan
   * @param {EngineOptions} [opts]
   * @returns {Promise<InstallResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async install(projectRoot, plan, opts = {}) {
    throw new Error(`${this.constructor.name} must implement install()`);
  }

  /**
   * Verify the integrity of the current node_modules against the lockfile.
   *
   * @param {string} projectRoot
   * @param {EngineOptions} [opts]
   * @returns {Promise<VerifyResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async verify(projectRoot, opts = {}) {
    throw new Error(`${this.constructor.name} must implement verify()`);
  }

  /**
   * Build the CLI command + args for this engine.
   * Used by engines that delegate to an external process.
   *
   * @param {string} projectRoot
   * @param {EngineOptions} [opts]
   * @returns {{ cmd: string, args: string[] }}
   */
  // eslint-disable-next-line no-unused-vars
  buildCommand(projectRoot, opts = {}) {
    throw new Error(`${this.constructor.name} must implement buildCommand()`);
  }
}

// ---------------------------------------------------------------------------
// Registry — maps engine name → factory
// ---------------------------------------------------------------------------

/** @type {Map<string, () => Promise<EngineBase>>} */
const registry = new Map();

/**
 * Register an engine factory.
 * @param {string} name
 * @param {() => Promise<EngineBase>} factory
 */
export function registerEngine(name, factory) {
  registry.set(name, factory);
}

/**
 * Resolve an engine by name. Throws if unknown.
 * @param {string} name
 * @returns {Promise<EngineBase>}
 */
export async function getEngine(name) {
  const factory = registry.get(name);
  if (!factory) {
    const available = [...registry.keys()].join(", ");
    throw new Error(`Unknown engine "${name}". Available: ${available}`);
  }
  return factory();
}

/**
 * List all registered engine names.
 * @returns {string[]}
 */
export function listEngines() {
  return [...registry.keys()];
}
