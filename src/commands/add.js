import { parseArgs } from "node:util";
import path from "node:path";
import { detectPackageManager } from "../pm/detect.js";
import { runCommand } from "../lib/spawn.js";
import { printJson } from "../lib/output.js";

const HELP = `\
better add <package[@version]> [package...] [options]

Add one or more packages to your project and install them.

Options:
  -D, --dev          Save as devDependency
  -P, --peer         Save as peerDependency (npm/pnpm/yarn only)
  -O, --optional     Save as optionalDependency
  --exact            Pin to exact version instead of ^ range
  --no-save          Install without updating the manifest
  --json             Machine-readable JSON output
  --help             Show this help
`;

export async function cmdAdd(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dev:      { type: "boolean", short: "D", default: false },
      peer:     { type: "boolean", short: "P", default: false },
      optional: { type: "boolean", short: "O", default: false },
      exact:    { type: "boolean", default: false },
      save:     { type: "boolean", default: true },
      json:     { type: "boolean", default: false },
      help:     { type: "boolean", default: false },
    },
  });

  if (values.help) { process.stdout.write(HELP); return; }
  if (positionals.length === 0) {
    process.stderr.write("error: specify at least one package to add\n");
    process.exitCode = 1;
    return;
  }

  const projectRoot = process.cwd();
  const { pm } = await detectPackageManager(projectRoot);

  const packages = positionals;
  const cmd = buildAddCommand(pm, packages, values);

  if (!values.json) {
    process.stdout.write(`Adding ${packages.join(", ")} via ${pm}...\n`);
  }

  const result = await runCommand(cmd.bin, cmd.args, {
    cwd: projectRoot,
    passthroughStdio: !values.json,
  });

  if (values.json) {
    printJson({
      ok: result.exitCode === 0,
      kind: "better.add",
      added: packages,
      pm,
      ...(result.exitCode !== 0 && { error: result.stderr.trim() || "package manager exited with error" }),
    });
    if (result.exitCode !== 0) process.exitCode = 1;
    return;
  }

  if (result.exitCode !== 0) {
    process.exitCode = 1;
  }
}

function buildAddCommand(pm, packages, values) {
  switch (pm) {
    case "pnpm": {
      const args = ["add", ...packages];
      if (values.dev)      args.push("--save-dev");
      if (values.peer)     args.push("--save-peer");
      if (values.optional) args.push("--save-optional");
      if (values.exact)    args.push("--save-exact");
      if (!values.save)    args.push("--no-save");
      return { bin: "pnpm", args };
    }
    case "yarn": {
      // Yarn Berry (v2+) uses `yarn add`
      const args = ["add", ...packages];
      if (values.dev)      args.push("--dev");
      if (values.peer)     args.push("--peer");
      if (values.optional) args.push("--optional");
      if (values.exact)    args.push("--exact");
      return { bin: "yarn", args };
    }
    default: {
      // npm
      const args = ["install", ...packages];
      if (values.dev)      args.push("--save-dev");
      if (values.peer)     args.push("--save-peer");
      if (values.optional) args.push("--save-optional");
      if (values.exact)    args.push("--save-exact");
      if (!values.save)    args.push("--no-save");
      return { bin: "npm", args };
    }
  }
}
