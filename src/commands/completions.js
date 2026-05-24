import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { printText } from "../lib/output.js";
import { findBetterCore, tryLoadNapiAddon } from "../lib/core.js";
import { runCommand } from "../lib/spawn.js";

const ALL_COMMANDS = [
  "add", "ai", "alias", "analyze", "audit", "audit-html", "audit-fix",
  "badges", "benchmark", "bin-check", "build", "build-diff", "bump",
  "bundle-analyzer", "bundle-check",
  "cache", "changelog", "changelog-gen", "changelog-view",
  "check", "check-updates", "ci", "ci-check", "ci-config-gen",
  "circular", "circular-deps", "clean", "cleanup",
  "compare", "compat", "completions", "compliance",
  "config", "config-audit", "config-check", "context",
  "contributors", "contributors-check", "cost", "coverage-check",
  "credentials", "cross-project", "cve-check",
  "dashboard", "dedupe", "delta",
  "dep-age", "dep-changes", "dep-graph", "dep-graph-json",
  "dep-score", "dep-tree-size", "dep-why",
  "dependency-audit", "deploy", "deprecation-check", "deprecations",
  "deps-check", "deps-used", "dev", "dev-deps-check",
  "diff", "diff-deps", "discover", "doctor", "doctor-fix",
  "duplicate-files", "duplicates",
  "earnings", "engines-check",
  "env", "env-check", "env-diff", "env-doctor", "env-generate", "env-validate",
  "exec", "explain", "exports-check", "exports-map",
  "files-check", "find", "find-unused-exports", "fix", "fix-versions",
  "format", "format-package", "fund",
  "gen-types", "git-check", "global-packages", "graph",
  "heal", "health-dashboard", "health-score", "hooks", "hooks-audit",
  "impact", "import-check", "import-map", "infra", "init", "insights",
  "install", "install-check", "install-order", "install-time", "installed-check",
  "interactive",
  "license", "license-compat", "license-policy", "license-report", "licenses-report",
  "link", "link-check", "list-scripts", "lock", "lock-health", "lockfile-fix",
  "lockfile-lint", "lockfile-merge",
  "maintenance", "migrate", "migration-guide",
  "missing", "missing-peer-install", "module-check", "module-type",
  "mono-deps", "monorepo-info", "monorepo-version-sync",
  "namespace", "node-api-compat", "node-compat", "node-modules-doctor",
  "node-modules-info", "node-version", "notify",
  "npm-audit-fix-check", "npm-cache-info", "npm-check", "npm-ci-check",
  "npm-run-order", "npm-scripts-run", "npm-token",
  "optional-deps", "orchestrate", "outdated", "outdated-report", "overrides",
  "pack-size", "package-diff", "package-json-diff", "package-lock-audit",
  "package-size-breakdown", "package-size-map", "package-stats",
  "patch", "patch-package-check", "pay", "peer-check", "peer-conflicts", "peer-deps",
  "perf", "perf-budget", "phantom-deps", "pin", "pipeline",
  "pkg-alternatives", "pkg-compare-versions", "pkg-downloads", "pkg-info",
  "pkg-json-lint", "pkg-metadata", "pkg-provenance", "pkg-publish-info",
  "pkg-readme", "pkg-search", "pkg-size-history", "pkg-trust", "pkg-versions",
  "plugin", "policy", "postinstall-audit", "pr-bot", "predict", "prefetch",
  "preinstall-check", "preview", "provenance", "provider", "provision", "prune",
  "publish", "publish-check", "publish-checklist",
  "receipt", "registry", "registry-health", "registry-status", "release",
  "remove", "report", "repro", "reproducible", "reputation",
  "resolutions", "resolutions-check", "risk", "run",
  "sbom", "sbom-gen", "scan-secrets", "scope-check", "score",
  "script-env", "scripts", "scripts-check", "search", "security",
  "security-headers", "semver", "semver-check", "serve", "services",
  "shell", "shrinkwrap-check", "sign", "size", "size-limit-check",
  "snapshot", "source-map-check", "sponsor", "stale", "stats",
  "suggest", "summarize", "supply-chain", "supply-chain-audit",
  "tag-manager", "tarball-inspect", "telemetry", "test", "test-coverage",
  "test-runner", "top-deps", "trace", "tree", "tree-shaking-check",
  "types-check", "typescript-check", "typings-check",
  "uninstall", "unused", "unused-scripts", "update", "update-interactive",
  "update-readme", "upgrade", "verify", "version-bumper", "version-history",
  "watch", "which-pkg", "why", "why-not", "why-size",
  "workspace", "workspace-deps", "workspace-graph", "workspace-run",
  "rm", "up", "audit-fix"
].sort();

function generateBash(commands) {
  const cmdList = commands.join(" ");
  return `# better shell completion for bash
# Add to ~/.bashrc or source from ~/.bash_completion.d/better:
#   source <(better completions bash)
#   # or:
#   better completions bash --install

_better_completions() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  }

  local commands="${cmdList}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "\${commands}" -- "\${cur}") )
    return
  fi

  case "\${prev}" in
    install)
      COMPREPLY=( \$(compgen -W "--json --dry-run --frozen --offline --production --global-cache --project-root --pm --engine --cache-mode --cache-scripts --approved-only --lazy" -- "\${cur}") )
      ;;
    audit)
      COMPREPLY=( \$(compgen -W "--json --project-root --prod-only --smart --strict --min-score" -- "\${cur}") )
      ;;
    policy)
      COMPREPLY=( \$(compgen -W "check init approve revoke pending" -- "\${cur}") )
      ;;
    lock)
      COMPREPLY=( \$(compgen -W "generate verify setup-merge-driver merge metadata" -- "\${cur}") )
      ;;
    cache)
      COMPREPLY=( \$(compgen -W "stats clean evict list warm gc restore" -- "\${cur}") )
      ;;
    doctor)
      COMPREPLY=( \$(compgen -W "--json --project-root --fix --unused" -- "\${cur}") )
      ;;
    *)
      COMPREPLY=( \$(compgen -W "--help --json --project-root" -- "\${cur}") )
      ;;
  esac
}

complete -F _better_completions better better-npm
`;
}

function generateZsh(commands) {
  const cmdLines = commands.map(c => `    '${c}'`).join("\n");
  return `#compdef better better-npm
# better shell completion for zsh
# Add to ~/.zshrc:
#   source <(better completions zsh)
#   # or:
#   better completions zsh --install

_better() {
  local state

  _arguments \\
    '1: :->command' \\
    '*: :->args'

  case \${state} in
    command)
      local commands=(
${cmdLines}
      )
      _describe 'better command' commands
      ;;
    args)
      case \${words[2]} in
        install)
          _arguments \\
            '--json[Output JSON]' \\
            '--dry-run[Dry run only]' \\
            '--frozen[Frozen lockfile]' \\
            '--offline[Offline mode]' \\
            '--production[Production only]' \\
            '--global-cache[Use global node_modules cache]' \\
            '--approved-only[Enforce approval list]' \\
            '--lazy[Fetch to CAS without materialising node_modules]' \\
            '--pm[Package manager]:pm:(npm pnpm yarn)' \\
            '--engine[Install engine]:engine:(pm bun better)'
          ;;
        audit)
          _arguments \\
            '--json[Output JSON]' \\
            '--prod-only[Production packages only]' \\
            '--smart[Use smart scoring]' \\
            '--strict[Fail on any vulnerability]'
          ;;
        policy)
          _values 'subcommand' check init approve revoke pending
          ;;
        lock)
          _values 'subcommand' generate verify setup-merge-driver merge metadata
          ;;
        cache)
          _values 'subcommand' stats clean evict list warm gc restore
          ;;
        *)
          _arguments '--help[Show help]' '--json[Output JSON]'
          ;;
      esac
      ;;
  esac
}

_better
`;
}

function generateFish(commands) {
  const cmdCompletions = commands.map(c =>
    `complete -c better -n '__fish_use_subcommand' -f -a '${c}'`
  ).join("\n");
  return `# better shell completion for fish
# Add to ~/.config/fish/completions/better.fish:
#   better completions fish > ~/.config/fish/completions/better.fish
#   # or:
#   better completions fish --install

# Disable file completions for better
complete -c better -f

# Main commands
${cmdCompletions}

# install flags
complete -c better -n '__fish_seen_subcommand_from install' -l json -d 'Output JSON'
complete -c better -n '__fish_seen_subcommand_from install' -l dry-run -d 'Dry run only'
complete -c better -n '__fish_seen_subcommand_from install' -l frozen -d 'Frozen lockfile'
complete -c better -n '__fish_seen_subcommand_from install' -l offline -d 'Offline mode'
complete -c better -n '__fish_seen_subcommand_from install' -l production -d 'Production only'
complete -c better -n '__fish_seen_subcommand_from install' -l global-cache -d 'Use global node_modules cache'
complete -c better -n '__fish_seen_subcommand_from install' -l approved-only -d 'Enforce .better-approved.json allowlist'
complete -c better -n '__fish_seen_subcommand_from install' -l lazy -d 'Fetch to CAS without materialising node_modules'
complete -c better -n '__fish_seen_subcommand_from install' -l pm -d 'Package manager' -a 'npm pnpm yarn'
complete -c better -n '__fish_seen_subcommand_from install' -l engine -d 'Install engine' -a 'pm bun better'

# audit flags
complete -c better -n '__fish_seen_subcommand_from audit' -l json -d 'Output JSON'
complete -c better -n '__fish_seen_subcommand_from audit' -l prod-only -d 'Production packages only'
complete -c better -n '__fish_seen_subcommand_from audit' -l smart -d 'Use smart scoring'
complete -c better -n '__fish_seen_subcommand_from audit' -l strict -d 'Fail on any vulnerability'

# policy subcommands
complete -c better -n '__fish_seen_subcommand_from policy' -f -a 'check init approve revoke pending'

# lock subcommands
complete -c better -n '__fish_seen_subcommand_from lock' -f -a 'generate verify setup-merge-driver merge metadata'
`;
}

function generatePowershell(commands) {
  const cmdJson = JSON.stringify(commands);
  return `# better shell completion for PowerShell
# Add to $PROFILE:
#   Invoke-Expression (better completions powershell)
#   # or:
#   better completions powershell --install

Register-ArgumentCompleter -Native -CommandName @('better', 'better-npm') -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = ${cmdJson}
  $tokens = $commandAst.CommandElements
  if ($tokens.Count -le 2) {
    $commands | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    return
  }
  $sub = $tokens[1].Value
  $flags = switch ($sub) {
    'install' { @('--json','--dry-run','--frozen','--offline','--production','--global-cache','--approved-only','--lazy','--pm','--engine') }
    'audit'   { @('--json','--prod-only','--smart','--strict','--min-score') }
    'policy'  { @('check','init','approve','revoke','pending') }
    'lock'    { @('generate','verify','setup-merge-driver','merge','metadata') }
    'cache'   { @('stats','clean','evict','list','warm','gc','restore') }
    default   { @('--help','--json','--project-root') }
  }
  $flags | Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
}

async function installCompletion(shell, script, projectRoot) {
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  switch (shell) {
    case "bash": {
      const completionDir = path.join(home, ".bash_completion.d");
      await fs.mkdir(completionDir, { recursive: true });
      const dest = path.join(completionDir, "better");
      await fs.writeFile(dest, script);
      printText(`Bash completion installed to ${dest}\nAdd to ~/.bashrc:\n  source ~/.bash_completion.d/better`);
      break;
    }
    case "zsh": {
      const fpath = path.join(home, ".zsh", "completions");
      await fs.mkdir(fpath, { recursive: true });
      const dest = path.join(fpath, "_better");
      await fs.writeFile(dest, script);
      printText(`Zsh completion installed to ${dest}\nAdd to ~/.zshrc:\n  fpath=(~/.zsh/completions $fpath)\n  autoload -U compinit && compinit`);
      break;
    }
    case "fish": {
      const fishDir = path.join(home, ".config", "fish", "completions");
      await fs.mkdir(fishDir, { recursive: true });
      const dest = path.join(fishDir, "better.fish");
      await fs.writeFile(dest, script);
      printText(`Fish completion installed to ${dest}`);
      break;
    }
    default:
      printText(`Auto-install not supported for ${shell}. Pipe output to the appropriate file.`);
  }
}

export async function cmdCompletions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      install: { type: "boolean", default: false },
      "project-root": { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  const shell = (positionals[0] || process.env.SHELL?.split("/").pop() || "bash").toLowerCase();

  // Try delegating to better-core binary first (it may have richer completions)
  if (!values.install) {
    const corePath = await findBetterCore();
    if (corePath) {
      const res = await runCommand(corePath, ["completions", shell], {
        passthroughStdio: false, captureLimitBytes: 256 * 1024
      });
      if (res.exitCode === 0 && res.stdout.trim()) {
        process.stdout.write(res.stdout);
        return;
      }
    }
  }

  // JS-native fallback
  let script;
  switch (shell) {
    case "bash":   script = generateBash(ALL_COMMANDS); break;
    case "zsh":    script = generateZsh(ALL_COMMANDS); break;
    case "fish":   script = generateFish(ALL_COMMANDS); break;
    case "powershell": case "pwsh": script = generatePowershell(ALL_COMMANDS); break;
    default:
      printText(`Unknown shell '${shell}'. Supported: bash, zsh, fish, powershell`);
      process.exitCode = 1;
      return;
  }

  if (values.install) {
    await installCompletion(shell, script, values["project-root"] ? path.resolve(values["project-root"]) : process.cwd());
  } else {
    process.stdout.write(script);
  }
}
