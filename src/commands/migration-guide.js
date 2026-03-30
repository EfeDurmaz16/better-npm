/**
 * better migration-guide — generate migration guides for major version upgrades
 *
 * Fetches migration documentation and breaking changes for major version
 * upgrades of popular packages, helping developers understand what
 * changes are needed when updating.
 *
 * Usage:
 *   better migration-guide lodash 3 4
 *   better migration-guide react 17 18
 *   better migration-guide --json
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

// Curated migration notes for popular packages
const MIGRATION_NOTES = {
  "lodash": {
    "3→4": [
      "Removed _.pluck, _.where, _.findWhere — use _.map, _.filter instead",
      "_.flatten is now shallow by default — use _.flattenDeep for deep",
      "_.first/_.last accept array only, not object",
      "Method chaining: use _.chain() explicitly",
    ],
    "4→5": [
      "Switched to ESM-only in lodash-es; lodash stays CJS",
      "_.template changes: ES6 template literals preferred",
    ],
  },
  "react": {
    "16→17": [
      "No new features — internal refactoring",
      "Event delegation moved from document to root",
      "New JSX transform: no longer need React in scope for JSX",
      "Removed unstable_ APIs",
    ],
    "17→18": [
      "New root API: createRoot() instead of ReactDOM.render()",
      "Automatic batching of state updates in async code",
      "New useId, useDeferredValue, useTransition hooks",
      "Strict mode runs effects twice in development",
      "React.render() is deprecated (use createRoot)",
    ],
    "18→19": [
      "Actions: useFormStatus, useFormState, useOptimistic",
      "ref as a regular prop (no more forwardRef)",
      "Context.Provider can be used as <Context>",
      "Removed deprecated React APIs: defaultProps on function components",
    ],
  },
  "express": {
    "4→5": [
      "Router methods return promises — errors propagate automatically",
      "Removed req.param() — use req.params, req.body, req.query",
      "res.json() no longer sets 'charset' in Content-Type",
      "Improved async error handling",
    ],
  },
  "webpack": {
    "4→5": [
      "Persistent caching: cache: { type: 'filesystem' }",
      "Module Federation is now built-in",
      "Asset modules replace file-loader/url-loader/raw-loader",
      "Node.js polyfills no longer included by default",
      "output.filename required for production",
    ],
  },
  "jest": {
    "26→27": [
      "Default test environment changed to 'node' (was 'jsdom')",
      "testRunner default changed to 'jest-circus'",
      "Fake timers: jest.useFakeTimers({ legacyFakeTimers }) for old behavior",
    ],
    "27→28": [
      "jest-circus is now the default runner",
      "Improved TypeScript support via ts-jest",
      "Snapshot format improvements",
    ],
    "28→29": [
      "Snapshot serializer changes",
      "New --randomize flag for test order",
      "Improved custom resolver support",
    ],
  },
  "typescript": {
    "4→5": [
      "Const type parameters: const T in generics",
      "All enums are union enums",
      "template strings in template literal types",
      "Dropped support for Node 12, requires Node 14.17+",
      "verbatimModuleSyntax replaces importsNotUsedAsValues",
    ],
  },
  "eslint": {
    "7→8": [
      "Requires Node.js >= 12.22",
      "new eslint.FlatESLint class (flat config preview)",
      "Updated parsers and plugins to v8-compatible versions",
    ],
    "8→9": [
      "Flat config (eslint.config.js) is now default",
      "Removed formatters: checkstyle, codeframe, tap",
      "eslintrc format is deprecated",
    ],
  },
};

export async function cmdMigrationGuide(argv) {
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
    printText(`Usage: better migration-guide <package> <from-major> <to-major>

Get migration guidance for major version upgrades.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better migration-guide react 17 18
  better migration-guide webpack 4 5
  better migration-guide eslint 8 9

Supported packages: ${Object.keys(MIGRATION_NOTES).join(", ")}
`);
    return;
  }

  if (positionals.length < 3) {
    printText("Usage: better migration-guide <package> <from-major> <to-major>\nRun: better migration-guide --help for more info.");
    process.exitCode = 1;
    return;
  }

  const [pkgName, fromMajor, toMajor] = positionals;
  const key = `${fromMajor}→${toMajor}`;

  const pkgNotes = MIGRATION_NOTES[pkgName];

  if (!values.json) {
    printText(`\n\x1b[1mbetter migration-guide\x1b[0m — ${pkgName} v${fromMajor} → v${toMajor}\n`);
  }

  if (!pkgNotes) {
    // Try to fetch changelog from npm registry
    process.stderr.write(`\x1b[90mFetching changelog from npm registry...\x1b[0m\n`);
    let changelogUrl = null;
    try {
      const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`);
      if (res.status === 200) {
        const meta = JSON.parse(res.body);
        const repo = meta.repository?.url || "";
        if (repo.includes("github.com")) {
          const match = repo.match(/github\.com[:/]([^/]+\/[^/.]+)/);
          if (match) changelogUrl = `https://github.com/${match[1]}/blob/main/CHANGELOG.md`;
        }
      }
    } catch {}

    if (values.json) {
      printJson({ ok: false, kind: "better.migration-guide", package: pkgName, fromMajor, toMajor, notes: [], changelogUrl });
    } else {
      printText(`  \x1b[90mNo curated migration notes for ${pkgName}.\x1b[0m`);
      if (changelogUrl) printText(`  Check the changelog: \x1b[36m${changelogUrl}\x1b[0m`);
      printText(`  Run: \x1b[36mnpx npm-check-updates ${pkgName}\x1b[0m to see what changed.`);
    }
    return;
  }

  const notes = pkgNotes[key] || pkgNotes[`${fromMajor}→${parseInt(fromMajor) + 1}`] || [];

  if (notes.length === 0) {
    if (values.json) {
      printJson({ ok: true, kind: "better.migration-guide", package: pkgName, fromMajor, toMajor, notes: [] });
    } else {
      printText(`  \x1b[90mNo migration notes for ${pkgName} v${fromMajor}→v${toMajor}.\x1b[0m`);
      printText(`  Check the package changelog directly.`);
    }
    return;
  }

  if (values.json) {
    printJson({ ok: true, kind: "better.migration-guide", package: pkgName, fromMajor, toMajor, notes });
    return;
  }

  printText(`\x1b[1mBreaking changes / migration steps:\x1b[0m\n`);
  for (const note of notes) {
    printText(`  \x1b[33m→\x1b[0m  ${note}`);
  }
  printText("");
}
