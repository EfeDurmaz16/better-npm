# better

A faster, smarter package manager for Node.js — built on a pure Rust core.

## Performance

Benchmarked on a real project with 15 dependencies (145 resolved packages):

| Tool | Warm Install | Cold Install |
|------|------------:|-------------:|
| **better** | **75ms** | ~400ms |
| bun | 198ms | ~500ms |
| npm | 1,749ms | ~8,000ms |

**2.6x faster than bun. 23x faster than npm.**

### How it works

- **Pure Rust binary** — zero Node.js startup overhead (saves ~265ms vs JS-based tools)
- **macOS clonefile()** — APFS copy-on-write for near-instant directory materialization
- **Parallel everything** — rayon-powered resolution, fetch, extract, and materialize
- **Content-addressable store** — SHA-512 package cache + SHA-256 file-level dedup
- **3-tier materialize** — clonefile -> CAS hardlinks -> copy fallback

### Cross-project dedup (`--dedup`)

Share `node_modules` files across projects via hardlinks from a global store:

```bash
better install --dedup
```

| Projects | Without dedup | With --dedup | Savings |
|----------|-------------:|-------------:|--------:|
| 2 | 28MB | ~16MB | 43% |
| 5 | 70MB | ~18MB | 74% |
| 10 | 140MB | ~20MB | 86% |

Files share the same inode across projects — editing one won't affect others (copy-on-write at the filesystem level).

**Trade-off:** `--dedup` takes ~515ms (vs ~75ms default) because it hardlinks individual files instead of cloning entire directories. Default mode opportunistically ingests to CAS so `--dedup` is ready when you need it.

## Install

Build the Rust core:

```bash
cd crates && cargo build --release -p better-core
```

### Rust binary (fastest)

```bash
./crates/target/release/better-core install --project-root /path/to/project
```

### Node.js CLI (full feature set)

```bash
node bin/better.js install
```

The JS CLI automatically detects and uses the Rust binary when available, falling back to the JS pipeline otherwise. Disable with `BETTER_NO_RUST_BINARY=1`.

## Commands

### Install & Analyze

```bash
better install                  # Install dependencies (auto-selects fastest strategy)
better install --dedup          # Install with cross-project file dedup
better install --no-scripts     # Skip lifecycle scripts
better analyze                  # Dependency attribution, duplicates, depth analysis
better scan                     # Low-level lockfile scan
```

### Script Runner

```bash
better run <script>             # Run package.json scripts (node_modules/.bin on PATH)
better run lint test build      # Run multiple scripts in parallel
better run dev --watch          # Run with file watching (auto-restart on changes)
better test                     # Alias: better run test
better lint                     # Alias: better run lint
better dev                      # Alias: better run dev (watch mode by default)
better build                    # Alias: better run build
better start                    # Alias: better run start
```

Scripts automatically load `.env` and `.env.local` files from the project root.

### Dependency Intelligence

```bash
better why <package>            # Trace why a package is installed (dependency paths)
better outdated                 # Check for newer versions on npm registry
better dedupe                   # Detect duplicate packages with dedup analysis
better license                  # Scan all package licenses
better license --allow MIT,ISC  # Allow only specific licenses
better license --deny GPL-3.0   # Deny specific licenses
better audit                    # Security vulnerability scan via OSV.dev
better audit --min-severity high # Filter by severity (critical/high/medium/low)
```

### Health & Diagnostics

```bash
better doctor                   # Health score (0-100) with actionable findings
better doctor --threshold 80    # Fail if score below threshold
better benchmark                # Comparative install timing across package managers
better benchmark --rounds 5     # Number of benchmark rounds
better benchmark --pm npm,bun   # Select package managers to compare
better env                      # Show Node.js version, platform, project info
better env check                # Validate engines constraints from package.json
```

### Cache

```bash
better cache stats              # Cache size, package count, storage breakdown
better cache gc                 # Garbage collect old entries
better cache gc --max-age 30    # Remove entries older than N days
better cache gc --dry-run       # Preview what would be removed
```

### Script Sandboxing

```bash
better scripts scan             # Scan node_modules for lifecycle scripts (install, postinstall, etc.)
better scripts list             # Alias for scan
better scripts allow <package>  # Add package to allowed list
better scripts block <package>  # Add package to blocked list
```

Policy is stored in `.better-scripts.json` (or `package.json#betterScripts`). Default policy allows all; configure trusted scopes, allowed/blocked packages, and permitted script types.

### Policy Engine

```bash
better policy check             # Run policy rules and score (0-100)
better policy init              # Generate default .betterrc.json with standard rules
```

Built-in rules: `no-deprecated`, `max-duplicates(3)`, `max-depth(15)`. Score: 100 - 15/error - 5/warning. Fails if score < threshold (default: 70).

### Lock Fingerprint

```bash
better lock generate            # SHA-256 hash lockfile + platform fingerprint → better.lock.json
better lock verify              # Verify lockfile hasn't changed (CI-friendly)
```

Cache key combines lockfile hash + platform/arch/node version. Use in CI to detect lockfile drift.

### Workspace Support

```bash
better workspace list           # List all workspace packages with inter-dependencies
better workspace graph          # Topological sort with parallelizable levels
better workspace changed --since HEAD~1  # Detect changed packages from git diff
better workspace run "npm test" # Run command in each package (respects dependency order)
```

Reads `package.json#workspaces` globs. Dependency graph uses Kahn's algorithm for topological sort with cycle detection.

### SBOM Export

```bash
better sbom                            # Export CycloneDX 1.5 JSON (default)
better sbom --format spdx              # Export SPDX 2.3 JSON
better sbom --lockfile pnpm-lock.yaml  # Use specific lockfile
```

Generates Software Bill of Materials with PURL identifiers (`pkg:npm/name@version`), license data, and integrity hashes. Enterprise-ready for supply chain compliance.

### .npmrc & Private Registry Support

Private registries and scoped authentication are automatically detected:

- Project `.npmrc` → `~/.npmrc` (search order)
- `@scope:registry=URL` for scoped packages
- `//host/:_authToken=TOKEN` for auth injection
- `NPM_CONFIG_REGISTRY` env var override

No extra flags needed — `better install` reads `.npmrc` automatically.

### Developer Tools

```bash
better hooks install            # Install git hooks (reads config from package.json#better.hooks)
better exec <script.ts>         # Run TS/JS (tsx > esbuild-runner > swc-node > ts-node > node)
better init                     # Initialize a new project (generates package.json)
better init --name my-app       # Initialize with a specific name
better init --template react    # Scaffold a React + Vite + TypeScript project
better init --template next     # Scaffold a Next.js + TypeScript project
better init --template express  # Scaffold an Express + TypeScript project
```

#### Git Hooks

Configure hooks in `package.json`:

```json
{
  "better": {
    "hooks": {
      "pre-commit": "better-core run lint",
      "pre-push": "better-core run test",
      "commit-msg": "conventional-commit"
    }
  }
}
```

Without config, defaults to: pre-commit (lint), pre-push (test), commit-msg (conventional commit validation).

### Aliases

| Alias | Expands to |
|-------|-----------|
| `better i` | `better install` |
| `better t` | `better run test` |
| `better x` | `better exec` |
| `better dedup` | `better dedupe` |
| `better bench` | `better benchmark` |
| `better ws` | `better workspace` |

All commands output structured JSON for easy piping and automation.

## Architecture

```
bin/better.js          CLI entry point (Node.js)
src/
  cli.js               Command router
  engine/better/       JS install engine (fallback)
  lib/core.js          Rust binary bridge
crates/
  better-core/         Pure Rust binary
    src/lib.rs          Core library (resolve, fetch, materialize, CAS, bin links,
                        license scan, audit, outdated, doctor, benchmark,
                        scripts policy, workspace, SBOM, lock fingerprint, ...)
    src/main.rs         CLI binary (25 commands + aliases, watch mode, templates)
  better-napi/         Node.js native addon (NAPI bridge)
apps/
  landing/             Next.js landing page
```

## Development

```bash
# Build Rust core
cd crates && cargo build --release -p better-core

# Run tests
node --test test/better-engine.test.js

# Lint & format
npm run lint
npm run format:check
```

## License

MIT
