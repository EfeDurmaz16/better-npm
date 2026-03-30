import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better link [package]` — symlink a local package for development
 * Equivalent to npm link but faster and with better error messages
 */
export async function cmdLink(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better link               Create a global symlink for current package
  better link <path>        Link a local package into current project
  better link --list        Show all linked packages
  better link --unlink PKG  Remove a linked package

Options:
  --json  Machine-readable output
  -h, --help  Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      list: { type: "boolean", default: false },
      unlink: { type: "string" },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const useJson = values.json || runtime.json === true;
  const linksDir = path.join(process.env.HOME || "/tmp", ".better", "links");

  if (values.list) {
    let links = [];
    try {
      const entries = await fs.readdir(linksDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isSymbolicLink()) {
          const target = await fs.readlink(path.join(linksDir, e.name));
          links.push({ name: e.name, target });
        }
      }
    } catch {}
    const result = { ok: true, kind: "better.link.list", links };
    if (useJson) { printJson(result); }
    else {
      if (links.length === 0) printText("No linked packages.");
      else printText(links.map(l => `  ${l.name} → ${l.target}`).join("\n"));
    }
    return;
  }

  if (values.unlink) {
    const linkPath = path.join(linksDir, values.unlink);
    try {
      await fs.unlink(linkPath);
      const result = { ok: true, unlinked: values.unlink };
      if (useJson) { printJson(result); }
      else { printText(`Unlinked: ${values.unlink}`); }
    } catch (err) {
      const result = { ok: false, error: err.message };
      if (useJson) { printJson(result); } else { printText(`Error: ${err.message}`); }
      process.exitCode = 1;
    }
    return;
  }

  const targetPath = positionals[0] ? path.resolve(positionals[0]) : projectRoot;

  // Read package name from target
  let pkgName;
  try {
    const pkgData = JSON.parse(await fs.readFile(path.join(targetPath, "package.json"), "utf8"));
    pkgName = pkgData.name;
  } catch {
    const err = { ok: false, error: "package.json not found at target path" };
    if (useJson) { printJson(err); } else { printText("Error: package.json not found"); }
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(linksDir, { recursive: true });
  const linkPath = path.join(linksDir, pkgName.replace("/", "__"));

  try {
    await fs.symlink(targetPath, linkPath);
    const result = { ok: true, kind: "better.link", name: pkgName, target: targetPath, linkPath };
    if (useJson) { printJson(result); }
    else { printText(`Linked ${pkgName} → ${targetPath}`); }
  } catch (err) {
    if (err.code === "EEXIST") {
      // Already linked — update
      await fs.unlink(linkPath);
      await fs.symlink(targetPath, linkPath);
      const result = { ok: true, kind: "better.link", name: pkgName, target: targetPath, updated: true };
      if (useJson) { printJson(result); } else { printText(`Updated link: ${pkgName} → ${targetPath}`); }
    } else {
      const result = { ok: false, error: err.message };
      if (useJson) { printJson(result); } else { printText(`Error: ${err.message}`); }
      process.exitCode = 1;
    }
  }
}
