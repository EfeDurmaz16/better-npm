import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_POLICY = {
  defaultPolicy: "block",
  allowedPackages: [],
  blockedPackages: [],
  allowedScriptTypes: [],
  trustedScopes: []
};

const SCRIPT_TYPES = ["preinstall", "install", "postinstall", "prepare"];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizePolicy(policy) {
  if (!isObject(policy)) return { ...DEFAULT_POLICY };

  return {
    defaultPolicy: policy.defaultPolicy === "allow" ? "allow" : "block",
    allowedPackages: Array.isArray(policy.allowedPackages) ? policy.allowedPackages : [],
    blockedPackages: Array.isArray(policy.blockedPackages) ? policy.blockedPackages : [],
    allowedScriptTypes: Array.isArray(policy.allowedScriptTypes) ? policy.allowedScriptTypes : [],
    trustedScopes: Array.isArray(policy.trustedScopes) ? policy.trustedScopes : []
  };
}

export async function loadScriptPolicy(projectRoot) {
  const policyPath = path.join(projectRoot, ".better-scripts.json");

  if (await exists(policyPath)) {
    try {
      const raw = await fs.readFile(policyPath, "utf8");
      const parsed = JSON.parse(raw);
      return normalizePolicy(parsed);
    } catch {
      // Fall through to check package.json
    }
  }

  const pkgPath = path.join(projectRoot, "package.json");
  if (await exists(pkgPath)) {
    try {
      const raw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw);
      if (isObject(pkg?.betterScripts)) {
        return normalizePolicy(pkg.betterScripts);
      }
    } catch {
      // ignore package.json parse errors
    }
  }

  return { ...DEFAULT_POLICY };
}

export function isScriptAllowed(packageName, scriptType, policy) {
  if (!packageName || typeof packageName !== "string") return false;
  if (!policy || !isObject(policy)) return false;

  const normalized = normalizePolicy(policy);

  // Check if explicitly blocked
  if (normalized.blockedPackages.includes(packageName)) {
    return false;
  }

  // Check if in allowlist
  if (normalized.allowedPackages.includes(packageName)) {
    return true;
  }

  // Check if scope is trusted
  if (packageName.startsWith("@")) {
    const scopeEnd = packageName.indexOf("/");
    if (scopeEnd > 0) {
      const scope = packageName.slice(0, scopeEnd);
      if (normalized.trustedScopes.includes(scope)) {
        return true;
      }
    }
  }

  // Check if script type is allowed
  if (scriptType && normalized.allowedScriptTypes.includes(scriptType)) {
    return true;
  }

  // Default policy
  return normalized.defaultPolicy === "allow";
}

export async function saveScriptPolicy(projectRoot, policy) {
  const normalized = normalizePolicy(policy);
  const policyPath = path.join(projectRoot, ".better-scripts.json");
  await fs.writeFile(policyPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function detectScriptsInLockfile(lockfilePath) {
  // This is a placeholder for lockfile parsing
  // Real implementation would parse package-lock.json, yarn.lock, pnpm-lock.yaml
  // and detect packages that have install scripts
  return [];
}

export async function scanNodeModulesForScripts(nodeModulesPath) {
  const packagesWithScripts = [];

  if (!(await exists(nodeModulesPath))) {
    return packagesWithScripts;
  }

  const processDirectory = async (dirPath, packageName = null) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.name.startsWith("@")) {
        // Scoped package - need to go one level deeper
        await processDirectory(fullPath, entry.name);
        continue;
      }

      const pkgName = packageName ? `${packageName}/${entry.name}` : entry.name;
      const pkgJsonPath = path.join(fullPath, "package.json");

      if (!(await exists(pkgJsonPath))) continue;

      try {
        const raw = await fs.readFile(pkgJsonPath, "utf8");
        const pkg = JSON.parse(raw);

        if (!pkg.scripts || !isObject(pkg.scripts)) continue;

        const scripts = {};
        let hasInstallScripts = false;

        for (const scriptType of SCRIPT_TYPES) {
          if (pkg.scripts[scriptType]) {
            scripts[scriptType] = pkg.scripts[scriptType];
            hasInstallScripts = true;
          }
        }

        if (hasInstallScripts) {
          packagesWithScripts.push({
            name: pkgName,
            version: pkg.version ?? "unknown",
            scripts,
            path: fullPath
          });
        }
      } catch {
        // Ignore parse errors
      }
    }
  };

  await processDirectory(nodeModulesPath);
  return packagesWithScripts;
}
