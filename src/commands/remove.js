import { parseArgs } from "node:util";
import { detectPackageManager } from "../pm/detect.js";
import { runCommand } from "../lib/spawn.js";
import { printJson } from "../lib/output.js";

const HELP = `\
better remove <package> [package...] [options]

Remove one or more packages from your project.

Options:
  --no-save    Uninstall without updating the manifest
  --json       Machine-readable JSON output
  --help       Show this help
`;

export async function cmdRemove(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      save: { type: "boolean", default: true },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) { process.stdout.write(HELP); return; }
  if (positionals.length === 0) {
    process.stderr.write("error: specify at least one package to remove\n");
    process.exitCode = 1;
    return;
  }

  const projectRoot = process.cwd();
  const { pm } = await detectPackageManager(projectRoot);

  const packages = positionals;
  const cmd = buildRemoveCommand(pm, packages, values);

  if (!values.json) {
    process.stdout.write(`Removing ${packages.join(", ")} via ${pm}...\n`);
  }

  const result = await runCommand(cmd.bin, cmd.args, {
    cwd: projectRoot,
    passthroughStdio: !values.json,
  });

  if (values.json) {
    printJson({
      ok: result.exitCode === 0,
      kind: "better.remove",
      removed: packages,
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

function buildRemoveCommand(pm, packages, values) {
  switch (pm) {
    case "pnpm":
      return { bin: "pnpm", args: ["remove", ...packages] };
    case "yarn":
      return { bin: "yarn", args: ["remove", ...packages] };
    default: {
      const args = ["uninstall", ...packages];
      if (!values.save) args.push("--no-save");
      return { bin: "npm", args };
    }
  }
}
