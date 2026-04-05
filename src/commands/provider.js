/**
 * better provider — OSP Provider Toolkit (v1.1 Task 94)
 *
 * Scaffolds a conformant OSP (Open Service Protocol) provider so developers
 * can ship a service that `better osp provision` can auto-provision.
 *
 * Usage:
 *   better provider init <name> [<type>] [<domain>]
 *   better provider init my-db-service database db.example.com
 *   better provider init my-cache cache cache.example.com
 *
 * The scaffold generates:
 *   <name>/
 *     .well-known/osp.json         — OSP v1.1 manifest
 *     src/provision.js             — ProvisionRequest handler
 *     src/deprovision.js           — DeprovisionRequest handler
 *     src/credentials.js           — Credential rotation handler
 *     src/server.js                — HTTP server wiring
 *     tests/conformance.test.js    — OSP conformance test suite
 *     better.provider.toml         — Provider config
 *     package.json
 *     .gitignore
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { spawnSync } from "node:child_process";

const HELP = `better provider — OSP provider toolkit

Usage:
  better provider init <name> [<type>] [<domain>]

Arguments:
  name    Provider name (becomes the directory name, e.g. my-db-provider)
  type    Service type: database | cache | queue | storage | other  (default: other)
  domain  Domain this provider will serve from  (default: <name>.example.com)

Options:
  --json      Machine-readable output
  -h, --help  Show this help

Examples:
  better provider init my-postgres-provider database db.mycompany.com
  better provider init my-redis-cache cache cache.mycompany.com
  better provider init file-storage storage files.mycompany.com

After scaffolding:
  cd <name>
  npm install
  node --test tests/conformance.test.js   # verify OSP conformance
  node src/server.js                      # run the provider locally
`;

export async function cmdProvider(argv) {
  const runtime = getRuntimeConfig();

  if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub !== "init") {
    printText(`Unknown provider subcommand '${sub}'. Run 'better provider --help' for usage.`);
    process.exitCode = 1;
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const name        = positionals[0];
  const serviceType = positionals[1] ?? "other";
  const domain      = positionals[2] ?? `${name}.example.com`;

  if (!name) {
    printText("error: 'provider init' requires a provider name\n\nUsage: better provider init <name> [type] [domain]");
    process.exitCode = 1;
    return;
  }

  // Try Rust binary first
  const corePath = await findBetterCore();
  if (corePath) {
    const result = spawnSync(
      corePath,
      ["provider", "init", name, serviceType, domain],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (result.stdout) {
      const parsed = JSON.parse(result.stdout.trim());
      if (values.json) {
        printJson(parsed);
      } else {
        if (parsed.ok) {
          printText([
            `better provider init`,
            ``,
            `Scaffolded OSP provider '${name}' → ${parsed.outputDir}/`,
            ``,
            `Files created:`,
            ...parsed.filesCreated.map((f) => `  + ${f}`),
            ``,
            `Next steps:`,
            `  cd ${parsed.outputDir}`,
            `  # Edit .well-known/osp.json to customize your provider`,
            `  # Implement src/provision.js with your actual service creation logic`,
            `  node --test tests/conformance.test.js   # verify OSP conformance`,
            `  node src/server.js                      # run the provider locally`,
          ].join("\n"));
        } else {
          printText(`error: ${parsed.reason}`);
          process.exitCode = 1;
        }
      }
      return;
    }
  }

  // Pure-JS fallback scaffold (minimal)
  printText(`[warn] Rust binary not found; using JS fallback scaffold (reduced output)`);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const path = await import("node:path");

  const base = path.resolve(name);
  try {
    mkdirSync(base);
  } catch {
    printText(`error: directory '${name}' already exists`);
    process.exitCode = 1;
    return;
  }

  const files = [
    [".well-known/osp.json",       `{"ospVersion":"1.1","name":"${name}","serviceType":"${serviceType}","domain":"${domain}"}\n`],
    ["src/provision.js",           `export async function handleProvision(req) { return { ok: true, credentials: {} }; }\n`],
    ["src/deprovision.js",         `export async function handleDeprovision(req) { return { ok: true }; }\n`],
    ["src/credentials.js",         `export async function handleRotateCredentials(req) { return { ok: true, credentials: {} }; }\n`],
    ["tests/conformance.test.js",  `import { test } from "node:test"; test("manifest exists", () => {});\n`],
    ["package.json",               `{"name":"${name}","version":"1.0.0","type":"module","scripts":{"test":"node --test tests/conformance.test.js"}}\n`],
    [".gitignore",                  `node_modules/\n.env\n`],
  ];

  const created = [];
  for (const [rel, content] of files) {
    const full = path.join(base, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    created.push(rel);
  }

  const out = {
    ok: true,
    kind: "better.provider.init",
    outputDir: base,
    filesCreated: created,
    note: "JS fallback scaffold — build Rust binary for full scaffold",
  };

  if (values.json) {
    printJson(out);
  } else {
    printText(`Scaffolded '${name}' → ${base}/\nRun: cd ${name} && node --test tests/conformance.test.js`);
  }
}
