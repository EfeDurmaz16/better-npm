/**
 * better import-map — generate ESM import maps
 *
 * Generates an importmap.json from installed node_modules,
 * mapping bare specifiers to CDN or local paths.
 *
 * Usage:
 *   better import-map                  # generate importmap.json
 *   better import-map --cdn esm.sh     # use esm.sh CDN
 *   better import-map --cdn jsdelivr   # use jsDelivr CDN
 *   better import-map --local          # use local node_modules paths
 *   better import-map --output importmap.json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const CDN_BASES = {
  "esm.sh": (name, version) => `https://esm.sh/${name}@${version}`,
  "jsdelivr": (name, version) => {
    const encoded = name.startsWith("@") ? `npm/${name}@${version}/+esm` : `npm/${name}@${version}/+esm`;
    return `https://cdn.jsdelivr.net/${encoded}`;
  },
  "skypack": (name, version) => `https://cdn.skypack.dev/${name}@${version}`,
  "unpkg": (name, version) => `https://unpkg.com/${name}@${version}?module`,
};

export async function cmdImportMap(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      cdn: { type: "string" },
      local: { type: "boolean", default: false },
      output: { type: "string" },
      "include-dev": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better import-map [options]

Generate an ESM import map from installed packages.

Options:
  --cdn <name>      CDN provider: esm.sh (default) | jsdelivr | skypack | unpkg
  --local           Use local node_modules paths instead of CDN
  --include-dev     Include devDependencies (default: prod only)
  --output <file>   Write to file (default: stdout)
  --json            Machine-readable output
  -h, --help        Show this help

Examples:
  better import-map                        # esm.sh CDN
  better import-map --cdn jsdelivr
  better import-map --local
  better import-map --output importmap.json

Usage in HTML:
  <script type="importmap">...</script>
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgJson;
  let lockData;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  try {
    lockData = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  } catch {}

  const deps = {
    ...pkgJson.dependencies,
    ...(values["include-dev"] ? pkgJson.devDependencies || {} : {}),
  };

  if (Object.keys(deps).length === 0) {
    const msg = "No dependencies found.";
    if (values.json) { printJson({ ok: true, kind: "better.import-map", imports: {} }); }
    else { printText(msg); }
    return;
  }

  // Get resolved versions from lockfile
  const resolvedVersions = {};
  if (lockData?.packages) {
    for (const [pkgPath, info] of Object.entries(lockData.packages)) {
      if (!pkgPath) continue;
      const name = pkgPath.startsWith("node_modules/") ? pkgPath.slice(13) : pkgPath;
      if (name && !name.includes("/node_modules/") && info.version) {
        resolvedVersions[name] = info.version;
      }
    }
  }

  const cdnName = values.cdn || "esm.sh";
  const cdnResolver = CDN_BASES[cdnName];

  if (!cdnResolver && !values.local) {
    const msg = `Unknown CDN: ${cdnName}. Use: ${Object.keys(CDN_BASES).join(", ")}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const imports = {};

  for (const [name] of Object.entries(deps)) {
    const version = resolvedVersions[name] || "latest";

    let url;
    if (values.local) {
      url = `./node_modules/${name}/`;
    } else {
      url = cdnResolver(name, version);
    }

    imports[name] = url;

    // Also add the subpath entry for scoped packages
    if (!name.startsWith("@")) {
      imports[`${name}/`] = values.local
        ? `./node_modules/${name}/`
        : `${url.replace(/\?.*$/, "")}/`;
    }
  }

  const importMap = { imports };

  if (values.json) {
    printJson({ ok: true, kind: "better.import-map", ...importMap, cdn: values.local ? "local" : cdnName });
    return;
  }

  const output = JSON.stringify(importMap, null, 2);

  if (values.output) {
    await fs.writeFile(values.output, output + "\n");
    printText(`Import map written to ${values.output} (${Object.keys(imports).length} entries)`);
  } else {
    process.stdout.write(output + "\n");
  }
}
