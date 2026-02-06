#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/utils/execFileNoThrow.ts
var execFileNoThrow_exports = {};
__export(execFileNoThrow_exports, {
  execFileNoThrow: () => execFileNoThrow
});
import { execFile } from "child_process";
import { promisify } from "util";
async function execFileNoThrow(command, args = [], options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      ...options,
      encoding: options.encoding ?? "utf-8"
    });
    return {
      stdout,
      stderr,
      exitCode: 0
    };
  } catch (error) {
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? "",
      exitCode: error.code ?? 1
    };
  }
}
var execFileAsync;
var init_execFileNoThrow = __esm({
  "src/utils/execFileNoThrow.ts"() {
    "use strict";
    execFileAsync = promisify(execFile);
  }
});

// src/doctor/score.ts
var score_exports = {};
__export(score_exports, {
  calculateScore: () => calculateScore
});
function calculateScore(findings) {
  const totalDeductions = findings.reduce((sum, f) => sum + f.weight, 0);
  return Math.max(0, Math.min(100, 100 - totalDeductions));
}
var init_score = __esm({
  "src/doctor/score.ts"() {
    "use strict";
  }
});

// src/cli/parser.ts
function parseArgs(args) {
  const result = {
    command: void 0,
    positionals: [],
    flags: {}
  };
  let i = 0;
  let commandFound = false;
  const isFlag = (str) => {
    if (!str.startsWith("-")) return false;
    if (str === "-") return false;
    const negativeNumberPattern = /^-\d+(\.\d+)?$/;
    return !negativeNumberPattern.test(str);
  };
  while (i < args.length) {
    const arg = args[i];
    if (!arg) {
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      const equalIndex = arg.indexOf("=");
      if (equalIndex !== -1) {
        const key = arg.slice(2, equalIndex);
        const value = arg.slice(equalIndex + 1);
        result.flags[key] = value;
      } else {
        const key = arg.slice(2);
        const nextArg = args[i + 1];
        if (i + 1 < args.length && nextArg && !isFlag(nextArg)) {
          result.flags[key] = nextArg;
          i++;
        } else {
          result.flags[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1 && arg !== "-") {
      const key = arg.slice(1);
      if (key.length > 1) {
        for (const char of key) {
          result.flags[char] = true;
        }
      } else {
        const nextArg = args[i + 1];
        if (i + 1 < args.length && nextArg && !isFlag(nextArg)) {
          result.flags[key] = nextArg;
          i++;
        } else {
          result.flags[key] = true;
        }
      }
    } else {
      if (!commandFound) {
        result.command = arg;
        commandFound = true;
      } else {
        result.positionals.push(arg);
      }
    }
    i++;
  }
  return result;
}

// src/cli/output.ts
var Output = class {
  constructor(options) {
    this.options = options;
  }
  log(message) {
    if (!this.options.json) {
      console.log(message);
    }
  }
  json(data) {
    console.log(JSON.stringify(data, null, 2));
  }
  error(message) {
    if (this.options.json) {
      this.json({ error: message });
    } else {
      console.error(this.formatError(message));
    }
  }
  success(message) {
    if (!this.options.json) {
      const checkmark = this.options.color ? "\u2713" : "\u2713";
      console.log(`${checkmark} ${message}`);
    }
  }
  warn(message) {
    if (!this.options.json) {
      const warning = this.options.color ? "\u26A0" : "\u26A0";
      console.warn(`${warning} ${message}`);
    }
  }
  table(headers, rows) {
    if (rows.length === 0) {
      return "";
    }
    const colWidths = headers.map((header, i) => {
      const maxRowWidth = Math.max(...rows.map((row) => (row[i] || "").length));
      return Math.max(header.length, maxRowWidth);
    });
    const headerRow = headers.map((header, i) => {
      const width = colWidths[i];
      return width !== void 0 ? header.padEnd(width) : header;
    }).join("  ");
    const separator = colWidths.map((width) => "-".repeat(width || 0)).join("  ");
    const dataRows = rows.map(
      (row) => row.map((cell, i) => {
        const width = colWidths[i];
        return width !== void 0 ? (cell || "").padEnd(width) : cell || "";
      }).join("  ")
    );
    return [headerRow, separator, ...dataRows].join("\n");
  }
  formatError(message) {
    if (this.options.color) {
      return `\x1B[31mError:\x1B[0m ${message}`;
    }
    return `Error: ${message}`;
  }
};
function createOutput(options = {}) {
  const defaults = {
    json: false,
    color: process.stdout.isTTY !== false
  };
  return new Output({ ...defaults, ...options });
}

// src/cli/commands/index.ts
var commands = /* @__PURE__ */ new Map();
function registerCommand(cmd) {
  commands.set(cmd.name, cmd);
}
function getCommand(name) {
  return commands.get(name);
}

// src/index.ts
var VERSION = "0.1.0";

// src/adapters/base.ts
var PackageManagerAdapter = class {
  version = "";
  cwd;
  constructor(cwd) {
    this.cwd = cwd;
  }
  // Run the install command
  async install(options = {}) {
    const cmd = this.getInstallCommand(options);
    return this.exec(cmd);
  }
  // Execute a command
  async exec(args) {
    const { spawn: spawn2 } = await import("child_process");
    const start = performance.now();
    return new Promise((resolve2) => {
      const proc = spawn2(args[0], args.slice(1), {
        cwd: this.cwd,
        stdio: ["inherit", "pipe", "pipe"],
        shell: process.platform === "win32"
      });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => {
        resolve2({
          exitCode: code ?? 1,
          stdout,
          stderr,
          duration: Math.round(performance.now() - start)
        });
      });
      proc.on("error", (err) => {
        resolve2({
          exitCode: 1,
          stdout,
          stderr: err.message,
          duration: Math.round(performance.now() - start)
        });
      });
    });
  }
  // Check if a command exists
  async commandExists(cmd) {
    const { execFileNoThrow: execFileNoThrow2 } = await Promise.resolve().then(() => (init_execFileNoThrow(), execFileNoThrow_exports));
    const command = process.platform === "win32" ? "where" : "which";
    const result = await execFileNoThrow2(command, [cmd]);
    return result.exitCode === 0;
  }
};

// src/adapters/npm.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
var NpmAdapter = class extends PackageManagerAdapter {
  name = "npm";
  lockfile = "package-lock.json";
  async detect() {
    const hasPackageLock = fs.existsSync(path.join(this.cwd, "package-lock.json"));
    const hasShrinkwrap = fs.existsSync(path.join(this.cwd, "npm-shrinkwrap.json"));
    if (!hasPackageLock && !hasShrinkwrap) {
      return false;
    }
    return this.commandExists("npm");
  }
  async getVersion() {
    if (this.version) return this.version;
    const { execFileNoThrow: execFileNoThrow2 } = await Promise.resolve().then(() => (init_execFileNoThrow(), execFileNoThrow_exports));
    const result = await execFileNoThrow2("npm", ["--version"]);
    this.version = result.exitCode === 0 ? result.stdout.trim() : "unknown";
    return this.version;
  }
  getInstallCommand(options) {
    const cmd = ["npm"];
    if (options.frozen) {
      cmd.push("ci");
    } else {
      cmd.push("install");
    }
    if (options.production) {
      cmd.push("--omit=dev");
    }
    if (options.args) {
      cmd.push(...options.args);
    }
    return cmd;
  }
  getCachePath() {
    if (process.env["npm_config_cache"]) {
      return process.env["npm_config_cache"];
    }
    return path.join(os.homedir(), ".npm");
  }
};

// src/adapters/pnpm.ts
import * as fs2 from "fs";
import * as path2 from "path";
import * as os2 from "os";
var PnpmAdapter = class extends PackageManagerAdapter {
  name = "pnpm";
  lockfile = "pnpm-lock.yaml";
  async detect() {
    const hasLockfile = fs2.existsSync(path2.join(this.cwd, "pnpm-lock.yaml"));
    if (!hasLockfile) return false;
    return this.commandExists("pnpm");
  }
  async getVersion() {
    if (this.version) return this.version;
    const { execFileNoThrow: execFileNoThrow2 } = await Promise.resolve().then(() => (init_execFileNoThrow(), execFileNoThrow_exports));
    const result = await execFileNoThrow2("pnpm", ["--version"]);
    this.version = result.exitCode === 0 ? result.stdout.trim() : "unknown";
    return this.version;
  }
  getInstallCommand(options) {
    const cmd = ["pnpm", "install"];
    if (options.frozen) {
      cmd.push("--frozen-lockfile");
    }
    if (options.production) {
      cmd.push("--prod");
    }
    if (options.args) {
      cmd.push(...options.args);
    }
    return cmd;
  }
  getCachePath() {
    if (process.env["PNPM_HOME"]) {
      return path2.join(process.env["PNPM_HOME"], "store");
    }
    const platform6 = os2.platform();
    if (platform6 === "win32") {
      return path2.join(process.env["LOCALAPPDATA"] ?? os2.homedir(), "pnpm", "store");
    }
    return path2.join(os2.homedir(), ".local", "share", "pnpm", "store");
  }
};

// src/adapters/yarn-classic.ts
import * as fs3 from "fs";
import * as path3 from "path";
import * as os3 from "os";
var YarnClassicAdapter = class extends PackageManagerAdapter {
  name = "yarn-classic";
  lockfile = "yarn.lock";
  async detect() {
    const hasLockfile = fs3.existsSync(path3.join(this.cwd, "yarn.lock"));
    if (!hasLockfile) return false;
    const hasYarnrcYml = fs3.existsSync(path3.join(this.cwd, ".yarnrc.yml"));
    if (hasYarnrcYml) return false;
    const version = await this.getVersion();
    return version.startsWith("1.");
  }
  async getVersion() {
    if (this.version) return this.version;
    const { execFileNoThrow: execFileNoThrow2 } = await Promise.resolve().then(() => (init_execFileNoThrow(), execFileNoThrow_exports));
    const result = await execFileNoThrow2("yarn", ["--version"]);
    this.version = result.exitCode === 0 ? result.stdout.trim() : "unknown";
    return this.version;
  }
  getInstallCommand(options) {
    const cmd = ["yarn"];
    if (options.frozen) {
      cmd.push("install", "--frozen-lockfile");
    } else {
      cmd.push("install");
    }
    if (options.production) {
      cmd.push("--production");
    }
    if (options.args) {
      cmd.push(...options.args);
    }
    return cmd;
  }
  getCachePath() {
    if (process.env["YARN_CACHE_FOLDER"]) {
      return process.env["YARN_CACHE_FOLDER"];
    }
    const platform6 = os3.platform();
    if (platform6 === "darwin") {
      return path3.join(os3.homedir(), "Library", "Caches", "Yarn");
    }
    if (platform6 === "win32") {
      return path3.join(process.env["LOCALAPPDATA"] ?? os3.homedir(), "Yarn", "Cache");
    }
    return path3.join(os3.homedir(), ".cache", "yarn");
  }
};

// src/adapters/yarn-berry.ts
import * as fs4 from "fs";
import * as path4 from "path";
import * as os4 from "os";
var YarnBerryAdapter = class extends PackageManagerAdapter {
  name = "yarn-berry";
  lockfile = "yarn.lock";
  async detect() {
    const hasLockfile = fs4.existsSync(path4.join(this.cwd, "yarn.lock"));
    if (!hasLockfile) return false;
    const hasYarnrcYml = fs4.existsSync(path4.join(this.cwd, ".yarnrc.yml"));
    if (hasYarnrcYml) return true;
    const version = await this.getVersion();
    const major = parseInt(version.split(".")[0] ?? "0", 10);
    return major >= 2;
  }
  async getVersion() {
    if (this.version) return this.version;
    const { execFileNoThrow: execFileNoThrow2 } = await Promise.resolve().then(() => (init_execFileNoThrow(), execFileNoThrow_exports));
    const result = await execFileNoThrow2("yarn", ["--version"]);
    this.version = result.exitCode === 0 ? result.stdout.trim() : "unknown";
    return this.version;
  }
  getInstallCommand(options) {
    const cmd = ["yarn"];
    if (options.frozen) {
      cmd.push("install", "--immutable");
    } else {
      cmd.push("install");
    }
    if (options.args) {
      cmd.push(...options.args);
    }
    return cmd;
  }
  getCachePath() {
    const yarnrcPath = path4.join(this.cwd, ".yarnrc.yml");
    if (fs4.existsSync(yarnrcPath)) {
      const content = fs4.readFileSync(yarnrcPath, "utf-8");
      const match = content.match(/cacheFolder:\s*(.+)/);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
    if (process.env["YARN_CACHE_FOLDER"]) {
      return process.env["YARN_CACHE_FOLDER"];
    }
    const platform6 = os4.platform();
    if (platform6 === "darwin") {
      return path4.join(os4.homedir(), "Library", "Caches", "Yarn");
    }
    if (platform6 === "win32") {
      return path4.join(process.env["LOCALAPPDATA"] ?? os4.homedir(), "Yarn", "Cache");
    }
    return path4.join(os4.homedir(), ".cache", "yarn");
  }
};

// src/adapters/index.ts
import * as fs5 from "fs";
import * as path5 from "path";
async function detectPackageManager(cwd = process.cwd()) {
  const pkgPath = path5.join(cwd, "package.json");
  if (fs5.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs5.readFileSync(pkgPath, "utf-8"));
    if (pkg.packageManager) {
      const pm = parsePackageManager(pkg.packageManager);
      if (pm) {
        const adapter = createAdapter(pm, cwd);
        if (await adapter.detect()) {
          return adapter;
        }
      }
    }
  }
  const pnpm = new PnpmAdapter(cwd);
  if (await pnpm.detect()) return pnpm;
  const yarnBerry = new YarnBerryAdapter(cwd);
  if (await yarnBerry.detect()) return yarnBerry;
  const yarnClassic = new YarnClassicAdapter(cwd);
  if (await yarnClassic.detect()) return yarnClassic;
  const npm = new NpmAdapter(cwd);
  if (await npm.detect()) return npm;
  return npm;
}
function parsePackageManager(value) {
  const match = value.match(/^(npm|pnpm|yarn)@/);
  if (!match) return null;
  const name = match[1];
  if (name === "yarn") {
    const versionMatch = value.match(/@(\d+)/);
    const major = parseInt(versionMatch?.[1] ?? "1", 10);
    return major >= 2 ? "yarn-berry" : "yarn-classic";
  }
  return name;
}
function createAdapter(name, cwd) {
  switch (name) {
    case "npm":
      return new NpmAdapter(cwd);
    case "pnpm":
      return new PnpmAdapter(cwd);
    case "yarn-classic":
      return new YarnClassicAdapter(cwd);
    case "yarn-berry":
      return new YarnBerryAdapter(cwd);
  }
}

// src/observability/logger.ts
var LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4
};
var Logger = class {
  level;
  json;
  constructor(options) {
    this.level = options.level;
    this.json = options.json;
  }
  shouldLog(level) {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }
  formatMessage(level, msg, context) {
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      msg,
      ...context
    };
    if (this.json) {
      return JSON.stringify(entry);
    }
    const levelStr = level.toUpperCase().padEnd(5);
    const contextStr = context ? ` ${JSON.stringify(context)}` : "";
    return `[${entry.ts}] ${levelStr} ${msg}${contextStr}`;
  }
  write(level, msg, context) {
    if (!this.shouldLog(level)) return;
    const formatted = this.formatMessage(level, msg, context);
    process.stderr.write(formatted + "\n");
  }
  debug(msg, context) {
    this.write("debug", msg, context);
  }
  info(msg, context) {
    this.write("info", msg, context);
  }
  warn(msg, context) {
    this.write("warn", msg, context);
  }
  error(msg, context) {
    this.write("error", msg, context);
  }
  setLevel(level) {
    this.level = level;
  }
  setJson(json) {
    this.json = json;
  }
  // Create a child logger with additional context
  child(context) {
    return new ChildLogger(this, context);
  }
  // Time an operation
  time(label) {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      this.debug(`${label} completed`, { durationMs: Math.round(duration) });
    };
  }
};
var ChildLogger = class {
  constructor(parent, context) {
    this.parent = parent;
    this.context = context;
  }
  debug(msg, context) {
    this.parent.debug(msg, { ...this.context, ...context });
  }
  info(msg, context) {
    this.parent.info(msg, { ...this.context, ...context });
  }
  warn(msg, context) {
    this.parent.warn(msg, { ...this.context, ...context });
  }
  error(msg, context) {
    this.parent.error(msg, { ...this.context, ...context });
  }
};
var globalLogger = null;
function getLogger() {
  if (!globalLogger) {
    globalLogger = new Logger({ level: "info", json: false });
  }
  return globalLogger;
}

// src/utils/spawn.ts
import { spawn } from "child_process";
function spawnWithOutput(cmd, args, options = {}) {
  const start = performance.now();
  const { inheritStdio, ...spawnOpts } = options;
  const stdio = inheritStdio ? "inherit" : ["inherit", "pipe", "pipe"];
  return new Promise((resolve2) => {
    const proc = spawn(cmd, args, {
      ...spawnOpts,
      stdio,
      shell: process.platform === "win32"
    });
    let stdout = "";
    let stderr = "";
    if (!inheritStdio) {
      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
        process.stdout.write(data);
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
        process.stderr.write(data);
      });
    }
    proc.on("close", (code) => {
      const duration = Math.round(performance.now() - start);
      resolve2({
        exitCode: code ?? 1,
        stdout,
        stderr,
        duration
      });
    });
    proc.on("error", (err) => {
      const duration = Math.round(performance.now() - start);
      resolve2({
        exitCode: 1,
        stdout,
        stderr: err.message,
        duration
      });
    });
  });
}

// src/fs/index.ts
import * as fs6 from "fs";
import * as path6 from "path";
function countLockfilePackages(lockfilePath) {
  try {
    if (!fs6.existsSync(lockfilePath)) {
      return 0;
    }
    const content = fs6.readFileSync(lockfilePath, "utf-8");
    const filename = path6.basename(lockfilePath);
    if (filename === "package-lock.json") {
      const lockfile = JSON.parse(content);
      if (lockfile.packages) {
        return Object.keys(lockfile.packages).filter((key) => key !== "").length;
      } else if (lockfile.dependencies) {
        return countDependenciesRecursive(lockfile.dependencies);
      }
      return 0;
    } else if (filename === "pnpm-lock.yaml") {
      const packagesMatch = content.match(/^packages:/m);
      if (!packagesMatch) return 0;
      const packageLines = content.split("\n").filter(
        (line) => /^  ['"]?[@/]/.test(line) && line.includes(":")
      );
      return packageLines.length;
    } else if (filename === "yarn.lock") {
      const entries = content.split("\n").filter(
        (line) => /^[^#\s].*:$/.test(line.trim()) && !line.includes('"')
      );
      return entries.length;
    }
    return 0;
  } catch (error) {
    return 0;
  }
}
function countDependenciesRecursive(deps) {
  let count = Object.keys(deps).length;
  for (const dep of Object.values(deps)) {
    if (dep.dependencies) {
      count += countDependenciesRecursive(dep.dependencies);
    }
  }
  return count;
}

// src/cli/commands/install.ts
import * as path7 from "path";
var installCommand = {
  name: "install",
  description: "Install dependencies with enhanced features",
  async run(ctx) {
    const logger = getLogger();
    const cwd = process.cwd();
    const dryRun = ctx.args.flags["dry-run"] === true;
    const frozen = ctx.args.flags["frozen"] === true;
    const production = ctx.args.flags["production"] === true;
    const jsonOutput = ctx.args.flags["json"] === true;
    try {
      logger.debug("Detecting package manager", { cwd });
      const adapter = await detectPackageManager(cwd);
      logger.info("Detected package manager", { pm: adapter.name });
      const installOptions = {
        frozen,
        production,
        args: ctx.args.positionals
        // Additional packages to install
      };
      const commandArgs = adapter.getInstallCommand(installOptions);
      logger.debug("Install command", { command: commandArgs.join(" ") });
      if (dryRun) {
        const lockfilePath = path7.join(cwd, adapter.lockfile);
        const estimatedPackages = countLockfilePackages(lockfilePath);
        const result2 = {
          dryRun: true,
          command: commandArgs.join(" "),
          packageManager: adapter.name,
          estimatedPackages,
          wouldExecute: commandArgs,
          lockfileExists: estimatedPackages > 0
        };
        if (jsonOutput) {
          console.log(JSON.stringify(result2, null, 2));
        } else {
          ctx.output.log(`[Dry run] Would execute: ${result2.command}`);
          if (estimatedPackages > 0) {
            ctx.output.log(`Estimated packages: ${estimatedPackages}`);
          } else {
            ctx.output.log("No lockfile found or lockfile is empty");
          }
        }
        return 0;
      }
      ctx.output.log(`Installing with ${adapter.name}...`);
      const startTime = performance.now();
      const result = await spawnWithOutput(commandArgs[0], commandArgs.slice(1), {
        cwd,
        inheritStdio: true
      });
      const durationSec = (result.duration / 1e3).toFixed(2);
      if (result.exitCode === 0) {
        ctx.output.success(`Installation completed in ${durationSec}s`);
        logger.info("Install completed", {
          pm: adapter.name,
          durationMs: result.duration,
          exitCode: result.exitCode
        });
      } else {
        ctx.output.error(`Installation failed (exit code ${result.exitCode})`);
        logger.error("Install failed", {
          pm: adapter.name,
          durationMs: result.duration,
          exitCode: result.exitCode
        });
      }
      return result.exitCode;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      ctx.output.error(`Install failed: ${errorMessage}`);
      logger.error("Install error", { error: errorMessage });
      return 1;
    }
  }
};
registerCommand(installCommand);

// src/cli/commands/analyze.ts
import * as path9 from "path";

// src/analyzer/graph.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync4, existsSync as existsSync7 } from "fs";
import { join as join9, dirname, resolve } from "path";

// src/fs/scanner.ts
import { readdirSync, statSync } from "fs";
import { join as join8 } from "path";
function* scanDirectory(dir, options = {}) {
  const { excludeDirs = [".git", ".DS_Store"], followSymlinks = false } = options;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    const fullPath = join8(dir, entry.name);
    if (excludeDirs.includes(entry.name)) {
      continue;
    }
    let stat;
    try {
      stat = statSync(fullPath, { bigint: false });
    } catch (err) {
      continue;
    }
    const isSymlink = entry.isSymbolicLink();
    if (stat.isDirectory()) {
      yield {
        path: fullPath,
        size: 0,
        isDirectory: true,
        isSymlink,
        ino: stat.ino,
        dev: stat.dev
      };
      if (!isSymlink || followSymlinks) {
        yield* scanDirectory(fullPath, options);
      }
    } else if (stat.isFile()) {
      yield {
        path: fullPath,
        size: stat.size,
        isDirectory: false,
        isSymlink,
        ino: stat.ino,
        dev: stat.dev
      };
    }
  }
}

// src/fs/hardlinks.ts
var HardlinkTracker = class {
  seen = /* @__PURE__ */ new Map();
  /**
   * Check if we've seen this inode+dev combination before
   * @param ino inode number
   * @param dev device number
   * @returns true if this is the first time seeing this inode
   */
  isFirstOccurrence(ino, dev) {
    const key = `${dev}:${ino}`;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, true);
    return true;
  }
  /**
   * Get the count of unique inodes tracked
   */
  getUniqueCount() {
    return this.seen.size;
  }
  /**
   * Reset the tracker
   */
  reset() {
    this.seen.clear();
  }
};

// src/fs/size.ts
function calculateSize2(dir, options) {
  let logicalSize = 0;
  let physicalSize = 0;
  let fileCount = 0;
  let directoryCount = 0;
  const hardlinkTracker = new HardlinkTracker();
  for (const file of scanDirectory(dir, options)) {
    if (file.isDirectory) {
      directoryCount++;
    } else {
      fileCount++;
      logicalSize += file.size;
      if (hardlinkTracker.isFirstOccurrence(file.ino, file.dev)) {
        physicalSize += file.size;
      }
    }
  }
  return {
    logicalSize,
    physicalSize,
    fileCount,
    directoryCount
  };
}
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

// src/analyzer/graph.ts
function readPackageJson(path17) {
  try {
    const content = readFileSync4(path17, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
function getPackageSize(packagePath) {
  try {
    const sizeResult = calculateSize2(packagePath, {
      excludeDirs: [".git", ".DS_Store", "node_modules"]
    });
    return sizeResult.physicalSize;
  } catch {
    return 0;
  }
}
function buildDependencyGraph(nodeModulesPath) {
  const packages = /* @__PURE__ */ new Map();
  const projectRoot = dirname(nodeModulesPath);
  const rootPkgPath = join9(projectRoot, "package.json");
  const rootPkg = readPackageJson(rootPkgPath);
  if (!rootPkg) {
    throw new Error(`Could not find package.json at ${rootPkgPath}`);
  }
  const rootDirectDeps = /* @__PURE__ */ new Set();
  const allRootDeps = {
    ...rootPkg.dependencies,
    ...rootPkg.devDependencies
  };
  function walkNodeModules(nmPath, visited = /* @__PURE__ */ new Set()) {
    if (!existsSync7(nmPath)) {
      return;
    }
    const realPath = resolve(nmPath);
    if (visited.has(realPath)) {
      return;
    }
    visited.add(realPath);
    let entries;
    try {
      entries = readdirSync2(nmPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join9(nmPath, entry.name);
      if (entry.isDirectory() && entry.name.startsWith("@")) {
        let scopedEntries;
        try {
          scopedEntries = readdirSync2(entryPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const scopedEntry of scopedEntries) {
          if (scopedEntry.isDirectory()) {
            const scopedPkgPath = join9(entryPath, scopedEntry.name);
            processPackage(scopedPkgPath, visited);
          }
        }
      } else if (entry.isDirectory()) {
        processPackage(entryPath, visited);
      }
    }
  }
  function processPackage(packagePath, visited) {
    const pkgJsonPath = join9(packagePath, "package.json");
    const pkg = readPackageJson(pkgJsonPath);
    if (!pkg) {
      return;
    }
    const packageKey = `${pkg.name}@${pkg.version}`;
    if (packages.has(packageKey)) {
      return;
    }
    const deps = pkg.dependencies || {};
    const depsList = [];
    for (const depName of Object.keys(deps)) {
      const resolvedVersion = resolveInstalledVersion(depName, packagePath);
      if (resolvedVersion) {
        depsList.push(`${depName}@${resolvedVersion}`);
      }
    }
    const isDirect = allRootDeps.hasOwnProperty(pkg.name);
    const size = getPackageSize(packagePath);
    packages.set(packageKey, {
      name: pkg.name,
      version: pkg.version,
      path: packagePath,
      size,
      dependencies: depsList,
      isDirect
    });
    if (isDirect) {
      rootDirectDeps.add(packageKey);
    }
    const nestedNm = join9(packagePath, "node_modules");
    if (existsSync7(nestedNm)) {
      walkNodeModules(nestedNm, visited);
    }
  }
  function resolveInstalledVersion(packageName, fromPath) {
    let currentPath = fromPath;
    while (currentPath !== dirname(currentPath)) {
      const nmPath = join9(currentPath, "node_modules");
      const packagePath = packageName.startsWith("@") ? join9(nmPath, packageName) : join9(nmPath, packageName);
      const pkgJsonPath = join9(packagePath, "package.json");
      if (existsSync7(pkgJsonPath)) {
        const pkg = readPackageJson(pkgJsonPath);
        if (pkg && pkg.version) {
          return pkg.version;
        }
      }
      currentPath = dirname(currentPath);
    }
    return null;
  }
  walkNodeModules(nodeModulesPath);
  return {
    root: {
      name: rootPkg.name,
      version: rootPkg.version,
      path: projectRoot,
      dependencies: Array.from(rootDirectDeps)
    },
    packages,
    totalPackages: packages.size
  };
}

// src/analyzer/duplicates.ts
function compareVersions(a, b) {
  const aParts = a.split(".").map((p) => parseInt(p, 10) || 0);
  const bParts = b.split(".").map((p) => parseInt(p, 10) || 0);
  const maxLength = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLength; i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal !== bVal) {
      return aVal - bVal;
    }
  }
  return 0;
}
function detectDuplicates(graph) {
  const packagesByName = /* @__PURE__ */ new Map();
  for (const node of graph.packages.values()) {
    const existing = packagesByName.get(node.name) || [];
    existing.push(node);
    packagesByName.set(node.name, existing);
  }
  const duplicates = [];
  let totalWastedBytes = 0;
  for (const [packageName, nodes] of packagesByName.entries()) {
    const versionMap = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      const existing = versionMap.get(node.version) || [];
      existing.push(node);
      versionMap.set(node.version, existing);
    }
    if (versionMap.size > 1) {
      const versions = [];
      let totalSize = 0;
      let maxSize = 0;
      let totalInstances = 0;
      for (const [version, versionNodes] of versionMap.entries()) {
        const versionSize = versionNodes.reduce((sum, n) => sum + n.size, 0);
        const count = versionNodes.length;
        versions.push({
          version,
          count,
          paths: versionNodes.map((n) => n.path),
          size: versionSize
        });
        totalSize += versionSize;
        maxSize = Math.max(maxSize, versionSize / count);
        totalInstances += count;
      }
      versions.sort((a, b) => compareVersions(b.version, a.version));
      const suggestedVersion = versions[0]?.version || "";
      const singleInstanceSize = Math.max(...versions.map((v) => v.size / v.count));
      const wastedBytes = Math.round(totalSize - singleInstanceSize);
      duplicates.push({
        package: packageName,
        versions,
        totalInstances,
        wastedBytes: Math.max(0, wastedBytes),
        suggestedVersion
      });
      totalWastedBytes += Math.max(0, wastedBytes);
    }
  }
  duplicates.sort((a, b) => b.wastedBytes - a.wastedBytes);
  return {
    duplicates,
    totalWastedBytes,
    totalDuplicatePackages: duplicates.length
  };
}

// src/analyzer/depth.ts
function analyzeDepth(graph) {
  const depthMap = /* @__PURE__ */ new Map();
  const pathMap = /* @__PURE__ */ new Map();
  const depthDistribution = /* @__PURE__ */ new Map();
  const queue = [];
  const visited = /* @__PURE__ */ new Set();
  for (const depId of graph.root.dependencies) {
    queue.push({
      packageId: depId,
      depth: 1,
      path: [depId]
    });
  }
  let maxDepth = 0;
  let longestChainNode = null;
  while (queue.length > 0) {
    const current = queue.shift();
    const { packageId, depth, path: path17 } = current;
    if (visited.has(packageId)) {
      continue;
    }
    visited.add(packageId);
    depthMap.set(packageId, depth);
    pathMap.set(packageId, path17);
    if (!depthDistribution.has(depth)) {
      depthDistribution.set(depth, []);
    }
    depthDistribution.get(depth).push(packageId);
    if (depth > maxDepth) {
      maxDepth = depth;
      longestChainNode = current;
    }
    const packageNode = graph.packages.get(packageId);
    if (packageNode) {
      for (const childId of packageNode.dependencies) {
        if (!visited.has(childId) && graph.packages.has(childId)) {
          queue.push({
            packageId: childId,
            depth: depth + 1,
            path: [...path17, childId]
          });
        }
      }
    }
  }
  const totalDepth = Array.from(depthMap.values()).reduce((sum, d) => sum + d, 0);
  const averageDepth = depthMap.size > 0 ? totalDepth / depthMap.size : 0;
  const longestChain = longestChainNode ? longestChainNode.path : [];
  return {
    maxDepth,
    longestChain,
    depthDistribution,
    averageDepth
  };
}

// src/analyzer/deprecation.ts
import * as fs7 from "fs";
import * as path8 from "path";
function detectDeprecated(graph, rootDir) {
  const deprecatedPackages = [];
  const deprecatedMap = /* @__PURE__ */ new Map();
  for (const [packageId, node] of graph.packages.entries()) {
    const packageJsonPath = path8.join(node.path, "package.json");
    if (!fs7.existsSync(packageJsonPath)) {
      continue;
    }
    try {
      const packageJsonContent = fs7.readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(packageJsonContent);
      if (packageJson.deprecated) {
        const deprecationMessage = typeof packageJson.deprecated === "string" ? packageJson.deprecated : "This package is deprecated";
        const deprecatedPackage = {
          name: node.name,
          version: node.version,
          path: node.path,
          deprecationMessage,
          dependedOnBy: []
        };
        deprecatedMap.set(packageId, deprecatedPackage);
      }
    } catch (error) {
      continue;
    }
  }
  for (const [packageId, deprecatedPkg] of deprecatedMap.entries()) {
    for (const [dependerPackageId, dependerNode] of graph.packages.entries()) {
      if (dependerNode.dependencies.includes(packageId)) {
        const dependerIdentifier = `${dependerNode.name}@${dependerNode.version}`;
        deprecatedPkg.dependedOnBy.push(dependerIdentifier);
      }
    }
    if (graph.root.dependencies.includes(packageId)) {
      deprecatedPkg.dependedOnBy.push("root");
    }
    deprecatedPackages.push(deprecatedPkg);
  }
  return {
    deprecatedPackages,
    totalDeprecated: deprecatedPackages.length
  };
}

// src/cli/commands/analyze.ts
var analyzeCommand = {
  name: "analyze",
  description: "Analyze dependencies for issues and optimizations",
  async run(ctx) {
    const cwd = process.cwd();
    const nodeModulesPath = path9.join(cwd, "node_modules");
    const jsonOutput = ctx.args.flags["json"] === true;
    const duplicatesOnly = ctx.args.flags["duplicates"] === true;
    const depthOnly = ctx.args.flags["depth"] === true;
    const deprecatedOnly = ctx.args.flags["deprecated"] === true;
    try {
      const graph = buildDependencyGraph(nodeModulesPath);
      const shouldRunAll = !duplicatesOnly && !depthOnly && !deprecatedOnly;
      let duplicates;
      let depth;
      let deprecated;
      if (shouldRunAll || duplicatesOnly) {
        duplicates = detectDuplicates(graph);
      }
      if (shouldRunAll || depthOnly) {
        depth = analyzeDepth(graph);
      }
      if (shouldRunAll || deprecatedOnly) {
        deprecated = detectDeprecated(graph, cwd);
      }
      let totalSize = 0;
      for (const node of graph.packages.values()) {
        totalSize += node.size;
      }
      let directCount = 0;
      let transitiveCount = 0;
      for (const node of graph.packages.values()) {
        if (node.isDirect) {
          directCount++;
        } else {
          transitiveCount++;
        }
      }
      if (jsonOutput) {
        const result = {
          totalPackages: graph.totalPackages,
          directDependencies: directCount,
          transitiveDependencies: transitiveCount,
          totalSize
        };
        if (duplicates) {
          result.duplicates = {
            totalDuplicatePackages: duplicates.totalDuplicatePackages,
            totalWastedBytes: duplicates.totalWastedBytes,
            packages: duplicates.duplicates
          };
        }
        if (depth) {
          result.depth = {
            maxDepth: depth.maxDepth,
            averageDepth: depth.averageDepth,
            longestChain: depth.longestChain
          };
        }
        if (deprecated) {
          result.deprecated = {
            totalDeprecated: deprecated.totalDeprecated,
            packages: deprecated.deprecatedPackages
          };
        }
        ctx.output.json(result);
      } else {
        if (shouldRunAll) {
          ctx.output.log("\n=== Dependency Analysis ===\n");
          ctx.output.log(`Total packages: ${graph.totalPackages}`);
          ctx.output.log(`  Direct: ${directCount}`);
          ctx.output.log(`  Transitive: ${transitiveCount}`);
          ctx.output.log(`Total disk size: ${formatBytes(totalSize)}
`);
        }
        if (duplicates) {
          if (duplicatesOnly) {
            ctx.output.log("\n=== Duplicate Packages ===\n");
          } else {
            ctx.output.log("--- Duplicates ---");
          }
          if (duplicates.totalDuplicatePackages === 0) {
            ctx.output.log("No duplicate packages found.\n");
          } else {
            ctx.output.log(`Found ${duplicates.totalDuplicatePackages} packages with multiple versions`);
            ctx.output.log(`Wasted space: ${formatBytes(duplicates.totalWastedBytes)}
`);
            for (const dup of duplicates.duplicates) {
              ctx.output.log(`${dup.package}:`);
              for (const ver of dup.versions) {
                ctx.output.log(`  - v${ver.version} (${ver.count} instance${ver.count > 1 ? "s" : ""}, ${formatBytes(ver.size)})`);
              }
              ctx.output.log(`  Suggested: v${dup.suggestedVersion}`);
              ctx.output.log(`  Wasted: ${formatBytes(dup.wastedBytes)}
`);
            }
          }
        }
        if (depth) {
          if (depthOnly) {
            ctx.output.log("\n=== Dependency Depth Analysis ===\n");
          } else {
            ctx.output.log("--- Depth Analysis ---");
          }
          ctx.output.log(`Max depth: ${depth.maxDepth}`);
          ctx.output.log(`Average depth: ${depth.averageDepth.toFixed(2)}
`);
          if (depth.longestChain.length > 0) {
            ctx.output.log("Longest dependency chain:");
            depth.longestChain.forEach((pkg, idx) => {
              const indent = "  ".repeat(idx);
              ctx.output.log(`${indent}${idx + 1}. ${pkg}`);
            });
            ctx.output.log("");
          }
        }
        if (deprecated) {
          if (deprecatedOnly) {
            ctx.output.log("\n=== Deprecated Packages ===\n");
          } else {
            ctx.output.log("--- Deprecated Packages ---");
          }
          if (deprecated.totalDeprecated === 0) {
            ctx.output.log("No deprecated packages found.\n");
          } else {
            ctx.output.log(`Found ${deprecated.totalDeprecated} deprecated package${deprecated.totalDeprecated > 1 ? "s" : ""}:
`);
            for (const dep of deprecated.deprecatedPackages) {
              ctx.output.log(`${dep.name}@${dep.version}:`);
              ctx.output.log(`  Message: ${dep.deprecationMessage}`);
              if (dep.dependedOnBy.length > 0) {
                ctx.output.log(`  Used by: ${dep.dependedOnBy.slice(0, 5).join(", ")}${dep.dependedOnBy.length > 5 ? ` and ${dep.dependedOnBy.length - 5} more` : ""}`);
              }
              ctx.output.log("");
            }
          }
        }
      }
      return 0;
    } catch (error) {
      ctx.output.error(`Failed to analyze dependencies: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
};
registerCommand(analyzeCommand);

// src/cache/manager.ts
import * as fs8 from "fs";
import * as path11 from "path";

// src/utils/paths.ts
import * as os5 from "os";
import * as path10 from "path";
function getCacheRoot() {
  const platform6 = os5.platform();
  if (process.env["XDG_CACHE_HOME"]) {
    return path10.join(process.env["XDG_CACHE_HOME"], "better");
  }
  switch (platform6) {
    case "darwin":
      return path10.join(os5.homedir(), "Library", "Caches", "better");
    case "win32":
      return path10.join(process.env["LOCALAPPDATA"] ?? os5.homedir(), "better", "cache");
    default:
      return path10.join(os5.homedir(), ".cache", "better");
  }
}

// src/cache/manager.ts
var CacheManager = class {
  root;
  initialized = false;
  constructor(config) {
    this.root = config?.root ?? getCacheRoot();
  }
  // Ensure cache directory structure exists
  async initialize() {
    if (this.initialized) return;
    const logger = getLogger();
    const dirs = [
      this.root,
      path11.join(this.root, "packages"),
      path11.join(this.root, "metadata"),
      path11.join(this.root, "tmp")
    ];
    for (const dir of dirs) {
      if (!fs8.existsSync(dir)) {
        logger.debug("Creating cache directory", { path: dir });
        fs8.mkdirSync(dir, { recursive: true, mode: 493 });
      }
    }
    this.initialized = true;
    logger.info("Cache initialized", { root: this.root });
  }
  // Get the root cache directory
  getRoot() {
    return this.root;
  }
  // Get path for a specific cache type
  getPath(type, ...parts) {
    return path11.join(this.root, type, ...parts);
  }
  // Get path for a package in cache
  getPackagePath(name, version) {
    const safeName = name.replace(/\//g, "+");
    return this.getPath("packages", safeName, version);
  }
  // Check if a package is cached
  async hasPackage(name, version) {
    const pkgPath = this.getPackagePath(name, version);
    return fs8.existsSync(pkgPath);
  }
  // Get cache stats
  async getStats() {
    await this.initialize();
    const packagesDir = this.getPath("packages");
    const stats = {
      root: this.root,
      totalSize: 0,
      packageCount: 0,
      oldestEntry: null,
      newestEntry: null
    };
    if (!fs8.existsSync(packagesDir)) {
      return stats;
    }
    const entries = await this.scanDirectory(packagesDir);
    stats.packageCount = entries.length;
    stats.totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    if (entries.length > 0) {
      entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      stats.oldestEntry = entries[0].createdAt;
      stats.newestEntry = entries[entries.length - 1].createdAt;
    }
    return stats;
  }
  // Scan a directory recursively for cache entries
  async scanDirectory(dir) {
    const entries = [];
    if (!fs8.existsSync(dir)) return entries;
    const items = fs8.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path11.join(dir, item.name);
      if (item.isDirectory()) {
        const subEntries = await this.scanDirectory(fullPath);
        entries.push(...subEntries);
      } else if (item.isFile()) {
        const stat = fs8.statSync(fullPath);
        entries.push({
          key: path11.relative(this.root, fullPath),
          path: fullPath,
          size: stat.size,
          createdAt: stat.birthtime,
          accessedAt: stat.atime
        });
      }
    }
    return entries;
  }
  // Clean up temporary files
  async cleanTmp() {
    const tmpDir = this.getPath("tmp");
    if (!fs8.existsSync(tmpDir)) return 0;
    let cleaned = 0;
    const items = fs8.readdirSync(tmpDir);
    for (const item of items) {
      const fullPath = path11.join(tmpDir, item);
      fs8.rmSync(fullPath, { recursive: true, force: true });
      cleaned++;
    }
    return cleaned;
  }
};
var cacheManager = null;
function getCacheManager(config) {
  if (!cacheManager) {
    cacheManager = new CacheManager(config);
  }
  return cacheManager;
}

// src/cache/gc.ts
import * as fs9 from "fs";
import * as path12 from "path";
async function findOldEntries(dir, maxAge, now) {
  const oldEntries = [];
  if (!fs9.existsSync(dir)) return oldEntries;
  const items = fs9.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path12.join(dir, item.name);
    if (item.isDirectory()) {
      const hasFiles = fs9.readdirSync(fullPath, { withFileTypes: true }).some((subItem) => subItem.isFile());
      if (hasFiles) {
        const stat = fs9.statSync(fullPath);
        const age = now - stat.birthtime.getTime();
        if (age > maxAge) {
          const size = getDirectorySize(fullPath);
          oldEntries.push({
            path: fullPath,
            size,
            createdAt: stat.birthtime
          });
        }
      } else {
        const subEntries = await findOldEntries(fullPath, maxAge, now);
        oldEntries.push(...subEntries);
      }
    }
  }
  return oldEntries;
}
function getDirectorySize(dir) {
  let size = 0;
  const items = fs9.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path12.join(dir, item.name);
    if (item.isDirectory()) {
      size += getDirectorySize(fullPath);
    } else if (item.isFile()) {
      const stat = fs9.statSync(fullPath);
      size += stat.size;
    }
  }
  return size;
}
async function runGarbageCollection(options = {}) {
  const logger = getLogger();
  const cache = getCacheManager();
  const maxAge = options.maxAge ?? 30 * 24 * 60 * 60 * 1e3;
  const now = Date.now();
  await cache.initialize();
  const packagesDir = cache.getPath("packages");
  const result = {
    entriesRemoved: 0,
    bytesFreed: 0,
    entries: []
  };
  const oldEntries = await findOldEntries(packagesDir, maxAge, now);
  for (const entry of oldEntries) {
    result.entries.push({
      path: entry.path,
      size: entry.size,
      age: now - entry.createdAt.getTime()
    });
    result.bytesFreed += entry.size;
    if (!options.dryRun) {
      fs9.rmSync(entry.path, { recursive: true, force: true });
      result.entriesRemoved++;
    }
  }
  if (options.dryRun) {
    logger.info("Dry run - no files removed", { wouldRemove: oldEntries.length });
  } else {
    logger.info("Garbage collection complete", { removed: result.entriesRemoved });
  }
  return result;
}

// src/cli/commands/cache.ts
import * as fs10 from "fs";
import * as path13 from "path";
var cacheCommand = {
  name: "cache",
  description: "Manage dependency cache",
  async run(ctx) {
    const subcommand = ctx.args.positionals[0];
    const maxAgeFlag = ctx.args.flags["max-age"];
    const options = {
      json: ctx.args.flags["json"] === true,
      dryRun: ctx.args.flags["dry-run"] === true
    };
    if (typeof maxAgeFlag === "number") {
      options.maxAge = maxAgeFlag;
    }
    switch (subcommand) {
      case "stats":
        await cacheStatsCommand(ctx, options);
        break;
      case "clean":
        await cacheCleanCommand(ctx, options);
        break;
      case "gc":
        await cacheGCCommand(ctx, options);
        break;
      case "explain":
        await cacheExplainCommand(ctx, options);
        break;
      default:
        ctx.output.error(`Unknown cache subcommand: ${subcommand}`);
        ctx.output.log("Available: stats, clean, gc, explain");
        return 1;
    }
    return 0;
  }
};
async function cacheStatsCommand(ctx, options) {
  const cache = getCacheManager();
  const stats = await cache.getStats();
  if (options.json) {
    ctx.output.json({
      root: stats.root,
      totalSize: stats.totalSize,
      packageCount: stats.packageCount,
      oldestEntry: stats.oldestEntry?.toISOString() ?? null,
      newestEntry: stats.newestEntry?.toISOString() ?? null
    });
  } else {
    ctx.output.log("Cache Statistics:");
    ctx.output.log(`  Location: ${stats.root}`);
    ctx.output.log(`  Total Size: ${formatBytes(stats.totalSize)}`);
    ctx.output.log(`  Packages: ${stats.packageCount}`);
    if (stats.oldestEntry) {
      ctx.output.log(`  Oldest: ${stats.oldestEntry.toISOString()}`);
    }
    if (stats.newestEntry) {
      ctx.output.log(`  Newest: ${stats.newestEntry.toISOString()}`);
    }
  }
}
async function cacheCleanCommand(ctx, options) {
  const cache = getCacheManager();
  const cleaned = await cache.cleanTmp();
  if (options.json) {
    ctx.output.json({ cleaned });
  } else {
    ctx.output.log(`Cleaned ${cleaned} temporary files`);
  }
}
async function cacheGCCommand(ctx, options) {
  const gcOptions = {
    dryRun: options.dryRun
  };
  if (options.maxAge !== void 0) {
    gcOptions.maxAge = options.maxAge;
  }
  const result = await runGarbageCollection(gcOptions);
  if (options.json) {
    ctx.output.json(result);
  } else {
    if (options.dryRun) {
      ctx.output.log(
        `Would remove ${result.entriesRemoved} packages (${formatBytes(result.bytesFreed)})`
      );
    } else {
      ctx.output.log(
        `Removed ${result.entriesRemoved} packages (${formatBytes(result.bytesFreed)})`
      );
    }
  }
}
async function cacheExplainCommand(ctx, options) {
  const packageSpec = ctx.args.positionals[1];
  if (!packageSpec) {
    ctx.output.error("Usage: better cache explain <package[@version]>");
    process.exit(1);
  }
  const cache = getCacheManager();
  const [name, version] = parsePackageSpec(packageSpec);
  const result = {
    package: name,
    version: version || "any",
    cached: false,
    path: null,
    reason: ""
  };
  if (version) {
    const isCached = await cache.hasPackage(name, version);
    if (isCached) {
      result.cached = true;
      result.path = cache.getPackagePath(name, version);
      result.reason = "Package found in cache";
    } else {
      result.reason = "Package not in cache - will be downloaded on next install";
    }
  } else {
    const packagesDir = cache.getPath("packages");
    const safeName = name.replace(/\//g, "+");
    const packageDir = path13.join(packagesDir, safeName);
    if (fs10.existsSync(packageDir)) {
      const versions = fs10.readdirSync(packageDir);
      result.cached = true;
      result.path = packageDir;
      result.reason = `Found ${versions.length} cached version(s): ${versions.join(", ")}`;
    } else {
      result.reason = "No versions of this package are cached";
    }
  }
  if (options.json) {
    ctx.output.json(result);
  } else {
    ctx.output.log(`Package: ${result.package}${result.version !== "any" ? "@" + result.version : ""}`);
    ctx.output.log(`Cached: ${result.cached ? "Yes" : "No"}`);
    if (result.path) {
      ctx.output.log(`Path: ${result.path}`);
    }
    ctx.output.log(`Status: ${result.reason}`);
  }
}
function parsePackageSpec(spec) {
  const lastAt = spec.lastIndexOf("@");
  if (lastAt > 0) {
    return [spec.slice(0, lastAt), spec.slice(lastAt + 1)];
  }
  return [spec, void 0];
}
registerCommand(cacheCommand);

// src/cli/commands/doctor.ts
import * as path15 from "path";

// src/doctor/engine.ts
var HealthEngine = class {
  checks = [];
  register(check) {
    this.checks.push(check);
  }
  async run(context) {
    const results = await Promise.all(
      this.checks.map((check) => check.run(context))
    );
    const findings = results.flat();
    const { calculateScore: calculateScore2 } = await Promise.resolve().then(() => (init_score(), score_exports));
    const score = calculateScore2(findings);
    const checksPassed = [];
    const checksFailed = [];
    for (let i = 0; i < this.checks.length; i++) {
      const result = results[i];
      const check = this.checks[i];
      if (result && check) {
        if (result.length === 0) {
          checksPassed.push(check.id);
        } else {
          checksFailed.push(check.id);
        }
      }
    }
    return {
      score,
      findings,
      checksPassed,
      checksFailed
    };
  }
};

// src/doctor/checks/duplicates.ts
var duplicatesCheck = {
  id: "duplicates",
  name: "Duplicate Packages",
  description: "Checks for duplicate package versions",
  async run(context) {
    const findings = [];
    const { duplicates } = context;
    const maxFindings = 10;
    const duplicatesToReport = duplicates.duplicates.slice(0, maxFindings);
    for (const dup of duplicatesToReport) {
      findings.push({
        checkId: "duplicates",
        severity: "warning",
        message: `Package '${dup.package}' has ${dup.versions.length} versions installed`,
        package: dup.package,
        suggestion: `Run 'npm dedupe' to consolidate package versions`,
        weight: 2
      });
    }
    return findings;
  }
};

// src/doctor/checks/deprecated.ts
var deprecatedCheck = {
  id: "deprecated",
  name: "Deprecated Packages",
  description: "Checks for deprecated packages",
  async run(context) {
    const findings = [];
    const { deprecated } = context;
    const maxFindings = 5;
    const deprecatedToReport = deprecated.deprecatedPackages.slice(0, maxFindings);
    for (const dep of deprecatedToReport) {
      const message = dep.deprecationMessage ? `Package '${dep.name}@${dep.version}' is deprecated: ${dep.deprecationMessage}` : `Package '${dep.name}@${dep.version}' is deprecated`;
      findings.push({
        checkId: "deprecated",
        severity: "error",
        message,
        package: dep.name,
        suggestion: "Find an alternative package or remove if unused",
        weight: 5
      });
    }
    return findings;
  }
};

// src/doctor/checks/depth.ts
var depthCheck = {
  id: "depth",
  name: "Excessive Depth",
  description: "Checks for excessive dependency depth",
  async run(context) {
    const findings = [];
    const { depth } = context;
    const threshold = 10;
    if (depth.maxDepth > threshold) {
      findings.push({
        checkId: "depth",
        severity: "warning",
        message: `Dependency tree depth is ${depth.maxDepth}, exceeding threshold of ${threshold}`,
        suggestion: "Consider flattening dependencies or reviewing dependency structure",
        weight: 10
      });
    }
    return findings;
  }
};

// src/doctor/checks/size.ts
import { promises as fs11 } from "fs";
import * as path14 from "path";
async function getDirectorySize2(dirPath) {
  let totalSize = 0;
  try {
    const entries = await fs11.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path14.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await getDirectorySize2(fullPath);
      } else if (entry.isFile()) {
        const stats = await fs11.stat(fullPath);
        totalSize += stats.size;
      }
    }
  } catch (error) {
  }
  return totalSize;
}
var sizeCheck = {
  id: "size",
  name: "Large node_modules",
  description: "Checks for large node_modules directory",
  async run(context) {
    const findings = [];
    const nodeModulesPath = path14.join(context.cwd, "node_modules");
    try {
      await fs11.access(nodeModulesPath);
      const sizeBytes = await getDirectorySize2(nodeModulesPath);
      const sizeMB = sizeBytes / (1024 * 1024);
      const threshold = 500;
      if (sizeMB > threshold) {
        findings.push({
          checkId: "size",
          severity: "warning",
          message: `node_modules is ${sizeMB.toFixed(2)}MB, exceeding ${threshold}MB threshold`,
          suggestion: "Consider removing unused dependencies or using lighter alternatives",
          weight: 15
        });
      }
    } catch (error) {
    }
    return findings;
  }
};

// src/doctor/checks/index.ts
var allChecks = [
  duplicatesCheck,
  deprecatedCheck,
  depthCheck,
  sizeCheck
];

// src/cli/commands/doctor.ts
var doctorCommand = {
  name: "doctor",
  description: "Check system health and configuration",
  async run(ctx) {
    const logger = getLogger();
    const cwd = process.cwd();
    const jsonOutput = ctx.args.flags["json"] === true;
    const fix = ctx.args.flags["fix"] === true;
    const threshold = typeof ctx.args.flags["threshold"] === "string" ? parseInt(ctx.args.flags["threshold"], 10) : typeof ctx.config["healthThreshold"] === "number" ? ctx.config["healthThreshold"] : 70;
    logger.info("Running health checks", { cwd, threshold });
    try {
      const nodeModulesPath = path15.join(cwd, "node_modules");
      const graph = buildDependencyGraph(nodeModulesPath);
      const duplicates = detectDuplicates(graph);
      const depth = analyzeDepth(graph);
      const deprecated = detectDeprecated(graph, nodeModulesPath);
      const context = {
        cwd,
        graph,
        duplicates,
        depth,
        deprecated
      };
      const engine = new HealthEngine();
      allChecks.forEach((check) => engine.register(check));
      const report = await engine.run(context);
      if (jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReport(report, threshold, ctx.output);
      }
      if (report.score < threshold) {
        logger.warn("Health score below threshold", { score: report.score, threshold });
        return 1;
      }
      return 0;
    } catch (error) {
      logger.error("Doctor command failed", { error: String(error) });
      ctx.output.error(`Failed to run health checks: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
};
function printReport(report, threshold, output) {
  const scoreColor = report.score >= threshold ? "32" : "31";
  console.log(`
Health Score: \x1B[${scoreColor}m${report.score}/100\x1B[0m
`);
  const errors = report.findings.filter((f) => f.severity === "error");
  const warnings = report.findings.filter((f) => f.severity === "warning");
  const infos = report.findings.filter((f) => f.severity === "info");
  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    errors.forEach((f) => console.log(`  - [${f.checkId}] ${f.message}`));
    console.log("");
  }
  if (warnings.length > 0) {
    console.log(`WARNINGS (${warnings.length}):`);
    warnings.forEach((f) => console.log(`  - [${f.checkId}] ${f.message}`));
    console.log("");
  }
  if (infos.length > 0) {
    console.log(`INFO (${infos.length}):`);
    infos.forEach((f) => console.log(`  - [${f.checkId}] ${f.message}`));
    console.log("");
  }
  if (report.findings.length === 0) {
    console.log("No issues found!\n");
  }
  console.log(`Run 'better doctor --fix' to attempt automatic fixes.`);
}
registerCommand(doctorCommand);

// src/web/server.ts
import * as http from "http";
import * as fs12 from "fs";
import * as path16 from "path";
import { fileURLToPath } from "url";
var __filename = fileURLToPath(import.meta.url);
var __dirname = path16.dirname(__filename);
var WebServer = class {
  server = null;
  config;
  constructor(config) {
    this.config = config;
  }
  async start() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error("Request handler error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      });
    });
    return new Promise((resolve2, reject) => {
      this.server.listen(this.config.port, () => {
        console.log(`Server listening on http://localhost:${this.config.port}`);
        resolve2();
      });
      this.server.on("error", reject);
    });
  }
  async stop() {
    if (!this.server) return;
    return new Promise((resolve2, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve2();
      });
    });
  }
  async handleRequest(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await this.handleApiRequest(url.pathname, res);
      return;
    }
    await this.handleStaticFile(url.pathname, res);
  }
  async handleApiRequest(pathname, res) {
    res.setHeader("Content-Type", "application/json");
    try {
      if (pathname === "/api/analyze") {
        const data = await this.getAnalyzeData();
        res.writeHead(200);
        res.end(JSON.stringify(data, null, 2));
      } else if (pathname === "/api/health") {
        const data = await this.getHealthData();
        res.writeHead(200);
        res.end(JSON.stringify(data, null, 2));
      } else if (pathname === "/api/cache/stats") {
        const data = await this.getCacheStats();
        res.writeHead(200);
        res.end(JSON.stringify(data, null, 2));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not Found" }));
      }
    } catch (error) {
      console.error("API error:", error);
      res.writeHead(500);
      res.end(JSON.stringify({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }
  async handleStaticFile(pathname, res) {
    if (pathname === "/") {
      pathname = "/index.html";
    }
    const safePath = path16.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
    const publicDir = path16.join(__dirname, "public");
    const filePath = path16.join(publicDir, safePath);
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    if (!fs12.existsSync(filePath) || !fs12.statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const ext = path16.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    };
    const contentType = contentTypes[ext] || "application/octet-stream";
    const content = fs12.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  }
  async getAnalyzeData() {
    const nodeModulesPath = path16.join(this.config.cwd, "node_modules");
    if (!fs12.existsSync(nodeModulesPath)) {
      return {
        error: "No node_modules found",
        message: "Run npm install first"
      };
    }
    const graph = buildDependencyGraph(nodeModulesPath);
    const duplicates = detectDuplicates(graph);
    const depth = analyzeDepth(graph);
    const deprecated = detectDeprecated(graph, this.config.cwd);
    const sizeResult = calculateSize2(nodeModulesPath, {
      excludeDirs: [".git", ".DS_Store"]
    });
    const packagesObj = {};
    graph.packages.forEach((value, key) => {
      packagesObj[key] = value;
    });
    const depthDistributionObj = {};
    depth.depthDistribution.forEach((value, key) => {
      depthDistributionObj[key] = value;
    });
    return {
      totalPackages: graph.totalPackages,
      totalSize: sizeResult.physicalSize,
      graph: {
        root: graph.root,
        packages: packagesObj,
        totalPackages: graph.totalPackages
      },
      duplicates: {
        duplicates: duplicates.duplicates,
        totalWastedBytes: duplicates.totalWastedBytes,
        totalDuplicatePackages: duplicates.totalDuplicatePackages
      },
      depth: {
        maxDepth: depth.maxDepth,
        longestChain: depth.longestChain,
        depthDistribution: depthDistributionObj,
        averageDepth: depth.averageDepth
      },
      deprecated: {
        deprecatedPackages: deprecated.deprecatedPackages,
        totalDeprecated: deprecated.totalDeprecated
      },
      size: {
        logical: sizeResult.logicalSize,
        physical: sizeResult.physicalSize,
        savings: sizeResult.logicalSize - sizeResult.physicalSize,
        fileCount: sizeResult.fileCount
      }
    };
  }
  async getHealthData() {
    const nodeModulesPath = path16.join(this.config.cwd, "node_modules");
    if (!fs12.existsSync(nodeModulesPath)) {
      return {
        error: "No node_modules found",
        message: "Run npm install first"
      };
    }
    const graph = buildDependencyGraph(nodeModulesPath);
    const duplicates = detectDuplicates(graph);
    const depth = analyzeDepth(graph);
    const deprecated = detectDeprecated(graph, this.config.cwd);
    const engine = new HealthEngine();
    engine.register(depthCheck);
    engine.register(duplicatesCheck);
    engine.register(deprecatedCheck);
    engine.register(sizeCheck);
    const report = await engine.run({
      cwd: this.config.cwd,
      graph,
      duplicates,
      depth,
      deprecated
    });
    const duplicateScore = duplicates.totalDuplicatePackages === 0 ? 100 : Math.max(0, 100 - duplicates.totalDuplicatePackages * 5);
    const deprecationScore = deprecated.totalDeprecated === 0 ? 100 : Math.max(0, 100 - deprecated.totalDeprecated * 10);
    const depthScore = depth.maxDepth <= 5 ? 100 : Math.max(0, 100 - (depth.maxDepth - 5) * 5);
    const sizeScore = 85;
    return {
      score: report.score,
      grade: this.getGrade(report.score),
      findings: report.findings,
      checksPassed: report.checksPassed,
      checksFailed: report.checksFailed,
      duplicateScore,
      deprecationScore,
      depthScore,
      sizeScore
    };
  }
  async getCacheStats() {
    const cacheManager2 = getCacheManager();
    await cacheManager2.initialize();
    const stats = await cacheManager2.getStats();
    return {
      root: stats.root,
      totalSize: stats.totalSize,
      packageCount: stats.packageCount,
      oldestEntry: stats.oldestEntry,
      newestEntry: stats.newestEntry
    };
  }
  getGrade(score) {
    if (score >= 90) return "A";
    if (score >= 80) return "B";
    if (score >= 70) return "C";
    if (score >= 60) return "D";
    return "F";
  }
};

// src/cli/commands/serve.ts
init_execFileNoThrow();
import * as os6 from "os";
var serveCommand = {
  name: "serve",
  description: "Start web UI server for dependency visualization",
  async run(ctx) {
    const port = typeof ctx.args.flags["port"] === "number" ? ctx.args.flags["port"] : 3e3;
    const noOpen = ctx.args.flags["no-open"] === true;
    const cwd = process.cwd();
    ctx.output.log(`Starting web server on port ${port}...`);
    const server = new WebServer({ port, cwd });
    try {
      await server.start();
      const url = `http://localhost:${port}`;
      ctx.output.log(`Server running at ${url}`);
      ctx.output.log("Press Ctrl+C to stop");
      if (!noOpen) {
        await openBrowser(url);
      }
      await new Promise(() => {
      });
      return 0;
    } catch (error) {
      ctx.output.error(`Failed to start server: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
};
async function openBrowser(url) {
  const platform6 = os6.platform();
  let command;
  let args;
  switch (platform6) {
    case "darwin":
      command = "open";
      args = [url];
      break;
    case "win32":
      command = "cmd";
      args = ["/c", "start", url];
      break;
    default:
      command = "xdg-open";
      args = [url];
      break;
  }
  try {
    await execFileNoThrow(command, args);
  } catch (error) {
    console.error("Failed to open browser:", error instanceof Error ? error.message : String(error));
  }
}
registerCommand(serveCommand);

// src/cli.ts
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = createOutput({ json: args.flags["json"] === true });
  if (args.flags["version"] || args.flags["v"]) {
    output.log(`better v${VERSION}`);
    return 0;
  }
  if (args.flags["help"] || args.flags["h"] || !args.command) {
    printHelp(output);
    return 0;
  }
  const cmd = getCommand(args.command);
  if (!cmd) {
    output.error(`Unknown command: ${args.command}`);
    output.log(`Run 'better --help' for usage.`);
    return 1;
  }
  return cmd.run({ args, output, config: {} });
}
function printHelp(output) {
  output.log(`better v${VERSION} - Production-grade dependency toolkit`);
  output.log("");
  output.log("Usage: better <command> [options]");
  output.log("");
  output.log("Commands:");
  for (const [name, cmd] of commands) {
    output.log(`  ${name.padEnd(12)} ${cmd.description}`);
  }
  output.log("");
  output.log("Global Options:");
  output.log("  --help, -h       Show this help message");
  output.log("  --version, -v    Show version");
  output.log("  --json           Output as JSON");
  output.log("  --log-level      Set log level (debug, info, warn, error, silent)");
  output.log("  --config         Path to config file");
}
main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
//# sourceMappingURL=cli.js.map