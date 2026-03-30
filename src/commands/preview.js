import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { spawnSync } from "node:child_process";

/**
 * `better preview` — deploy to a preview/staging environment
 */
export async function cmdPreview(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better preview [options]

Deploy to a preview/staging environment for testing.

Options:
  --platform PLATFORM  Target (vercel, netlify, cloudflare)
  --env ENV            Environment name (default: preview)
  --url                Output preview URL only
  --json               Machine-readable JSON output
  -h, --help           Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      platform: { type: "string" },
      env: { type: "string", default: "preview" },
      url: { type: "boolean", default: false },
      "project-root": { type: "string" },
    },
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const platform = values.platform || await detectPreviewPlatform(projectRoot);

  if (!values.json) printText(`Deploying preview to ${platform}...`);

  const commands = {
    vercel: { cmd: "vercel", args: [] },
    netlify: { cmd: "netlify", args: ["deploy"] },
    cloudflare: { cmd: "wrangler", args: ["deploy", "--env", "preview"] },
  };

  const { cmd, args } = commands[platform] || { cmd: "npm", args: ["run", "preview"] };

  const result = spawnSync(cmd, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: values.env }
  });

  const url = (result.stdout || "").match(/https?:\/\/[^\s]+/)?.[0];

  if (result.status !== 0 && !url) {
    const err = { ok: false, error: `Preview deploy failed`, stderr: result.stderr?.slice(0, 200) };
    if (values.json) { printJson(err); } else { printText(`Preview deploy failed: ${result.stderr?.slice(0, 100) || "unknown error"}`); }
    process.exitCode = 1;
    return;
  }

  const output = { ok: true, kind: "better.preview", platform, url, env: values.env };
  if (values.json) { printJson(output); }
  else if (values.url) { printText(url || "No URL in output"); }
  else { printText(`Preview deployed${url ? `: ${url}` : " successfully"}`); }
}

async function detectPreviewPlatform(projectRoot) {
  const { access } = await import("node:fs/promises");
  const checks = [["vercel.json", "vercel"], ["netlify.toml", "netlify"], ["wrangler.toml", "cloudflare"]];
  for (const [file, platform] of checks) {
    if (await access(path.join(projectRoot, file)).then(() => true).catch(() => false)) return platform;
  }
  return "generic";
}
