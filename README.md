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
better test                     # Alias: better run test
better lint                     # Alias: better run lint
better dev                      # Alias: better run dev
better build                    # Alias: better run build
better start                    # Alias: better run start
```

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
```

### Cache

```bash
better cache stats              # Cache size, package count, storage breakdown
better cache gc                 # Garbage collect old entries
better cache gc --max-age 30    # Remove entries older than N days
better cache gc --dry-run       # Preview what would be removed
```

### Developer Tools

```bash
better hooks install            # Install git hooks (pre-commit, pre-push)
better exec <script.ts>         # Run TypeScript/JavaScript (auto-detects tsx/ts-node/node)
better init                     # Initialize a new project (generates package.json)
better init --name my-app       # Initialize with a specific name
```

### Aliases

| Alias | Expands to |
|-------|-----------|
| `better i` | `better install` |
| `better t` | `better run test` |
| `better x` | `better exec` |
| `better dedup` | `better dedupe` |
| `better bench` | `better benchmark` |

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
                        license scan, audit, outdated, doctor, benchmark, ...)
    src/main.rs         CLI binary (18 commands + aliases)
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
