import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import {
  loadScriptPolicy,
  saveScriptPolicy,
  isScriptAllowed,
  scanNodeModulesForScripts
} from "../lib/scriptPolicy.js";

export async function cmdScripts(argv) {
  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "scripts" });
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printText(`Usage:
  better scripts list [--json] [--project-root PATH]
  better scripts allow <package> [--project-root PATH]
  better scripts block <package> [--project-root PATH]
  better scripts scan [--json] [--project-root PATH]

Commands:
  list    Show current script policy configuration
  allow   Add a package to the allowlist
  block   Add a package to the blocklist or remove from allowlist
  scan    Scan node_modules for packages with install scripts

Options:
  --json            Output in JSON format
  --project-root    Project directory (defaults to current directory)
  -h, --help        Show this help message
`);
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  const projectRoot = values["project-root"] ? path.resolve(values["project-root"]) : process.cwd();
  commandLogger.info("scripts.subcommand", { subcommand: sub, projectRoot });

  if (sub === "list") {
    const policy = await loadScriptPolicy(projectRoot);
    const out = {
      ok: true,
      kind: "better.scripts.list",
      schemaVersion: 1,
      projectRoot,
      policy
    };

    if (values.json) {
      printJson(out);
    } else {
      printText(`Script Policy Configuration:
- Default policy: ${policy.defaultPolicy}
- Allowed packages: ${policy.allowedPackages.length > 0 ? policy.allowedPackages.join(", ") : "(none)"}
- Blocked packages: ${policy.blockedPackages.length > 0 ? policy.blockedPackages.join(", ") : "(none)"}
- Allowed script types: ${policy.allowedScriptTypes.length > 0 ? policy.allowedScriptTypes.join(", ") : "(none)"}
- Trusted scopes: ${policy.trustedScopes.length > 0 ? policy.trustedScopes.join(", ") : "(none)"}`);
    }
    return;
  }

  if (sub === "allow") {
    const packageName = positionals[0];
    if (!packageName) {
      throw new Error("better scripts allow requires a package name");
    }

    const policy = await loadScriptPolicy(projectRoot);

    // Remove from blocklist if present
    const blockedIndex = policy.blockedPackages.indexOf(packageName);
    if (blockedIndex >= 0) {
      policy.blockedPackages.splice(blockedIndex, 1);
    }

    // Add to allowlist if not already present
    if (!policy.allowedPackages.includes(packageName)) {
      policy.allowedPackages.push(packageName);
    }

    await saveScriptPolicy(projectRoot, policy);

    const out = {
      ok: true,
      kind: "better.scripts.allow",
      schemaVersion: 1,
      projectRoot,
      package: packageName,
      policy
    };

    if (values.json) {
      printJson(out);
    } else {
      printText(`Added '${packageName}' to script allowlist`);
    }
    return;
  }

  if (sub === "block") {
    const packageName = positionals[0];
    if (!packageName) {
      throw new Error("better scripts block requires a package name");
    }

    const policy = await loadScriptPolicy(projectRoot);

    // Remove from allowlist if present
    const allowedIndex = policy.allowedPackages.indexOf(packageName);
    if (allowedIndex >= 0) {
      policy.allowedPackages.splice(allowedIndex, 1);
    }

    // Add to blocklist if not already present
    if (!policy.blockedPackages.includes(packageName)) {
      policy.blockedPackages.push(packageName);
    }

    await saveScriptPolicy(projectRoot, policy);

    const out = {
      ok: true,
      kind: "better.scripts.block",
      schemaVersion: 1,
      projectRoot,
      package: packageName,
      policy
    };

    if (values.json) {
      printJson(out);
    } else {
      printText(`Added '${packageName}' to script blocklist`);
    }
    return;
  }

  if (sub === "scan") {
    const nodeModulesPath = path.join(projectRoot, "node_modules");
    const packagesWithScripts = await scanNodeModulesForScripts(nodeModulesPath);
    const policy = await loadScriptPolicy(projectRoot);

    const packages = packagesWithScripts.map((pkg) => {
      const scriptTypes = Object.keys(pkg.scripts);
      let allowed = false;
      let reason = "blocked by default policy";

      for (const scriptType of scriptTypes) {
        if (isScriptAllowed(pkg.name, scriptType, policy)) {
          allowed = true;
          if (policy.allowedPackages.includes(pkg.name)) {
            reason = "in allowlist";
          } else if (pkg.name.startsWith("@")) {
            const scopeEnd = pkg.name.indexOf("/");
            const scope = pkg.name.slice(0, scopeEnd);
            if (policy.trustedScopes.includes(scope)) {
              reason = "trusted scope";
            }
          } else if (policy.allowedScriptTypes.includes(scriptType)) {
            reason = `script type '${scriptType}' allowed`;
          } else if (policy.defaultPolicy === "allow") {
            reason = "default policy allows";
          }
          break;
        }
      }

      if (!allowed && policy.blockedPackages.includes(pkg.name)) {
        reason = "in blocklist";
      }

      return {
        name: pkg.name,
        version: pkg.version,
        scripts: pkg.scripts,
        policy: allowed ? "allowed" : "blocked",
        reason
      };
    });

    const summary = {
      totalWithScripts: packages.length,
      allowed: packages.filter(p => p.policy === "allowed").length,
      blocked: packages.filter(p => p.policy === "blocked").length
    };

    const out = {
      ok: true,
      kind: "better.scripts.scan",
      schemaVersion: 1,
      projectRoot,
      packages,
      summary
    };

    if (values.json) {
      printJson(out);
    } else {
      printText(`Install Script Scan Results:
- Total packages with install scripts: ${summary.totalWithScripts}
- Allowed: ${summary.allowed}
- Blocked: ${summary.blocked}

Packages with install scripts:`);

      if (packages.length === 0) {
        printText("  (none found)");
      } else {
        for (const pkg of packages) {
          const status = pkg.policy === "allowed" ? "✓" : "✗";
          const scriptList = Object.keys(pkg.scripts).join(", ");
          printText(`  ${status} ${pkg.name}@${pkg.version} [${scriptList}] - ${pkg.reason}`);
        }
      }
    }
    return;
  }

  throw new Error(`Unknown scripts subcommand '${sub}'`);
}
