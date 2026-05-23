import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runDetectFrameworkNapi } from "../lib/core.js";

/**
 * `better deploy [target]` — deploy with dependency auto-provisioning
 *
 * Usage:
 *   better deploy                    # deploy using scripts.deploy in package.json
 *   better deploy --platform vercel  # deploy to Vercel
 *   better deploy --platform railway # deploy to Railway
 *   better deploy --env production   # set NODE_ENV and deploy
 *   better deploy --provision        # provision OSP services first, then deploy
 */
export async function cmdDeploy(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better deploy [options]

Deploy your application with optional OSP service provisioning.

Options:
  --platform PLATFORM  Target platform (vercel, railway, fly, netlify, heroku)
  --env ENV            Environment name (default: production)
  --provision          Run OSP provisioning before deploying
  --dry-run            Show what would be deployed without deploying
  --json               Machine-readable JSON output
  --project-root PATH  Override project root
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
      env: { type: "string", default: "production" },
      provision: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "project-root": { type: "string" },
    },
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const steps = [];

  // Step 1: Provision OSP services if requested
  if (values.provision) {
    steps.push({ step: "provision", status: "pending" });
  }

  // Step 2: Install deps
  steps.push({ step: "install", status: "pending" });

  // Step 3: Build
  steps.push({ step: "build", status: "pending" });

  // Step 4: Deploy
  steps.push({ step: "deploy", status: "pending", platform: values.platform || "auto" });

  if (values["dry-run"]) {
    // Detect framework using NAPI for accurate detection
    let framework = null;
    let platform = values.platform || null;
    const napiDetect = runDetectFrameworkNapi(projectRoot);
    if (napiDetect?.ok) {
      framework = napiDetect.framework?.toLowerCase().replace("js", "") || null;
      platform = platform || napiDetect.recommended_platform?.toLowerCase() || null;
    } else {
    try {
      const fs = await import("node:fs/promises");
      const pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
      const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
      if (allDeps.next) { framework = "next"; platform = platform || "vercel"; }
      else if (allDeps.nuxt) { framework = "nuxt"; platform = platform || "vercel"; }
      else if (allDeps["@remix-run/react"] || allDeps.remix) { framework = "remix"; platform = platform || "fly"; }
      else if (allDeps.gatsby) { framework = "gatsby"; platform = platform || "netlify"; }
      else if (allDeps.astro) { framework = "astro"; platform = platform || "netlify"; }
      else if (allDeps.svelte || allDeps["@sveltejs/kit"]) { framework = "svelte"; platform = platform || "vercel"; }
      else if (allDeps.express || allDeps.fastify || allDeps.koa) { framework = "node"; platform = platform || "railway"; }
    } catch { /* non-fatal */ }
    }
    const result = {
      ok: true,
      kind: "better.deploy",
      dryRun: true,
      framework,
      platform: platform || "auto",
      steps,
      env: values.env,
      projectRoot
    };
    if (values.json) { printJson(result); }
    else {
      const fw = framework ? ` (${framework})` : "";
      const pt = platform ? ` → ${platform}` : "";
      printText(`Deploy plan for ${projectRoot}${fw}${pt}:\n${steps.map(s => `  ${s.step}${s.platform ? ` → ${s.platform}` : ""}`).join("\n")}`);
    }
    return;
  }

  // Execute steps
  try {
    if (values.provision) {
      if (!values.json) printText("Provisioning OSP services from .env.osp...");
      const { findBetterCore } = await import("../lib/core.js");
      const corePath = await findBetterCore();
      if (corePath) {
        const provResult = spawnSync(
          corePath,
          ["deploy", "provision", "--project-root", projectRoot, "--env", values.env],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        if (provResult.stdout) {
          try {
            const parsed = JSON.parse(provResult.stdout.trim());
            if (!parsed.ok) throw new Error(parsed.reason ?? "provisioning failed");
            if (!values.json && parsed.services_provisioned?.length > 0) {
              printText(`  Provisioned: ${parsed.services_provisioned.map(s => s.service).join(", ")}`);
            }
          } catch (e) {
            if (!values.json) printText(`  [warn] provision result parse error: ${e.message}`);
          }
        }
      } else if (!values.json) {
        printText("  [warn] Rust binary not found — skipping OSP provisioning");
      }
    }

    if (!values.json) printText("Installing dependencies...");
    const { cmdInstall } = await import("./install.js");
    await cmdInstall(["--frozen", "--project-root", projectRoot]);

    // Run build script
    const fs = await import("node:fs/promises");
    const pkgPath = path.join(projectRoot, "package.json");
    let buildScript = null;
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      buildScript = pkg.scripts?.build;
    } catch { /* ignore */ }

    if (buildScript) {
      if (!values.json) printText("Building...");
      execFileSync("npm", ["run", "build"], { cwd: projectRoot, stdio: values.json ? "ignore" : "inherit" });
    }

    // Deploy
    const platform = values.platform || await detectPlatform(projectRoot);
    if (!values.json) printText(`Deploying to ${platform}...`);

    const deployResult = await runPlatformDeploy(platform, projectRoot, values.env);

    const result = { ok: true, kind: "better.deploy", platform, env: values.env, url: deployResult.url, projectRoot };
    if (values.json) { printJson(result); }
    else { printText(`Deployed successfully to ${platform}${deployResult.url ? `: ${deployResult.url}` : ""}`); }

  } catch (err) {
    const result = { ok: false, kind: "better.deploy", error: err.message };
    if (values.json) { printJson(result); }
    else { printText(`Deploy failed: ${err.message}`); }
    process.exitCode = 1;
  }
}

async function detectPlatform(projectRoot) {
  const fs = await import("node:fs/promises");
  if (await fs.access(path.join(projectRoot, "vercel.json")).then(() => true).catch(() => false)) return "vercel";
  if (await fs.access(path.join(projectRoot, "railway.json")).then(() => true).catch(() => false)) return "railway";
  if (await fs.access(path.join(projectRoot, "fly.toml")).then(() => true).catch(() => false)) return "fly";
  if (await fs.access(path.join(projectRoot, "netlify.toml")).then(() => true).catch(() => false)) return "netlify";
  return "generic";
}

async function runPlatformDeploy(platform, projectRoot, env) {
  const commands = {
    vercel: ["vercel", ["--prod", "--yes"]],
    railway: ["railway", ["up"]],
    fly: ["fly", ["deploy"]],
    netlify: ["netlify", ["deploy", "--prod"]],
    heroku: ["git", ["push", "heroku", "main"]],
    generic: ["npm", ["run", "deploy"]],
  };
  const [cmd, args] = commands[platform] || commands.generic;
  try {
    const result = spawnSync(cmd, args, { cwd: projectRoot, env: { ...process.env, NODE_ENV: env } });
    const url = result.stdout?.toString().match(/https?:\/\/[^\s]+/)?.[0];
    return { success: result.status === 0, url };
  } catch {
    return { success: false, url: null };
  }
}
